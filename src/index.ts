#!/usr/bin/env bun
// cositas — Things 3 MCP server
// All interaction via JXA (osascript). Never foregrounds Things 3.

import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const BUILTIN_WHEN = ["today", "tomorrow", "evening", "anytime", "someday"] as const;
const SPECIAL_WHEN = new Set<string>(["evening", "anytime", "someday"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const THINGS_APP_PATH = process.env.THINGS_APP_PATH ?? "/Applications/Things3.app";

const whenSchema = z
  .string()
  .refine((value) => BUILTIN_WHEN.includes(value as (typeof BUILTIN_WHEN)[number]) || ISO_DATE.test(value), {
    message: "Use today, tomorrow, evening, anytime, someday, or yyyy-mm-dd",
  });

const deadlineSchema = z
  .string()
  .regex(ISO_DATE, "Use yyyy-mm-dd");

const updateDeadlineSchema = z
  .string()
  .refine((value) => value === "" || ISO_DATE.test(value), {
    message: "Use yyyy-mm-dd or empty string",
  });

export type ExecResult = {
  stdout: string;
  stderr?: string;
};

export type ExecFn = (file: string, args: string[]) => Promise<ExecResult>;

export type ThingsRuntime = {
  jxa(body: string, args?: Record<string, unknown>): Promise<string>;
  quietUrl(path: string, params: Record<string, string | undefined>): Promise<void>;
  token: string;
};

const SANDBOX_FAILURE_MARKERS = [
  "com.apple.hiservices-xpcservice",
  "Connection Invalid",
  "Connection invalid",
  "Sandbox restriction",
];

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true as const,
});

export const LIST_NAMES: Record<string, string> = {
  inbox: "Inbox",
  today: "Today",
  anytime: "Anytime",
  upcoming: "Upcoming",
  someday: "Someday",
  logbook: "Logbook",
};

export const errmsg = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as Error & { stderr?: string }).stderr?.trim();
  if (stderr) {
    return stderr
      .replace(/^execution error: /, "")
      .replace(/ \(-?\d+\)$/, "");
  }
  return error.message;
};

export const isSandboxAutomationError = (error: unknown): boolean => {
  const message = errmsg(error);
  return SANDBOX_FAILURE_MARKERS.some((marker) => message.includes(marker));
};

export function createRuntime({
  execFn = exec,
  token = process.env.THINGS_AUTH_TOKEN ?? "",
}: {
  execFn?: ExecFn;
  token?: string;
} = {}): ThingsRuntime {
  return {
    token,
    async jxa(body, args = {}) {
      const { stdout } = await execFn("osascript", [
        "-l",
        "JavaScript",
        "-e",
        `function run(argv) {
var P = JSON.parse(argv[0]);
var app = Application(${JSON.stringify(THINGS_APP_PATH)});
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
    },

    async quietUrl(path, params) {
      const qs = Object.entries(params)
        .filter((entry): entry is [string, string] => entry[1] != null)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");
      const url = `things:///${path}${qs ? "?" + qs : ""}`;
      await execFn("osascript", [
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
    },
  };
}

function usesSpecialWhen(value: string | undefined): value is string {
  return value != null && SPECIAL_WHEN.has(value);
}

function requireToken(token: string): void {
  if (!token) {
    throw new Error("THINGS_AUTH_TOKEN is required for this operation");
  }
}

async function readItemJson(runtime: ThingsRuntime, id: string): Promise<string> {
  return runtime.jxa(
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
  );
}

async function applyQuietWhen(runtime: ThingsRuntime, kind: "todo" | "project", id: string, when: string): Promise<void> {
  requireToken(runtime.token);
  await runtime.quietUrl(kind === "project" ? "update-project" : "update", {
    "auth-token": runtime.token,
    id,
    when,
  });
}

export async function verifyThingsAccess(runtime: ThingsRuntime): Promise<void> {
  try {
    await runtime.jxa(
      `return JSON.stringify(app.lists().map(function(list) {
  return list.name();
}));`,
    );
  } catch (error) {
    if (isSandboxAutomationError(error)) {
      throw new Error(
        "Things 3 automation is blocked by the current sandbox. Run cositas outside the Codex sandbox or another restricted osascript environment.",
      );
    }
    throw new Error(`Things 3 startup check failed: ${errmsg(error)}`);
  }
}

export function registerTools(server: McpServer, runtime: ThingsRuntime): Record<string, RegisteredTool> {
  const tools: Record<string, RegisteredTool> = {};

  tools.read = server.tool(
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
      const selectors = [list, project, area, id].filter((value) => value != null);
      if (selectors.length !== 1) {
        return fail("Provide exactly one of list, project, area, or id");
      }

      try {
        if (list === "projects") {
          return ok(
            await runtime.jxa(
              `return JSON.stringify(app.projects().filter(function(p){
  return p.status()==="open";
}).map(projectOf));`,
            ),
          );
        }

        if (list === "areas") {
          return ok(
            await runtime.jxa(
              `return JSON.stringify(app.areas().map(function(a){
  return {id:a.id(), name:a.name()};
}));`,
            ),
          );
        }

        if (list === "tags") {
          return ok(
            await runtime.jxa(
              `return JSON.stringify(app.tags().map(function(t){
  return {id:t.id(), name:t.name()};
}));`,
            ),
          );
        }

        if (id) {
          return ok(await readItemJson(runtime, id));
        }

        if (project) {
          return ok(
            await runtime.jxa(
              `var p = app.projects.byName(P.n); p.id();
return JSON.stringify(p.toDos().map(todoOf));`,
              { n: project },
            ),
          );
        }

        if (area) {
          return ok(
            await runtime.jxa(
              `var target = P.n;
var projs = app.projects().filter(function(p) {
  if (p.status() !== "open") return false;
  try { return p.area().name() === target; }
  catch(e) { return false; }
});
return JSON.stringify(projs.map(projectOf));`,
              { n: area },
            ),
          );
        }

        return ok(
          await runtime.jxa(
            `return JSON.stringify(app.lists.byName(P.n).toDos().map(todoOf));`,
            { n: LIST_NAMES[list!] },
          ),
        );
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.search = server.tool(
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
          await runtime.jxa(
            `var f = {};
if (P.q) f.name = {_contains: P.q};
if (P.t) f.tagNames = {_contains: P.t};
var results = app.toDos.whose(f)();
results = results.filter(function(t) { return t.status() === "open"; });
return JSON.stringify(results.map(todoOf));`,
            { q: query ?? null, t: tag ?? null },
          ),
        );
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.add_todo = server.tool(
    "add_todo",
    "Create a todo in Things 3. Returns the created item with its ID.",
    {
      title: z.string(),
      notes: z.string().optional(),
      when: whenSchema
        .optional()
        .describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd"),
      deadline: deadlineSchema.optional().describe("yyyy-mm-dd"),
      tags: z.array(z.string()).optional(),
      list: z.string().optional().describe("Project name to add the todo to"),
      checklist_items: z.array(z.string()).optional(),
    },
    async (params) => {
      try {
        if (usesSpecialWhen(params.when) || params.checklist_items?.length) {
          requireToken(runtime.token);
        }

        const result = await runtime.jxa(
          `var props = {name: P.title};
if (P.notes) props.notes = P.notes;
if (P.tags && P.tags.length) props.tagNames = P.tags.join(", ");
if (P.deadline) props.dueDate = new Date(P.deadline + "T12:00:00");
var todo = app.make({new: "toDo", withProperties: props});
if (P.list) {
  var project = app.projects.byName(P.list);
  project.id();
  todo.project = project;
}
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

        const created = JSON.parse(result) as { id: string };
        const patches: Record<string, string | undefined> = {};
        if (usesSpecialWhen(params.when)) {
          patches.when = params.when;
        }
        if (params.checklist_items?.length) {
          patches["append-checklist-items"] = params.checklist_items.join("\n");
        }
        if (Object.keys(patches).length) {
          await runtime.quietUrl("update", {
            "auth-token": runtime.token,
            id: created.id,
            ...patches,
          });
          return ok(await readItemJson(runtime, created.id));
        }

        return ok(result);
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.add_project = server.tool(
    "add_project",
    "Create a project in Things 3 with optional child todos. Returns the created project with ID.",
    {
      title: z.string(),
      notes: z.string().optional(),
      when: whenSchema
        .optional()
        .describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd"),
      deadline: deadlineSchema.optional().describe("yyyy-mm-dd"),
      tags: z.array(z.string()).optional(),
      area: z.string().optional().describe("Area name"),
      todos: z.array(z.string()).optional().describe("Child todo titles"),
    },
    async (params) => {
      try {
        if (usesSpecialWhen(params.when)) {
          requireToken(runtime.token);
        }

        const result = await runtime.jxa(
          `var props = {name: P.title};
if (P.notes) props.notes = P.notes;
if (P.tags && P.tags.length) props.tagNames = P.tags.join(", ");
if (P.deadline) props.dueDate = new Date(P.deadline + "T12:00:00");
var proj = app.make({new: "project", withProperties: props});
if (P.area) {
  var area = app.areas.byName(P.area);
  area.id();
  proj.area = area;
}
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

        const created = JSON.parse(result) as { id: string };
        if (usesSpecialWhen(params.when)) {
          await applyQuietWhen(runtime, "project", created.id, params.when);
          return ok(await readItemJson(runtime, created.id));
        }

        return ok(result);
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.update = server.tool(
    "update",
    "Update a todo or project in Things 3 by ID. Detects item type automatically.",
    {
      id: z.string().describe("Todo or project ID"),
      title: z.string().optional(),
      notes: z.string().optional().describe("Replace notes (use empty string to clear)"),
      when: whenSchema
        .optional()
        .describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd"),
      deadline: updateDeadlineSchema.optional().describe("yyyy-mm-dd (empty string to clear)"),
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
        if (usesSpecialWhen(params.when)) {
          requireToken(runtime.token);
        }

        const result = await runtime.jxa(
          `var item, type;
try { item = app.toDos.byId(P.id); item.id(); type = "todo"; }
catch(e) { item = app.projects.byId(P.id); item.id(); type = "project"; }
if (P.hasOwnProperty("title") && P.title) item.name = P.title;
if (P.hasOwnProperty("notes")) item.notes = P.notes || "";
if (P.hasOwnProperty("tags")) item.tagNames = P.tags ? P.tags.join(", ") : "";
if (P.hasOwnProperty("deadline")) item.dueDate = P.deadline ? new Date(P.deadline + "T12:00:00") : null;
if (P.list) {
  if (type === "todo") {
    var project = app.projects.byName(P.list);
    project.id();
    item.project = project;
  } else {
    var area = app.areas.byName(P.list);
    area.id();
    item.area = area;
  }
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
return JSON.stringify({kind: type, item: type === "todo" ? todoOf(item) : projectOf(item)});`,
          params,
        );

        const parsed = JSON.parse(result) as {
          kind: "todo" | "project";
          item: unknown;
        };

        if (usesSpecialWhen(params.when)) {
          await applyQuietWhen(runtime, parsed.kind, params.id, params.when);
          return ok(await readItemJson(runtime, params.id));
        }

        return ok(JSON.stringify(parsed.item));
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.show = server.tool(
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
        await runtime.quietUrl("show", {
          id: id ?? undefined,
          query: query ?? undefined,
        });
        return ok(`Showing: ${id ?? query}`);
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  return tools;
}

export function createServer(runtime = createRuntime()): {
  server: McpServer;
  tools: Record<string, RegisteredTool>;
} {
  const server = new McpServer({ name: "cositas", version: "0.2.1" });
  const tools = registerTools(server, runtime);
  return { server, tools };
}

/* v8 ignore next 4 */
if (import.meta.main) {
  await verifyThingsAccess(createRuntime());
  const transport = new StdioServerTransport();
  const { server } = createServer();
  await server.connect(transport);
}
