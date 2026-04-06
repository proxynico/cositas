import { describe, expect, test } from "bun:test";
import {
  createRuntime,
  createServer,
  errmsg,
  isSandboxAutomationError,
  LIST_NAMES,
  type ThingsRuntime,
  verifyThingsAccess,
} from "./index";

type Call = {
  body: string;
  args: Record<string, unknown> | undefined;
};

function createMockApp({
  token = "token",
  jxa,
  quietUrl,
  quietJson,
  fastListRead,
  sortListItems,
}: {
  token?: string;
  jxa?: (body: string, args?: Record<string, unknown>) => Promise<string> | string;
  quietUrl?: (path: string, params: Record<string, string | undefined>) => Promise<void> | void;
  quietJson?: (operations: Array<Record<string, unknown>>, reveal?: boolean) => Promise<void> | void;
  fastListRead?: (
    list: string,
    options?: {
      limit?: number;
      offset?: number;
      completed_after?: string;
      completed_before?: string;
    },
  ) => Promise<string | null> | string | null;
  sortListItems?: (list: string, items: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
} = {}) {
  const jxaCalls: Call[] = [];
  const quietCalls: Array<{ path: string; params: Record<string, string | undefined> }> = [];
  const quietJsonCalls: Array<{ operations: Array<Record<string, unknown>>; reveal?: boolean }> = [];

  const runtime: ThingsRuntime = {
    token,
    async jxa(body, args) {
      jxaCalls.push({ body, args });
      if (!jxa) return "[]";
      return await jxa(body, args);
    },
    async quietUrl(path, params) {
      quietCalls.push({ path, params });
      await quietUrl?.(path, params);
    },
    async quietJson(operations, reveal) {
      quietJsonCalls.push({ operations, reveal });
      await quietJson?.(operations, reveal);
    },
    async fastListRead(list, options) {
      return (await fastListRead?.(list, options)) ?? null;
    },
    sortListItems(list, items) {
      return sortListItems ? sortListItems(list, items) : items;
    },
  };

  const { tools } = createServer(runtime);
  return { tools, jxaCalls, quietCalls, quietJsonCalls };
}

async function callTool(tool: unknown, args: Record<string, unknown>) {
  return await (tool as (args: Record<string, unknown>, extra: unknown) => Promise<unknown>)(args, {});
}

function textOf(result: unknown) {
  return (result as { content: Array<{ text: string }> }).content[0]?.text;
}

function isError(result: unknown) {
  return Boolean((result as { isError?: boolean }).isError);
}

describe("runtime", () => {
  test("errmsg prefers stderr and strips osascript wrapper", () => {
    const error = Object.assign(new Error("fallback"), {
      stderr: "execution error: Missing permission (-1743)\n",
    });
    expect(errmsg(error)).toBe("Missing permission");
    expect(errmsg("plain")).toBe("plain");
  });

  test("jxa builds the osascript invocation", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runtime = createRuntime({
      token: "token",
      execFn: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "  ok  " };
      },
    });

    const result = await runtime.jxa("return JSON.stringify(P);", { hello: "world" });
    expect(result).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("osascript");
    expect(calls[0]?.args[0]).toBe("-l");
    expect(calls[0]?.args[1]).toBe("JavaScript");
    expect(calls[0]?.args[3]).toContain('var app = Application("/Applications/Things3.app");');
    expect(calls[0]?.args[4]).toBe(JSON.stringify({ hello: "world" }));
  });

  test("quietUrl encodes params and keeps Things in the background", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runtime = createRuntime({
      token: "token",
      execFn: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "" };
      },
    });

    await runtime.quietUrl("show", {
      query: "Today & Next",
      id: "abc/123",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[3]).toContain("things:///show?query=Today%20%26%20Next&id=abc%2F123");
    expect(calls[0]?.args[3]).toContain("c.activates = false;");
  });

  test("quietJson dispatches the JSON endpoint and auth token for updates", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runtime = createRuntime({
      token: "token",
      execFn: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "" };
      },
    });

    await runtime.quietJson([
      {
        type: "to-do",
        operation: "update",
        id: "1",
        attributes: { when: "someday" },
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[3]).toContain("things:///json?");
    expect(calls[0]?.args[3]).toContain("auth-token=token");
    expect(calls[0]?.args[3]).toContain("%22operation%22%3A%22update%22");
  });

  test("detects sandboxed Apple Events failures", () => {
    const sandboxError = Object.assign(new Error("fallback"), {
      stderr:
        "Connection Invalid error for service com.apple.hiservices-xpcservice.\nError received in message reply handler: Connection invalid\n",
    });
    expect(isSandboxAutomationError(sandboxError)).toBeTrue();
    expect(isSandboxAutomationError(new Error("boom"))).toBeFalse();
  });

  test("verifies Things access with a read-only startup probe", async () => {
    let seenBody = "";
    const runtime: ThingsRuntime = {
      token: "token",
      async jxa(body) {
        seenBody = body;
        return '["Inbox","Today"]';
      },
      async quietUrl() {},
      async quietJson() {},
      async fastListRead() { return null; },
      sortListItems(_list, items) { return items; },
    };

    await verifyThingsAccess(runtime);
    expect(seenBody).toContain("app.lists().map");
  });

  test("rewrites sandbox startup failures into a clear message", async () => {
    const runtime: ThingsRuntime = {
      token: "token",
      async jxa() {
        throw Object.assign(new Error("fallback"), {
          stderr:
            "Connection Invalid error for service com.apple.hiservices-xpcservice.\nError received in message reply handler: Connection invalid\n",
        });
      },
      async quietUrl() {},
      async quietJson() {},
      async fastListRead() { return null; },
      sortListItems(_list, items) { return items; },
    };

    expect(verifyThingsAccess(runtime)).rejects.toThrow(
      "Things 3 automation is blocked by the current sandbox. Run cositas outside the Codex sandbox or another restricted osascript environment.",
    );
  });

  test("rewrites non-sandbox startup failures without hiding the cause", async () => {
    const runtime: ThingsRuntime = {
      token: "token",
      async jxa() {
        throw new Error("Application can't be found.");
      },
      async quietUrl() {},
      async quietJson() {},
      async fastListRead() { return null; },
      sortListItems(_list, items) { return items; },
    };

    expect(verifyThingsAccess(runtime)).rejects.toThrow(
      "Things 3 startup check failed: Application can't be found.",
    );
  });
});

describe("read", () => {
  test("requires exactly one selector", async () => {
    const { tools } = createMockApp();
    const result = await callTool(tools.read.handler, {});
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("Provide exactly one of list, project, area, or id");
  });

  test("rejects multiple selectors", async () => {
    const { tools } = createMockApp();
    const result = await callTool(tools.read.handler, { list: "today", id: "x" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("Provide exactly one of list, project, area, or id");
  });

  test("reads an item by id through the shared detail script", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => '{"id":"1"}',
    });

    const result = await callTool(tools.read.handler, { id: "1" });
    expect(textOf(result)).toBe('{"id":"1"}');
    expect(jxaCalls).toHaveLength(1);
    expect(jxaCalls[0]?.body).toContain("toDoChecklistItems");
    expect(jxaCalls[0]?.args).toEqual({ id: "1" });
  });

  test("maps built-in list names", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.read.handler, { list: "today" });
    expect(jxaCalls[0]?.args).toEqual({
      n: LIST_NAMES.today,
      limit: null,
      offset: 0,
      completedAfter: null,
      completedBefore: null,
    });
  });

  test("built-in list reads include projects as well as todos", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.read.handler, { list: "today" });
    expect(jxaCalls[0]?.body).toContain("list.projects().map(projectOf)");
    expect(jxaCalls[0]?.body).toContain("todos.concat(projects)");
  });

  test("built-in list reads pass merged items through the sorter", async () => {
    const { tools } = createMockApp({
      jxa: async () => '[{"id":"todo-1","kind":"todo"},{"id":"proj-1","kind":"project"}]',
      sortListItems: (list, items) => {
        expect(list).toBe("today");
        expect(items).toEqual([
          { id: "todo-1", kind: "todo" },
          { id: "proj-1", kind: "project" },
        ]);
        return [...items].reverse();
      },
    });

    const result = await callTool(tools.read.handler, { list: "today" });
    expect(textOf(result)).toBe('[{"id":"proj-1","kind":"project"},{"id":"todo-1","kind":"todo"}]');
  });

  test("passes pagination and completion window through to list reads", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.read.handler, {
      list: "logbook",
      limit: 25,
      offset: 50,
      completed_after: "2026-04-01",
      completed_before: "2026-04-06",
    });

    expect(jxaCalls[0]?.body).toContain("todos.concat(projects)");
    expect(jxaCalls[0]?.body).toContain("P.completedAfter || P.completedBefore");
    expect(jxaCalls[0]?.args).toEqual({
      n: LIST_NAMES.logbook,
      limit: 25,
      offset: 50,
      completedAfter: "2026-04-01",
      completedBefore: "2026-04-06",
    });
  });

  test("uses fast list reads for heavy built-in lists when available", async () => {
    const { tools, jxaCalls } = createMockApp({
      fastListRead: async (list, options) => {
        expect(list).toBe("logbook");
        expect(options).toEqual({
          limit: 10,
          offset: 20,
          completed_after: "2026-04-01",
          completed_before: "2026-04-06",
        });
        return '[{"kind":"project","id":"p1"},{"kind":"todo","id":"t1"}]';
      },
    });

    const result = await callTool(tools.read.handler, {
      list: "logbook",
      limit: 10,
      offset: 20,
      completed_after: "2026-04-01",
      completed_before: "2026-04-06",
    });

    expect(textOf(result)).toBe('[{"kind":"project","id":"p1"},{"kind":"todo","id":"t1"}]');
    expect(jxaCalls).toHaveLength(0);
  });

  test("lists open projects, areas, and tags", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.read.handler, { list: "projects" });
    await callTool(tools.read.handler, { list: "areas" });
    await callTool(tools.read.handler, { list: "tags" });

    expect(jxaCalls[0]?.body).toContain('p.status()==="open"');
    expect(jxaCalls[1]?.body).toContain("app.areas().map");
    expect(jxaCalls[2]?.body).toContain("app.tags().map");
  });

  test("reads a project by exact name", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.read.handler, { project: "Launch" });
    expect(jxaCalls[0]?.body).toContain("app.projects.byName(P.n); p.id();");
    expect(jxaCalls[0]?.args).toEqual({
      n: "Launch",
      limit: null,
      offset: 0,
      completedAfter: null,
      completedBefore: null,
    });
  });

  test("reads an area by exact area match", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.read.handler, { area: "Work" });
    expect(jxaCalls[0]?.body).toContain("p.area().name() === target");
    expect(jxaCalls[0]?.args).toEqual({ n: "Work" });
  });

  test("returns read errors from jxa", async () => {
    const { tools } = createMockApp({
      jxa: async () => {
        throw new Error("boom");
      },
    });

    const result = await callTool(tools.read.handler, { list: "today" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("boom");
  });
});

describe("search", () => {
  test("requires at least one filter", async () => {
    const { tools } = createMockApp();
    const result = await callTool(tools.search.handler, {});
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("Provide query or tag");
  });

  test("passes query and tag filters through to jxa", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.search.handler, { query: "ship", tag: "ops" });
    expect(jxaCalls[0]?.args).toEqual({ q: "ship", t: "ops" });
    expect(jxaCalls[0]?.body).toContain('app.toDos.whose({name: {_contains: P.q}})()');
    expect(jxaCalls[0]?.body).toContain('tag.name() === P.t');
  });

  test("returns search errors from jxa", async () => {
    const { tools } = createMockApp({
      jxa: async () => {
        throw new Error("search failed");
      },
    });

    const result = await callTool(tools.search.handler, { query: "ship" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("search failed");
  });
});

describe("add_todo", () => {
  test("exposes strict date validation", () => {
    const { tools } = createMockApp();
    expect(() => tools.add_todo.inputSchema?.parse({ title: "x", when: "later" })).toThrow();
    expect(() => tools.add_todo.inputSchema?.parse({ title: "x", deadline: "2026-4-1" })).toThrow();
    expect(() => tools.add_todo.inputSchema?.parse({ title: "x", when: "2026-04-01" })).not.toThrow();
  });

  test("creates a todo without fallback when only jxa features are used", async () => {
    const { tools, jxaCalls, quietCalls, quietJsonCalls } = createMockApp({
      jxa: async () => '{"id":"todo-1","name":"Draft","status":"open"}',
    });

    const result = await callTool(tools.add_todo.handler, { title: "Draft", list: "Roadmap" });
    expect(textOf(result)).toBe('{"id":"todo-1","name":"Draft","status":"open"}');
    expect(jxaCalls[0]?.body).toContain("project.id();");
    expect(quietCalls).toHaveLength(0);
    expect(quietJsonCalls).toHaveLength(0);
  });

  test("requires auth before special-when, checklist, or comma-tag patching", async () => {
    const { tools, jxaCalls } = createMockApp({ token: "" });
    const result = await callTool(tools.add_todo.handler, {
      title: "Draft",
      tags: ["ops,urgent"],
    });

    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("THINGS_AUTH_TOKEN is required for this operation");
    expect(jxaCalls).toHaveLength(0);
  });

  test("applies json fallback and re-reads the created todo", async () => {
    let callIndex = 0;
    const { tools, jxaCalls, quietJsonCalls } = createMockApp({
      jxa: async () => {
        callIndex += 1;
        return callIndex === 1
          ? '{"id":"todo-1","name":"Draft","status":"open"}'
          : '{"id":"todo-1","name":"Draft","checklistItems":[{"name":"A","done":false}]}';
      },
    });

    const result = await callTool(tools.add_todo.handler, {
      title: "Draft",
      when: "someday",
      checklist_items: ["A"],
    });

    expect(textOf(result)).toContain('"checklistItems"');
    expect(quietJsonCalls).toEqual([
      {
        operations: [
          {
            type: "to-do",
            operation: "update",
            id: "todo-1",
            attributes: {
              when: "someday",
              "checklist-items": [
                {
                  type: "checklist-item",
                  attributes: { title: "A" },
                },
              ],
            },
          },
        ],
        reveal: undefined,
      },
    ]);
    expect(jxaCalls).toHaveLength(2);
  });
});

describe("add_project", () => {
  test("creates a project and validates the target area lookup in jxa", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => '{"id":"proj-1","name":"Launch","status":"open"}',
    });

    await callTool(tools.add_project.handler, {
      title: "Launch",
      area: "Work",
      todos: ["Ship it"],
    });

    expect(jxaCalls[0]?.body).toContain("area.id();");
    expect(jxaCalls[0]?.body).toContain("t.project = proj;");
  });

  test("uses json fallback for special-when project patches and re-reads", async () => {
    let callIndex = 0;
    const { tools, quietJsonCalls } = createMockApp({
      jxa: async () => {
        callIndex += 1;
        return callIndex === 1
          ? '{"id":"proj-1","name":"Launch","status":"open"}'
          : '{"id":"proj-1","name":"Launch","status":"open","todos":[]}';
      },
    });

    const result = await callTool(tools.add_project.handler, {
      title: "Launch",
      when: "evening",
    });

    expect(textOf(result)).toContain('"todos"');
    expect(quietJsonCalls).toEqual([
      {
        operations: [
          {
            type: "project",
            operation: "update",
            id: "proj-1",
            attributes: {
              when: "evening",
            },
          },
        ],
        reveal: undefined,
      },
    ]);
  });

  test("returns project creation errors", async () => {
    const { tools } = createMockApp({
      jxa: async () => {
        throw new Error("project failed");
      },
    });

    const result = await callTool(tools.add_project.handler, { title: "Launch" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("project failed");
  });
});

describe("update", () => {
  test("accepts empty deadline to clear an item", () => {
    const { tools } = createMockApp();
    expect(() => tools.update.inputSchema?.parse({ id: "1", deadline: "" })).not.toThrow();
    expect(() => tools.update.inputSchema?.parse({ id: "1", deadline: "tomorrow" })).toThrow();
    expect(() => tools.update.inputSchema?.parse({ id: "1", when: "" })).not.toThrow();
  });

  test("returns the updated item directly when no special fallback is needed", async () => {
    const { tools, jxaCalls, quietCalls, quietJsonCalls } = createMockApp({
      jxa: async () => '{"kind":"todo","item":{"id":"1","name":"Updated"}}',
    });

    const result = await callTool(tools.update.handler, {
      id: "1",
      title: "Updated",
      list: "Roadmap",
    });

    expect(textOf(result)).toBe('{"id":"1","name":"Updated"}');
    expect(jxaCalls[0]?.body).toContain('return JSON.stringify({kind: type, item:');
    expect(jxaCalls[0]?.body).toContain("project.id();");
    expect(quietCalls).toHaveLength(0);
    expect(quietJsonCalls).toHaveLength(0);
  });

  test("uses json for project special-when updates", async () => {
    let callIndex = 0;
    const { tools, quietJsonCalls, jxaCalls } = createMockApp({
      jxa: async () => {
        callIndex += 1;
        return callIndex === 1
          ? '{"kind":"project","item":{"id":"proj-1","name":"Launch"}}'
          : '{"id":"proj-1","name":"Launch","todos":[]}';
      },
    });

    const result = await callTool(tools.update.handler, {
      id: "proj-1",
      when: "someday",
    });

    expect(textOf(result)).toContain('"todos"');
    expect(quietJsonCalls).toEqual([
      {
        operations: [
          {
            type: "project",
            operation: "update",
            id: "proj-1",
            attributes: {
              when: "someday",
            },
          },
        ],
        reveal: undefined,
      },
    ]);
    expect(jxaCalls).toHaveLength(2);
  });

  test("clears when via direct update url", async () => {
    let callIndex = 0;
    const { tools, quietCalls } = createMockApp({
      jxa: async () => {
        callIndex += 1;
        return callIndex === 1
          ? '{"kind":"todo","item":{"id":"1","name":"Updated"}}'
          : '{"id":"1","name":"Updated","activationDate":null}';
      },
    });

    const result = await callTool(tools.update.handler, {
      id: "1",
      when: "",
    });

    expect(textOf(result)).toContain('"activationDate":null');
    expect(quietCalls).toEqual([
      {
        path: "update",
        params: {
          "auth-token": "token",
          id: "1",
          when: "",
        },
      },
    ]);
  });

  test("fails before mutating when special fallback lacks auth", async () => {
    const { tools, jxaCalls } = createMockApp({ token: "" });
    const result = await callTool(tools.update.handler, {
      id: "1",
      when: "anytime",
    });

    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("THINGS_AUTH_TOKEN is required for this operation");
    expect(jxaCalls).toHaveLength(0);
  });
});

describe("bulk_update", () => {
  test("requires auth before bulk json updates", async () => {
    const { tools, jxaCalls } = createMockApp({ token: "" });
    const result = await callTool(tools.bulk_update.handler, {
      ids: ["1"],
      title: "Updated",
    });

    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("THINGS_AUTH_TOKEN is required for this operation");
    expect(jxaCalls).toHaveLength(0);
  });

  test("updates many items with one json payload", async () => {
    const { tools, quietJsonCalls } = createMockApp({
      jxa: async () => '[{"id":"1","kind":"todo"},{"id":"2","kind":"project"}]',
    });

    const result = await callTool(tools.bulk_update.handler, {
      ids: ["1", "2"],
      title: "Updated",
      when: "someday",
    });

    expect(textOf(result)).toContain('"updated":true');
    expect(quietJsonCalls).toEqual([
      {
        operations: [
          {
            type: "to-do",
            operation: "update",
            id: "1",
            attributes: {
              title: "Updated",
              when: "someday",
            },
          },
          {
            type: "project",
            operation: "update",
            id: "2",
            attributes: {
              title: "Updated",
              when: "someday",
            },
          },
        ],
        reveal: undefined,
      },
    ]);
  });
});

describe("delete and trash", () => {
  test("deletes an item by id", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => '{"id":"1","kind":"todo","deleted":true}',
    });

    const result = await callTool(tools.delete.handler, { id: "1" });
    expect(textOf(result)).toBe('{"id":"1","kind":"todo","deleted":true}');
    expect(jxaCalls[0]?.body).toContain("app.delete(todo);");
  });

  test("empties trash", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => '{"emptied":true}',
    });

    const result = await callTool(tools.empty_trash.handler, {});
    expect(textOf(result)).toBe('{"emptied":true}');
    expect(jxaCalls[0]?.body).toContain("app.emptyTrash()");
  });
});

describe("show", () => {
  test("requires an id or query", async () => {
    const { tools } = createMockApp();
    const result = await callTool(tools.show.handler, {});
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("Provide id or query");
  });

  test("dispatches a background show url", async () => {
    const { tools, quietCalls } = createMockApp();
    const result = await callTool(tools.show.handler, { query: "Launch" });
    expect(textOf(result)).toBe("Showing: Launch");
    expect(quietCalls).toEqual([
      {
        path: "show",
        params: {
          id: undefined,
          query: "Launch",
        },
      },
    ]);
  });

  test("returns show errors from quietUrl", async () => {
    const { tools } = createMockApp({
      quietUrl: async () => {
        throw new Error("show failed");
      },
    });

    const result = await callTool(tools.show.handler, { id: "1" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("show failed");
  });
});
