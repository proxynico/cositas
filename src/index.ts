#!/usr/bin/env bun
// cositas — Things 3 MCP server
// Reads are SQLite-first where that helps; writes stay on the Things runtime boundary.

import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ThingsRuntime } from "./shared";
import { createRuntime, verifyThingsAccess } from "./runtime";
import { registerTools } from "./tools";

export type { ExecFn, ExecResult, RuntimeInspection, ThingsRuntime } from "./shared";
export {
  buildJsonUpdateOperation,
  deadlineSchema,
  errmsg,
  isSandboxAutomationError,
  LIST_NAMES,
  normalizeThingsJson,
  normalizeThingsValue,
  updateDeadlineSchema,
  updateWhenSchema,
  whenSchema,
} from "./shared";
export { createRuntime, verifyThingsAccess } from "./runtime";
export { registerTools } from "./tools";

export function createServer(runtime: ThingsRuntime = createRuntime()): {
  server: McpServer;
  tools: Record<string, RegisteredTool>;
} {
  const server = new McpServer({ name: "cositas", version: "0.2.1" });
  const tools = registerTools(server, runtime);
  return { server, tools };
}

/* v8 ignore next 4 */
if (import.meta.main) {
  const runtime = createRuntime();
  await verifyThingsAccess(runtime);
  const transport = new StdioServerTransport();
  const { server } = createServer(runtime);
  await server.connect(transport);
}
