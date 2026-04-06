#!/usr/bin/env bun
// cositas — Things 3 MCP server
// All interaction via JXA (osascript). Never foregrounds Things 3.

import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const exec = promisify(execFile);

const BUILTIN_WHEN = ["today", "tomorrow", "evening", "anytime", "someday"] as const;
const SPECIAL_WHEN = new Set<string>(["evening", "anytime", "someday"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const THINGS_APP_PATH = process.env.THINGS_APP_PATH ?? "/Applications/Things3.app";
const THINGS_FAST_READS = process.env.THINGS_FAST_READS !== "0";
const THINGS_DB_PATH = process.env.THINGS_DB_PATH;

const whenSchema = z
  .string()
  .refine((value) => BUILTIN_WHEN.includes(value as (typeof BUILTIN_WHEN)[number]) || ISO_DATE.test(value), {
    message: "Use today, tomorrow, evening, anytime, someday, or yyyy-mm-dd",
  });

const updateWhenSchema = z
  .string()
  .refine((value) => value === "" || BUILTIN_WHEN.includes(value as (typeof BUILTIN_WHEN)[number]) || ISO_DATE.test(value), {
    message: "Use today, tomorrow, evening, anytime, someday, yyyy-mm-dd, or empty string",
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
  quietJson(operations: Array<Record<string, unknown>>, reveal?: boolean): Promise<void>;
  fastListRead(
    list: string,
    options?: {
      limit?: number;
      offset?: number;
      completed_after?: string;
      completed_before?: string;
    },
  ): Promise<string | null>;
  sortListItems(list: string, items: Array<Record<string, unknown>>): Array<Record<string, unknown>>;
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
  trash: "Trash",
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

function discoverThingsDbPath(): string | null {
  if (THINGS_DB_PATH) {
    return existsSync(THINGS_DB_PATH) ? THINGS_DB_PATH : null;
  }
  const root = join(homedir(), "Library", "Group Containers", "JLMPQHK86H.com.culturedcode.ThingsMac");
  if (!existsSync(root)) return null;
  const dataDir = readdirSync(root, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.startsWith("ThingsData-"))
    ?.name;
  if (!dataDir) return null;
  const candidate = join(root, dataDir, "Things Database.thingsdatabase", "main.sqlite");
  return existsSync(candidate) ? candidate : null;
}

function isoDayToUnixStart(value: string): number {
  return Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000);
}

function isoDayToUnixEnd(value: string): number {
  return Math.floor(new Date(`${value}T23:59:59Z`).getTime() / 1000);
}

function compareNullableNumber(a: number | null | undefined, b: number | null | undefined): number {
  const av = a ?? Number.MAX_SAFE_INTEGER;
  const bv = b ?? Number.MAX_SAFE_INTEGER;
  return av - bv;
}

export function createRuntime({
  execFn = exec,
  token = process.env.THINGS_AUTH_TOKEN ?? "",
}: {
  execFn?: ExecFn;
  token?: string;
} = {}): ThingsRuntime {
  let dbPath: string | null | undefined;
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
var tagsOf = function(item) {
  try {
    return item.tags().map(function(tag) { return tag.name(); });
  } catch(e) {
    var raw = "";
    try { raw = item.tagNames(); } catch(inner) {}
    if (!raw) return [];
    return raw.split(/,\s*/);
  }
};
var asIso = function(d) {
  return d ? d.toISOString() : null;
};
var completedAtOf = function(item) {
  try {
    var done = item.completionDate();
    if (done) return done;
  } catch(e) {}
  try {
    var canceled = item.cancellationDate();
    if (canceled) return canceled;
  } catch(e) {}
  return null;
};
var applyReadWindow = function(items) {
  var filtered = items;
  if (P.completedAfter || P.completedBefore) {
    filtered = filtered.filter(function(item) {
      var stamp = completedAtOf(item);
      if (!stamp) return false;
      if (P.completedAfter && stamp < new Date(P.completedAfter + "T00:00:00")) return false;
      if (P.completedBefore && stamp > new Date(P.completedBefore + "T23:59:59")) return false;
      return true;
    });
  }
  var start = P.offset || 0;
  if (P.limit == null) return filtered.slice(start);
  return filtered.slice(start, start + P.limit);
};
var todoOf = function(t) {
  var proj = null, area = null;
  try { proj = t.project().name(); } catch(e) {}
  try { area = t.area().name(); } catch(e) {}
  return {kind:"todo", id:t.id(), name:t.name(), status:t.status(), notes:t.notes(),
    tags:tagsOf(t), dueDate:asIso(t.dueDate()),
    activationDate:asIso(t.activationDate()), completionDate:asIso(t.completionDate()),
    cancellationDate:asIso(t.cancellationDate()),
    project:proj, area:area};
};
var projectOf = function(pr) {
  var area = null;
  try { area = pr.area().name(); } catch(e) {}
  return {kind:"project", id:pr.id(), name:pr.name(), status:pr.status(), notes:pr.notes(),
    tags:tagsOf(pr), dueDate:asIso(pr.dueDate()),
    activationDate:asIso(pr.activationDate()), completionDate:asIso(pr.completionDate()),
    cancellationDate:asIso(pr.cancellationDate()),
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

    async quietJson(operations, reveal = false) {
      const requiresAuth = operations.some((operation) => operation.operation === "update");
      if (requiresAuth) {
        requireToken(token);
      }
      await this.quietUrl("json", {
        "auth-token": requiresAuth ? token : undefined,
        reveal: reveal ? "true" : "false",
        data: JSON.stringify(operations),
      });
    },

    async fastListRead(list, options = {}) {
      if (!THINGS_FAST_READS || (list !== "logbook" && list !== "trash")) {
        return null;
      }

      if (dbPath === undefined) {
        dbPath = discoverThingsDbPath();
      }
      if (!dbPath) {
        return null;
      }

      const db = new Database(dbPath, { readonly: true, create: false });
      try {
        const where: string[] = [`type in (0, 1)`];
        const params: Array<string | number> = [];
        let orderBy = "userModificationDate desc";

        if (list === "logbook") {
          where.push("trashed = 0");
          where.push("status in (2, 3)");
          orderBy = "stopDate desc, userModificationDate desc";
        } else if (list === "trash") {
          where.push("trashed = 1");
        }

        if (options.completed_after) {
          where.push("stopDate >= ?");
          params.push(isoDayToUnixStart(options.completed_after));
        }
        if (options.completed_before) {
          where.push("stopDate <= ?");
          params.push(isoDayToUnixEnd(options.completed_before));
        }

        let sql = `
          select uuid as id
          from TMTask
          where ${where.join(" and ")}
          order by ${orderBy}
        `;

        if (options.limit != null) {
          sql += ` limit ? offset ?`;
          params.push(options.limit, options.offset ?? 0);
        } else if ((options.offset ?? 0) > 0) {
          sql += ` limit -1 offset ?`;
          params.push(options.offset ?? 0);
        }

        const rows = db.query(sql).all(...params) as Array<{ id: string }>;
        if (!rows.length) {
          return "[]";
        }

        return await this.jxa(
          `return JSON.stringify(P.ids.map(function(id) {
  try {
    var todo = app.toDos.byId(id); todo.id();
    return todoOf(todo);
  } catch(e) {
    var project = app.projects.byId(id); project.id();
    return projectOf(project);
  }
}));`,
          { ids: rows.map((row) => row.id) },
        );
      } finally {
        db.close(false);
      }
    },

    sortListItems(list, items) {
      if (!items.length) return items;

      if (dbPath === undefined) {
        dbPath = discoverThingsDbPath();
      }
      if (!dbPath) {
        return items;
      }

      const ids = items
        .map((item) => String(item.id ?? ""))
        .filter((id) => id.length > 0);
      if (!ids.length) {
        return items;
      }

      const placeholders = ids.map(() => "?").join(", ");
      const db = new Database(dbPath, { readonly: true, create: false });
      try {
        const rows = db
          .query(
            `select uuid as id, "index" as idx, todayIndex, startDate, deadline, stopDate, userModificationDate
             from TMTask
             where uuid in (${placeholders})`,
          )
          .all(...ids) as Array<{
          id: string;
          idx: number | null;
          todayIndex: number | null;
          startDate: number | null;
          deadline: number | null;
          stopDate: number | null;
          userModificationDate: number | null;
        }>;

        const meta = new Map(rows.map((row) => [row.id, row]));
        const original = new Map(items.map((item, index) => [String(item.id ?? index), index]));

        return [...items].sort((left, right) => {
          const l = meta.get(String(left.id ?? ""));
          const r = meta.get(String(right.id ?? ""));

          if (list === "today") {
            const byToday = compareNullableNumber(l?.todayIndex, r?.todayIndex);
            if (byToday !== 0) return byToday;
          }

          if (list === "upcoming") {
            const byStart = compareNullableNumber(l?.startDate, r?.startDate);
            if (byStart !== 0) return byStart;
            const byDeadline = compareNullableNumber(l?.deadline, r?.deadline);
            if (byDeadline !== 0) return byDeadline;
          }

          const byIndex = compareNullableNumber(l?.idx, r?.idx);
          if (byIndex !== 0) return byIndex;

          if (list === "logbook" || list === "trash") {
            const byStop = compareNullableNumber(-(l?.stopDate ?? 0), -(r?.stopDate ?? 0));
            if (byStop !== 0) return byStop;
          }

          if ((l?.userModificationDate ?? null) != null || (r?.userModificationDate ?? null) != null) {
            const byModified = compareNullableNumber(-(l?.userModificationDate ?? 0), -(r?.userModificationDate ?? 0));
            if (byModified !== 0) return byModified;
          }

          return (original.get(String(left.id ?? "")) ?? 0) - (original.get(String(right.id ?? "")) ?? 0);
        });
      } finally {
        db.close(false);
      }
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

async function applyQuietUpdate(
  runtime: ThingsRuntime,
  kind: "todo" | "project",
  id: string,
  params: Record<string, string | undefined>,
): Promise<void> {
  requireToken(runtime.token);
  await runtime.quietUrl(kind === "project" ? "update-project" : "update", {
    "auth-token": runtime.token,
    id,
    ...params,
  });
}

function needsJsonTagWrite(tags: string[] | undefined): boolean {
  return Boolean(tags?.some((tag) => tag.includes(",")));
}

function toChecklistItems(items: string[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!items?.length) return undefined;
  return items.map((title) => ({
    type: "checklist-item",
    attributes: { title },
  }));
}

function buildJsonUpdateOperation(
  kind: "todo" | "project",
  id: string,
  params: {
    title?: string;
    notes?: string;
    when?: string;
    deadline?: string;
    tags?: string[];
    list?: string;
    completed?: boolean;
    canceled?: boolean;
    checklist_items?: string[];
  },
): Record<string, unknown> | null {
  const attributes: Record<string, unknown> = {};
  if (params.title != null) attributes.title = params.title;
  if (params.notes != null) attributes.notes = params.notes;
  if (params.when != null && params.when !== "") attributes.when = params.when;
  if (params.deadline != null && params.deadline !== "") attributes.deadline = params.deadline;
  if (params.tags != null) attributes.tags = params.tags;
  if (params.completed != null) attributes.completed = params.completed;
  if (params.canceled != null) attributes.canceled = params.canceled;
  if (kind === "todo" && params.list != null) attributes.list = params.list;
  if (kind === "project" && params.list != null) attributes.area = params.list;
  if (kind === "todo" && params.checklist_items != null) {
    attributes["checklist-items"] = toChecklistItems(params.checklist_items);
  }
  if (!Object.keys(attributes).length) return null;
  return {
    type: kind === "todo" ? "to-do" : "project",
    operation: "update",
    id,
    attributes,
  };
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
          "trash",
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
      limit: z.number().int().nonnegative().optional().describe("Max items to return"),
      offset: z.number().int().nonnegative().optional().describe("Items to skip before returning results"),
      completed_after: deadlineSchema.optional().describe("Only return items completed/canceled on or after yyyy-mm-dd"),
      completed_before: deadlineSchema.optional().describe("Only return items completed/canceled on or before yyyy-mm-dd"),
    },
    async ({ list, project, area, id, limit, offset, completed_after, completed_before }) => {
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
return JSON.stringify(applyReadWindow(p.toDos()).map(todoOf));`,
              {
                n: project,
                limit: limit ?? null,
                offset: offset ?? 0,
                completedAfter: completed_after ?? null,
                completedBefore: completed_before ?? null,
              },
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

        const fast = await runtime.fastListRead(list!, {
          limit,
          offset,
          completed_after,
          completed_before,
        });
        if (fast != null) {
          return ok(fast);
        }

        const mixed = await runtime.jxa(
          `var list = app.lists.byName(P.n);
var todos = list.toDos().map(todoOf);
var projects = [];
try { projects = list.projects().map(projectOf); } catch(e) {}
var items = todos.concat(projects);
if (P.completedAfter || P.completedBefore) {
  items = items.filter(function(item) {
    var stamp = item.completionDate || item.cancellationDate;
    if (!stamp) return false;
    var value = new Date(stamp);
    if (P.completedAfter && value < new Date(P.completedAfter + "T00:00:00")) return false;
    if (P.completedBefore && value > new Date(P.completedBefore + "T23:59:59")) return false;
    return true;
  });
}
var start = P.offset || 0;
if (P.limit != null) items = items.slice(start, start + P.limit);
else if (start) items = items.slice(start);
return JSON.stringify(items);`,
          {
            n: LIST_NAMES[list!],
            limit: limit ?? null,
            offset: offset ?? 0,
            completedAfter: completed_after ?? null,
            completedBefore: completed_before ?? null,
          },
        );
        return ok(JSON.stringify(runtime.sortListItems(list!, JSON.parse(mixed) as Array<Record<string, unknown>>)));
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
            `var results = P.q ? app.toDos.whose({name: {_contains: P.q}})() : app.toDos();
results = results.filter(function(t) { return t.status() === "open"; });
if (P.t) {
  results = results.filter(function(t) {
    try {
      return t.tags().some(function(tag) { return tag.name() === P.t; });
    } catch(e) {
      return false;
    }
  });
}
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
        const specialWhen = usesSpecialWhen(params.when) ? params.when : undefined;
        const tagsNeedJson = needsJsonTagWrite(params.tags);
        const needsJsonPatch = specialWhen != null || params.checklist_items?.length || tagsNeedJson;
        if (needsJsonPatch) {
          requireToken(runtime.token);
        }

        const result = await runtime.jxa(
          `var props = {name: P.title};
if (P.notes) props.notes = P.notes;
if (P.tags && P.tags.length && !P.tagsNeedJson) props.tagNames = P.tags.join(", ");
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
          {
            ...params,
            tagsNeedJson,
          },
        );

        const created = JSON.parse(result) as { id: string };
        const operation = buildJsonUpdateOperation("todo", created.id, {
          when: specialWhen,
          tags: tagsNeedJson ? params.tags : undefined,
          checklist_items: params.checklist_items,
        });
        if (operation) {
          await runtime.quietJson([operation]);
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
        const specialWhen = usesSpecialWhen(params.when) ? params.when : undefined;
        const tagsNeedJson = needsJsonTagWrite(params.tags);
        const needsJsonPatch = specialWhen != null || tagsNeedJson;
        if (needsJsonPatch) {
          requireToken(runtime.token);
        }

        const result = await runtime.jxa(
          `var props = {name: P.title};
if (P.notes) props.notes = P.notes;
if (P.tags && P.tags.length && !P.tagsNeedJson) props.tagNames = P.tags.join(", ");
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
          {
            ...params,
            tagsNeedJson,
          },
        );

        const created = JSON.parse(result) as { id: string };
        const operation = buildJsonUpdateOperation("project", created.id, {
          when: specialWhen,
          tags: tagsNeedJson ? params.tags : undefined,
        });
        if (operation) {
          await runtime.quietJson([operation]);
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
      when: updateWhenSchema
        .optional()
        .describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd | empty string to clear"),
      deadline: updateDeadlineSchema.optional().describe("yyyy-mm-dd (empty string to clear)"),
      tags: z.array(z.string()).optional().describe("Replace all tags"),
      checklist_items: z.array(z.string()).optional().describe("Replace all checklist items"),
      completed: z.boolean().optional(),
      canceled: z.boolean().optional(),
      list: z
        .string()
        .optional()
        .describe("Move to project (todos) or area (projects) by name"),
    },
    async (params) => {
      try {
        const specialWhen = usesSpecialWhen(params.when) ? params.when : undefined;
        const tagsNeedJson = needsJsonTagWrite(params.tags);
        const needsUrlWhenClear = params.when === "";
        const needsJsonPatch = specialWhen != null || params.checklist_items != null || tagsNeedJson;
        if (needsUrlWhenClear || needsJsonPatch) {
          requireToken(runtime.token);
        }

        const result = await runtime.jxa(
          `var item, type;
try { item = app.toDos.byId(P.id); item.id(); type = "todo"; }
catch(e) { item = app.projects.byId(P.id); item.id(); type = "project"; }
if (P.hasOwnProperty("title") && P.title) item.name = P.title;
if (P.hasOwnProperty("notes")) item.notes = P.notes || "";
if (P.hasOwnProperty("tags") && !P.tagsNeedJson) item.tagNames = P.tags ? P.tags.join(", ") : "";
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
          {
            ...params,
            tagsNeedJson,
          },
        );

        const parsed = JSON.parse(result) as {
          kind: "todo" | "project";
          item: unknown;
        };

        if (needsUrlWhenClear) {
          await applyQuietUpdate(runtime, parsed.kind, params.id, { when: "" });
          return ok(await readItemJson(runtime, params.id));
        }

        const operation = buildJsonUpdateOperation(parsed.kind, params.id, {
          tags: tagsNeedJson ? params.tags : undefined,
          when: specialWhen,
          checklist_items: params.checklist_items,
        });
        if (operation) {
          await runtime.quietJson([operation]);
          return ok(await readItemJson(runtime, params.id));
        }

        return ok(JSON.stringify(parsed.item));
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.bulk_update = server.tool(
    "bulk_update",
    "Update multiple todos or projects at once. Uses Things JSON updates and requires THINGS_AUTH_TOKEN.",
    {
      ids: z.array(z.string()).min(1).describe("Todo or project IDs"),
      title: z.string().optional(),
      notes: z.string().optional().describe("Replace notes"),
      when: whenSchema.optional().describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd"),
      deadline: deadlineSchema.optional().describe("yyyy-mm-dd"),
      tags: z.array(z.string()).optional().describe("Replace all tags"),
      checklist_items: z.array(z.string()).optional().describe("Replace all checklist items on todos"),
      completed: z.boolean().optional(),
      canceled: z.boolean().optional(),
      list: z.string().optional().describe("Move todos to a project/area, or projects to an area"),
    },
    async (params) => {
      try {
        requireToken(runtime.token);
        const detail = await runtime.jxa(
          `return JSON.stringify(P.ids.map(function(id) {
  try {
    var todo = app.toDos.byId(id); todo.id();
    return {id: id, kind: "todo"};
  } catch(e) {
    var project = app.projects.byId(id); project.id();
    return {id: id, kind: "project"};
  }
}));`,
          { ids: params.ids },
        );
        const items = JSON.parse(detail) as Array<{ id: string; kind: "todo" | "project" }>;
        const operations = items
          .map((item) =>
            buildJsonUpdateOperation(item.kind, item.id, {
              title: params.title,
              notes: params.notes,
              when: params.when,
              deadline: params.deadline,
              tags: params.tags,
              list: params.list,
              completed: params.completed,
              canceled: params.canceled,
              checklist_items: params.checklist_items,
            }),
          )
          .filter((operation): operation is Record<string, unknown> => operation != null);
        if (!operations.length) {
          return fail("Provide at least one field to update");
        }
        await runtime.quietJson(operations);
        return ok(JSON.stringify(items.map((item) => ({ id: item.id, kind: item.kind, updated: true }))));
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.delete = server.tool(
    "delete",
    "Move a todo, project, or area to Things Trash.",
    {
      id: z.string().describe("Todo, project, or area ID"),
    },
    async ({ id }) => {
      try {
        const result = await runtime.jxa(
          `try {
  var todo = app.toDos.byId(P.id); todo.id();
  app.delete(todo);
  return JSON.stringify({id: P.id, kind: "todo", deleted: true});
} catch(e1) {
  try {
    var project = app.projects.byId(P.id); project.id();
    app.delete(project);
    return JSON.stringify({id: P.id, kind: "project", deleted: true});
  } catch(e2) {
    var area = app.areas.byId(P.id); area.id();
    app.delete(area);
    return JSON.stringify({id: P.id, kind: "area", deleted: true});
  }
}`,
          { id },
        );
        return ok(result);
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.empty_trash = server.tool(
    "empty_trash",
    "Permanently delete everything currently in Things Trash.",
    {},
    async () => {
      try {
        await runtime.jxa(
          `app.emptyTrash();
return JSON.stringify({emptied: true});`,
        );
        return ok('{"emptied":true}');
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
  const transport = new StdioServerTransport();
  const { server } = createServer();
  await server.connect(transport);
}
