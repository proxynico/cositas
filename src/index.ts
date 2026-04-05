#!/usr/bin/env bun
// cositas — Things 3 MCP server
// All interaction via JXA (osascript). Never foregrounds Things 3.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TOKEN = process.env.THINGS_AUTH_TOKEN ?? "";

// ---------------------------------------------------------------------------
// JXA engine — all Things 3 interaction goes through osascript
// ---------------------------------------------------------------------------

// Runs a JXA script against Things 3.
// Available in scope: P (parsed args), app (Things 3),
// todoOf(t), projectOf(p) — item serializers.
// The script body must `return` a JSON string.
async function jxa(
  body: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const { stdout } = await exec("osascript", [
    "-l",
    "JavaScript",
    "-e",
    `function run(argv) {
var P = JSON.parse(argv[0]);
var app = Application("Things3");
var todoOf = function(t) {
  var proj = null, area = null;
  try { proj = t.project().name(); } catch(e) {}
  try { area = t.area().name(); } catch(e) {}
  return {id:t.id(), name:t.name(), status:t.status(), notes:t.notes(),
    tags:t.tagNames(), dueDate:t.dueDate()?t.dueDate().toISOString():null,
    activationDate:t.activationDate()?t.activationDate().toISOString():null,
    project:proj, area:area};
};
var projectOf = function(pr) {
  var area = null;
  try { area = pr.area().name(); } catch(e) {}
  return {id:pr.id(), name:pr.name(), status:pr.status(), notes:pr.notes(),
    tags:pr.tagNames(), dueDate:pr.dueDate()?pr.dueDate().toISOString():null,
    area:area, todoCount:pr.toDos().length};
};
${body}
}`,
    JSON.stringify(args),
  ]);
  return stdout.trim();
}

// Opens a things:// URL without activating Things 3.
// Used only for features JXA can't handle (when=someday, checklist items).
async function quietUrl(
  path: string,
  params: Record<string, string | undefined>,
): Promise<void> {
  const qs = Object.entries(params)
    .filter((p): p is [string, string] => p[1] != null)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
  const url = `things:///${path}${qs ? "?" + qs : ""}`;
  await exec("osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import("AppKit");
var u = $.NSURL.URLWithString(${JSON.stringify(url)});
var c = $.NSWorkspaceOpenConfiguration.configuration;
c.activates = false;
$.NSWorkspace.sharedWorkspace.openURLConfigurationCompletionHandler(u, c, null);
delay(0.5);`,
  ]);
}

const ok = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (s: string) => ({
  content: [{ type: "text" as const, text: s }],
  isError: true as const,
});
const errmsg = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const stderr = (e as any).stderr?.trim();
  if (stderr)
    return stderr
      .replace(/^execution error: /, "")
      .replace(/ \(-?\d+\)$/, "");
  return e.message;
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "cositas", version: "0.2.1" });

const LIST_NAMES: Record<string, string> = {
  inbox: "Inbox",
  today: "Today",
  anytime: "Anytime",
  upcoming: "Upcoming",
  someday: "Someday",
  logbook: "Logbook",
};

// --- read ------------------------------------------------------------------

server.tool(
  "read",
  "Read from Things 3. Returns JSON with full item details including IDs.",
  {
    list: z
      .enum([
        "inbox",
        "today",
        "anytime",
        "upcoming",
        "someday",
        "logbook",
        "projects",
        "areas",
        "tags",
      ])
      .optional()
      .describe("Built-in list, or 'projects'/'areas'/'tags' to list all"),
    project: z
      .string()
      .optional()
      .describe("Project name — returns its todos"),
    area: z
      .string()
      .optional()
      .describe("Area name — returns its projects"),
    id: z
      .string()
      .optional()
      .describe("Todo or project ID — returns full detail with checklist/child todos"),
  },
  async ({ list, project, area, id }) => {
    if (!list && !project && !area && !id)
      return fail("Provide list, project, area, or id");
    try {
      if (list === "projects")
        return ok(
          await jxa(
            `return JSON.stringify(app.projects().filter(function(p){
  return p.status()==="open";
}).map(projectOf));`,
          ),
        );
      if (list === "areas")
        return ok(
          await jxa(
            `return JSON.stringify(app.areas().map(function(a){
  return {id:a.id(), name:a.name()};
}));`,
          ),
        );
      if (list === "tags")
        return ok(
          await jxa(
            `return JSON.stringify(app.tags().map(function(t){
  return {id:t.id(), name:t.name()};
}));`,
          ),
        );
      if (id)
        return ok(
          await jxa(
            `try {
  var t = app.toDos.byId(P.id); t.id();
  var r = todoOf(t);
  try {
    r.checklistItems = t.toDoChecklistItems().map(function(c) {
      return {name: c.name(), done: c.status() === "completed"};
    });
  } catch(e) {}
  return JSON.stringify(r);
} catch(e) {
  var p = app.projects.byId(P.id); p.id();
  var r = projectOf(p);
  r.todos = p.toDos().map(todoOf);
  return JSON.stringify(r);
}`,
            { id },
          ),
        );
      if (project)
        return ok(
          await jxa(
            `return JSON.stringify(app.projects.byName(P.n).toDos().map(todoOf));`,
            { n: project },
          ),
        );
      if (area)
        return ok(
          await jxa(
            `var target = P.n;
var projs = app.projects().filter(function(p) {
  if (p.status() !== "open") return false;
  try {
    var name = p.area().name();
    return name === target || name.indexOf(target) !== -1;
  } catch(e) { return false; }
});
return JSON.stringify(projs.map(projectOf));`,
            { n: area },
          ),
        );
      return ok(
        await jxa(
          `return JSON.stringify(app.lists.byName(P.n).toDos().map(todoOf));`,
          { n: LIST_NAMES[list!] },
        ),
      );
    } catch (e) {
      return fail(errmsg(e));
    }
  },
);

// --- search ----------------------------------------------------------------

server.tool(
  "search",
  "Search Things 3 open todos by name or tag. Returns JSON.",
  {
    query: z.string().optional().describe("Text to search in todo names"),
    tag: z.string().optional().describe("Tag name to filter by"),
  },
  async ({ query, tag }) => {
    if (!query && !tag) return fail("Provide query or tag");
    try {
      return ok(
        await jxa(
          `var f = {};
if (P.q) f.name = {_contains: P.q};
if (P.t) f.tagNames = {_contains: P.t};
var results = app.toDos.whose(f)();
results = results.filter(function(t) { return t.status() === "open"; });
return JSON.stringify(results.map(todoOf));`,
          { q: query ?? null, t: tag ?? null },
        ),
      );
    } catch (e) {
      return fail(errmsg(e));
    }
  },
);

// --- add_todo --------------------------------------------------------------

server.tool(
  "add_todo",
  "Create a todo in Things 3. Returns the created item with its ID.",
  {
    title: z.string(),
    notes: z.string().optional(),
    when: z
      .string()
      .optional()
      .describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd"),
    deadline: z.string().optional().describe("yyyy-mm-dd"),
    tags: z.array(z.string()).optional(),
    list: z.string().optional().describe("Project name to add the todo to"),
    checklist_items: z.array(z.string()).optional(),
  },
  async (params) => {
    try {
      const result = await jxa(
        `var props = {name: P.title};
if (P.notes) props.notes = P.notes;
if (P.tags && P.tags.length) props.tagNames = P.tags.join(", ");
if (P.deadline) props.dueDate = new Date(P.deadline + "T12:00:00");
var todo = app.make({new: "toDo", withProperties: props});
if (P.list) try { todo.project = app.projects.byName(P.list); } catch(e) {}
if (P.when) {
  var w = P.when;
  if (w === "today") app.schedule(todo, {"for": new Date()});
  else if (w === "tomorrow") {
    var d = new Date(); d.setDate(d.getDate() + 1);
    app.schedule(todo, {"for": d});
  } else if (w !== "anytime" && w !== "someday" && w !== "evening") {
    app.schedule(todo, {"for": new Date(w + "T12:00:00")});
  }
}
return JSON.stringify({id: todo.id(), name: todo.name(), status: todo.status()});`,
        params,
      );

      // Post-create patches for features JXA can't handle natively
      const created = JSON.parse(result);
      const patches: Record<string, string | undefined> = {};
      if (
        params.when &&
        ["someday", "anytime", "evening"].includes(params.when)
      )
        patches.when = params.when;
      if (params.checklist_items?.length)
        patches["append-checklist-items"] = params.checklist_items.join("\n");
      if (Object.keys(patches).length)
        await quietUrl("update", {
          "auth-token": TOKEN,
          id: created.id,
          ...patches,
        });

      return ok(result);
    } catch (e) {
      return fail(errmsg(e));
    }
  },
);

// --- add_project -----------------------------------------------------------

server.tool(
  "add_project",
  "Create a project in Things 3 with optional child todos. Returns the created project with ID.",
  {
    title: z.string(),
    notes: z.string().optional(),
    when: z
      .string()
      .optional()
      .describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd"),
    deadline: z.string().optional().describe("yyyy-mm-dd"),
    tags: z.array(z.string()).optional(),
    area: z.string().optional().describe("Area name"),
    todos: z.array(z.string()).optional().describe("Child todo titles"),
  },
  async (params) => {
    try {
      const result = await jxa(
        `var props = {name: P.title};
if (P.notes) props.notes = P.notes;
if (P.tags && P.tags.length) props.tagNames = P.tags.join(", ");
if (P.deadline) props.dueDate = new Date(P.deadline + "T12:00:00");
var proj = app.make({new: "project", withProperties: props});
if (P.area) try { proj.area = app.areas.byName(P.area); } catch(e) {}
if (P.todos && P.todos.length) {
  for (var i = 0; i < P.todos.length; i++) {
    var t = app.make({new: "toDo", withProperties: {name: P.todos[i]}});
    t.project = proj;
  }
}
if (P.when) {
  var w = P.when;
  if (w === "today") app.schedule(proj, {"for": new Date()});
  else if (w === "tomorrow") {
    var d = new Date(); d.setDate(d.getDate() + 1);
    app.schedule(proj, {"for": d});
  } else if (w !== "anytime" && w !== "someday" && w !== "evening") {
    app.schedule(proj, {"for": new Date(w + "T12:00:00")});
  }
}
return JSON.stringify({id: proj.id(), name: proj.name(), status: proj.status()});`,
        params,
      );

      const created = JSON.parse(result);
      if (
        params.when &&
        ["someday", "anytime", "evening"].includes(params.when)
      )
        await quietUrl("update-project", {
          "auth-token": TOKEN,
          id: created.id,
          when: params.when,
        });

      return ok(result);
    } catch (e) {
      return fail(errmsg(e));
    }
  },
);

// --- update ----------------------------------------------------------------

server.tool(
  "update",
  "Update a todo or project in Things 3 by ID. Detects item type automatically.",
  {
    id: z.string().describe("Todo or project ID"),
    title: z.string().optional(),
    notes: z.string().optional().describe("Replace notes (use empty string to clear)"),
    when: z
      .string()
      .optional()
      .describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd"),
    deadline: z.string().optional().describe("yyyy-mm-dd (empty string to clear)"),
    tags: z.array(z.string()).optional().describe("Replace all tags"),
    completed: z.boolean().optional(),
    canceled: z.boolean().optional(),
    list: z
      .string()
      .optional()
      .describe("Move to project (todos) or area (projects) by name"),
  },
  async (params) => {
    try {
      const result = await jxa(
        `var item, type;
try { item = app.toDos.byId(P.id); item.id(); type = "todo"; }
catch(e) { item = app.projects.byId(P.id); item.id(); type = "project"; }
if (P.hasOwnProperty("title") && P.title) item.name = P.title;
if (P.hasOwnProperty("notes")) item.notes = P.notes || "";
if (P.hasOwnProperty("tags")) item.tagNames = P.tags ? P.tags.join(", ") : "";
if (P.hasOwnProperty("deadline")) item.dueDate = P.deadline ? new Date(P.deadline + "T12:00:00") : null;
if (P.list) {
  if (type === "todo") try { item.project = app.projects.byName(P.list); } catch(e) {}
  else try { item.area = app.areas.byName(P.list); } catch(e) {}
}
if (P.when) {
  var w = P.when;
  if (w === "today") app.schedule(item, {"for": new Date()});
  else if (w === "tomorrow") {
    var d = new Date(); d.setDate(d.getDate() + 1);
    app.schedule(item, {"for": d});
  } else if (w !== "anytime" && w !== "someday" && w !== "evening") {
    app.schedule(item, {"for": new Date(w + "T12:00:00")});
  }
}
if (P.canceled) item.status = "canceled";
else if (P.completed) item.status = "completed";
else if (P.completed === false || P.canceled === false) item.status = "open";
return JSON.stringify(type === "todo" ? todoOf(item) : projectOf(item));`,
        params,
      );

      // Special when values via silent URL scheme
      if (
        params.when &&
        ["someday", "anytime", "evening"].includes(params.when)
      )
        await quietUrl("update", {
          "auth-token": TOKEN,
          id: params.id,
          when: params.when,
        });

      return ok(result);
    } catch (e) {
      return fail(errmsg(e));
    }
  },
);

// --- show ------------------------------------------------------------------

server.tool(
  "show",
  "Navigate Things 3 to a list, project, area, or item. Uses background URL dispatch.",
  {
    id: z
      .string()
      .optional()
      .describe(
        "Built-in list (inbox, today, anytime, upcoming, someday, logbook) or item ID",
      ),
    query: z
      .string()
      .optional()
      .describe("Project, area, or tag name to navigate to"),
  },
  async ({ id, query }) => {
    if (!id && !query) return fail("Provide id or query");
    try {
      await quietUrl("show", {
        id: id ?? undefined,
        query: query ?? undefined,
      });
      return ok(`Showing: ${id ?? query}`);
    } catch (e) {
      return fail(errmsg(e));
    }
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
