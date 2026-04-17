import { z } from "zod";

export type ExecResult = {
  stdout: string;
};

export type ExecFn = (file: string, args: string[]) => Promise<ExecResult>;

export type RuntimeInspection = {
  appPath: string;
  appPathExists: boolean;
  fastReadsEnabled: boolean;
  dbPath: string | null;
};

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
  inspect(): RuntimeInspection;
  token: string;
};

export const BUILTIN_WHEN = ["today", "tomorrow", "evening", "anytime", "someday"] as const;
export const SPECIAL_WHEN = new Set<string>(["evening", "anytime", "someday"]);
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const THINGS_APP_PATH = process.env.THINGS_APP_PATH ?? "/Applications/Things3.app";
export const THINGS_FAST_READS = process.env.THINGS_FAST_READS !== "0";
export const THINGS_DB_PATH = process.env.THINGS_DB_PATH;

export const LIST_NAMES: Record<string, string> = {
  inbox: "Inbox",
  today: "Today",
  anytime: "Anytime",
  upcoming: "Upcoming",
  someday: "Someday",
  logbook: "Logbook",
  trash: "Trash",
};

const SANDBOX_FAILURE_MARKERS = [
  "com.apple.hiservices-xpcservice",
  "Connection Invalid",
  "Connection invalid",
  "Sandbox restriction",
];

export const whenSchema = z
  .string()
  .refine((value) => BUILTIN_WHEN.includes(value as (typeof BUILTIN_WHEN)[number]) || ISO_DATE.test(value), {
    message: "Use today, tomorrow, evening, anytime, someday, or yyyy-mm-dd",
  });

export const updateWhenSchema = z
  .string()
  .refine((value) => value === "" || BUILTIN_WHEN.includes(value as (typeof BUILTIN_WHEN)[number]) || ISO_DATE.test(value), {
    message: "Use today, tomorrow, evening, anytime, someday, yyyy-mm-dd, or empty string",
  });

export const deadlineSchema = z
  .string()
  .regex(ISO_DATE, "Use yyyy-mm-dd");

export const updateDeadlineSchema = z
  .string()
  .refine((value) => value === "" || ISO_DATE.test(value), {
    message: "Use yyyy-mm-dd or empty string",
  });

export const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
export const fail = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true as const,
});

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

export function isoDayToUnixStart(value: string): number {
  return Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000);
}

export function isoDayToUnixEnd(value: string): number {
  return Math.floor(new Date(`${value}T23:59:59Z`).getTime() / 1000);
}

export function compareNullableNumber(a: number | null | undefined, b: number | null | undefined): number {
  const av = a ?? Number.MAX_SAFE_INTEGER;
  const bv = b ?? Number.MAX_SAFE_INTEGER;
  return av - bv;
}

export function normalizeThingsValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeThingsValue(entry)) as T;
  }

  if (value != null && typeof value === "object") {
    const normalized = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeThingsValue(entry)]),
    ) as Record<string, unknown>;

    const status = typeof normalized.status === "string" ? normalized.status : null;
    const hasCompletionDate = Object.prototype.hasOwnProperty.call(normalized, "completionDate");
    const hasCancellationDate = Object.prototype.hasOwnProperty.call(normalized, "cancellationDate");

    if (status && (hasCompletionDate || hasCancellationDate)) {
      const completionDate = normalized.completionDate ?? null;
      const cancellationDate = normalized.cancellationDate ?? null;

      if (status === "completed") {
        normalized.completionDate = completionDate ?? cancellationDate ?? null;
        normalized.cancellationDate = null;
      } else if (status === "canceled") {
        normalized.completionDate = null;
        normalized.cancellationDate = cancellationDate ?? completionDate ?? null;
      } else {
        normalized.completionDate = null;
        normalized.cancellationDate = null;
      }
    }

    return normalized as T;
  }

  return value;
}

export function normalizeThingsJson(text: string): string {
  return JSON.stringify(normalizeThingsValue(JSON.parse(text) as unknown));
}

export function usesSpecialWhen(value: string | undefined): value is string {
  return value != null && SPECIAL_WHEN.has(value);
}

export function requireToken(token: string): void {
  if (!token) {
    throw new Error("THINGS_AUTH_TOKEN is required for this operation");
  }
}

export function needsJsonTagWrite(tags: string[] | undefined): boolean {
  return Boolean(tags?.some((tag) => tag.includes(",")));
}

export function toChecklistItems(items: string[] | undefined): Array<Record<string, unknown>> | undefined {
  if (items == null) return undefined;
  return items.map((title) => ({
    type: "checklist-item",
    attributes: { title },
  }));
}

export function normalizeStatusPatch(completed: boolean | undefined, canceled: boolean | undefined): {
  completed?: boolean;
  canceled?: boolean;
} {
  if (canceled === true) return { canceled: true };
  if (completed === true) return { completed: true };
  if (completed === false || canceled === false) return { completed: false, canceled: false };
  return {};
}

export function buildJsonUpdateOperation(
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
  const status = normalizeStatusPatch(params.completed, params.canceled);

  if (params.title != null) attributes.title = params.title;
  if (params.notes != null) attributes.notes = params.notes;
  if (params.when != null && params.when !== "") attributes.when = params.when;
  if (params.deadline != null && params.deadline !== "") attributes.deadline = params.deadline;
  if (params.tags != null) attributes.tags = params.tags;
  if (status.completed != null) attributes.completed = status.completed;
  if (status.canceled != null) attributes.canceled = status.canceled;
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
