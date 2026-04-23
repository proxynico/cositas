import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Database } from "bun:sqlite";
import {
  THINGS_APP_PATH,
  THINGS_FAST_READS,
  THINGS_DB_PATH,
  compareNullableNumber,
  errmsg,
  ExecFn,
  isoDayToUnixEnd,
  isoDayToUnixStart,
  isSandboxAutomationError,
  normalizeThingsJson,
  requireToken,
  StatsResult,
  StatsWindow,
  ThingsRuntime,
} from "./shared";

const exec = promisify(execFile) as ExecFn;

export function discoverThingsDbPath(): string | null {
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
    inspect() {
      if (dbPath === undefined) {
        dbPath = discoverThingsDbPath();
      }
      return {
        appPath: THINGS_APP_PATH,
        appPathExists: existsSync(THINGS_APP_PATH),
        fastReadsEnabled: THINGS_FAST_READS,
        dbPath,
      };
    },

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
      ] as string[]);
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
      // SQL-first fast-read paths. Things JXA cannot reliably enumerate the
      // built-in Inbox and Today lists (list.toDos() returns empty), so we
      // resolve IDs from SQLite and hydrate via JXA by-id.
      const supported = list === "logbook" || list === "trash" || list === "today" || list === "inbox";
      if (!THINGS_FAST_READS || !supported) {
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
        const where: string[] = ["type in (0, 1)"];
        const params: Array<string | number> = [];
        let orderBy = "userModificationDate desc";

        if (list === "logbook") {
          where.push("trashed = 0");
          where.push("status in (2, 3)");
          orderBy = "stopDate desc, userModificationDate desc";
        } else if (list === "trash") {
          where.push("trashed = 1");
        } else if (list === "today") {
          where.push("trashed = 0");
          where.push("status = 0");
          where.push("todayIndex != 0");
          orderBy = "todayIndex asc, userModificationDate desc";
        } else if (list === "inbox") {
          where.push("trashed = 0");
          where.push("status = 0");
          where.push("project is null");
          where.push("area is null");
          where.push("heading is null");
          where.push("start != 2");
          where.push("todayIndex = 0");
          orderBy = '"index" asc, userModificationDate desc';
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
          sql += " limit ? offset ?";
          params.push(options.limit, options.offset ?? 0);
        } else if ((options.offset ?? 0) > 0) {
          sql += " limit -1 offset ?";
          params.push(options.offset ?? 0);
        }

        const rows = db.query(sql).all(...params) as Array<{ id: string }>;
        if (!rows.length) {
          return "[]";
        }

        return normalizeThingsJson(
          await this.jxa(
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
          ),
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

          if (l?.userModificationDate != null || r?.userModificationDate != null) {
            const byModified = compareNullableNumber(-(l?.userModificationDate ?? 0), -(r?.userModificationDate ?? 0));
            if (byModified !== 0) return byModified;
          }

          return (original.get(String(left.id ?? "")) ?? 0) - (original.get(String(right.id ?? "")) ?? 0);
        });
      } finally {
        db.close(false);
      }
    },

    async statsQuery(window: StatsWindow): Promise<StatsResult | null> {
      if (!THINGS_FAST_READS) return null;

      if (dbPath === undefined) {
        dbPath = discoverThingsDbPath();
      }
      if (!dbPath) return null;

      const sinceStart = isoDayToUnixStart(window.since);
      const untilEnd = isoDayToUnixEnd(window.until);
      const today = new Date();
      const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const todayStart = isoDayToUnixStart(todayIso);

      const db = new Database(dbPath, { readonly: true, create: false });
      try {
        const windowRow = db
          .query(
            `select
               coalesce(sum(case when status = 2 and stopDate >= ? and stopDate <= ? then 1 else 0 end), 0) as completed,
               coalesce(sum(case when status = 3 and stopDate >= ? and stopDate <= ? then 1 else 0 end), 0) as canceled,
               coalesce(sum(case when creationDate >= ? and creationDate <= ? then 1 else 0 end), 0) as created
             from TMTask
             where trashed = 0 and type in (0, 1)`,
          )
          .get(sinceStart, untilEnd, sinceStart, untilEnd, sinceStart, untilEnd) as {
          completed: number;
          canceled: number;
          created: number;
        };

        // Snapshot counts. Schema notes:
        //   overdue  = open todos with deadline strictly before start-of-today.
        //   today    = open todos in Today list — identified by nonzero todayIndex.
        //              Things JXA can't enumerate built-in list items reliably, so
        //              SQL is the authoritative path.
        //   inbox    = open todos with no parent (project/area/heading), not in
        //              Someday (start != 2), and not pulled into Today.
        const overdueRow = db
          .query(
            `select count(*) as n from TMTask
             where trashed = 0 and type = 0 and status = 0
               and deadline is not null and deadline < ?`,
          )
          .get(todayStart) as { n: number } | null;

        const todayRow = db
          .query(
            `select count(*) as n from TMTask
             where trashed = 0 and type = 0 and status = 0
               and todayIndex != 0`,
          )
          .get() as { n: number } | null;

        const inboxRow = db
          .query(
            `select count(*) as n from TMTask
             where trashed = 0 and type = 0 and status = 0
               and project is null and area is null and heading is null
               and start != 2
               and todayIndex = 0`,
          )
          .get() as { n: number } | null;

        return {
          window,
          completed: Number(windowRow?.completed ?? 0),
          canceled: Number(windowRow?.canceled ?? 0),
          created: Number(windowRow?.created ?? 0),
          overdue: Number(overdueRow?.n ?? 0),
          inbox: Number(inboxRow?.n ?? 0),
          today: Number(todayRow?.n ?? 0),
        };
      } finally {
        db.close(false);
      }
    },
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
