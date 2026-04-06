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
}: {
  token?: string;
  jxa?: (body: string, args?: Record<string, unknown>) => Promise<string> | string;
  quietUrl?: (path: string, params: Record<string, string | undefined>) => Promise<void> | void;
} = {}) {
  const jxaCalls: Call[] = [];
  const quietCalls: Array<{ path: string; params: Record<string, string | undefined> }> = [];

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
  };

  const { tools } = createServer(runtime);
  return { tools, jxaCalls, quietCalls };
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
    expect(jxaCalls[0]?.args).toEqual({ n: LIST_NAMES.today });
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
    expect(jxaCalls[0]?.args).toEqual({ n: "Launch" });
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
    expect(jxaCalls[0]?.body).toContain("f.name = {_contains: P.q};");
    expect(jxaCalls[0]?.body).toContain("f.tagNames = {_contains: P.t};");
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
    const { tools, jxaCalls, quietCalls } = createMockApp({
      jxa: async () => '{"id":"todo-1","name":"Draft","status":"open"}',
    });

    const result = await callTool(tools.add_todo.handler, { title: "Draft", list: "Roadmap" });
    expect(textOf(result)).toBe('{"id":"todo-1","name":"Draft","status":"open"}');
    expect(jxaCalls[0]?.body).toContain("project.id();");
    expect(quietCalls).toHaveLength(0);
  });

  test("requires auth before special-when or checklist fallback", async () => {
    const { tools, jxaCalls } = createMockApp({ token: "" });
    const result = await callTool(tools.add_todo.handler, {
      title: "Draft",
      when: "someday",
    });

    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("THINGS_AUTH_TOKEN is required for this operation");
    expect(jxaCalls).toHaveLength(0);
  });

  test("applies quiet fallback and re-reads the created todo", async () => {
    let callIndex = 0;
    const { tools, jxaCalls, quietCalls } = createMockApp({
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
    expect(quietCalls).toEqual([
      {
        path: "update",
        params: {
          "auth-token": "token",
          id: "todo-1",
          when: "someday",
          "append-checklist-items": "A",
        },
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

  test("uses update-project for special-when fallback and re-reads the project", async () => {
    let callIndex = 0;
    const { tools, quietCalls } = createMockApp({
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
    expect(quietCalls).toEqual([
      {
        path: "update-project",
        params: {
          "auth-token": "token",
          id: "proj-1",
          when: "evening",
        },
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
  });

  test("returns the updated item directly when no special fallback is needed", async () => {
    const { tools, jxaCalls, quietCalls } = createMockApp({
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
  });

  test("uses update-project for project special-when updates", async () => {
    let callIndex = 0;
    const { tools, quietCalls, jxaCalls } = createMockApp({
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
    expect(quietCalls).toEqual([
      {
        path: "update-project",
        params: {
          "auth-token": "token",
          id: "proj-1",
          when: "someday",
        },
      },
    ]);
    expect(jxaCalls).toHaveLength(2);
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
