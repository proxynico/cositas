#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const AUTH_TOKEN = process.env.THINGS_AUTH_TOKEN ?? "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUrl(
  command: string,
  params: Record<string, string | undefined>,
): string {
  const query = Object.entries(params)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `things:///${command}${query ? `?${query}` : ""}`;
}

async function things(
  command: string,
  params: Record<string, string | undefined>,
): Promise<string> {
  const url = buildUrl(command, params);
  try {
    await execFileAsync("open", [url]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to open Things URL: ${msg}`);
  }
  return url;
}

function s(v: string | boolean | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.join(",");
  return v;
}

function nl(v: string[] | undefined): string | undefined {
  return v?.join("\n");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "trinket",
  version: "0.1.0",
});

// ---- Add To-Do ----------------------------------------------------------

server.tool(
  "add_todo",
  "Create a to-do in Things 3. Supports single or bulk creation.",
  {
    title: z.string().optional().describe("To-do title (single)"),
    titles: z
      .array(z.string())
      .optional()
      .describe("Multiple to-do titles (bulk). Common params apply to all."),
    notes: z.string().optional(),
    when: z
      .string()
      .optional()
      .describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd"),
    deadline: z.string().optional().describe("yyyy-mm-dd"),
    tags: z.array(z.string()).optional(),
    checklist_items: z.array(z.string()).optional(),
    list: z.string().optional().describe("Project or area name"),
    list_id: z.string().optional().describe("Project or area ID"),
    heading: z.string().optional().describe("Heading within a project"),
    completed: z.boolean().optional(),
    canceled: z.boolean().optional(),
    show_quick_entry: z
      .boolean()
      .optional()
      .describe("Show quick-entry dialog instead of adding directly"),
    reveal: z.boolean().optional(),
  },
  async (params) => {
    if (!params.title && !params.titles?.length) {
      return {
        content: [{ type: "text" as const, text: "Error: provide title or titles" }],
        isError: true,
      };
    }
    await things("add", {
      title: params.title,
      titles: nl(params.titles),
      notes: params.notes,
      when: params.when,
      deadline: params.deadline,
      tags: s(params.tags),
      "checklist-items": nl(params.checklist_items),
      list: params.list,
      "list-id": params.list_id,
      heading: params.heading,
      completed: s(params.completed),
      canceled: s(params.canceled),
      "show-quick-entry": s(params.show_quick_entry),
      reveal: s(params.reveal),
    });
    const label = params.titles
      ? `Created ${params.titles.length} to-dos`
      : `Created to-do: "${params.title}"`;
    return { content: [{ type: "text" as const, text: label }] };
  },
);

// ---- Add Project --------------------------------------------------------

server.tool(
  "add_project",
  "Create a project in Things 3 with optional to-dos.",
  {
    title: z.string().describe("Project title"),
    notes: z.string().optional(),
    when: z
      .string()
      .optional()
      .describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd"),
    deadline: z.string().optional().describe("yyyy-mm-dd"),
    tags: z.array(z.string()).optional(),
    area: z.string().optional().describe("Area name"),
    area_id: z.string().optional().describe("Area ID"),
    todos: z.array(z.string()).optional().describe("To-do titles inside the project"),
    completed: z.boolean().optional(),
    canceled: z.boolean().optional(),
    reveal: z.boolean().optional(),
  },
  async (params) => {
    await things("add-project", {
      title: params.title,
      notes: params.notes,
      when: params.when,
      deadline: params.deadline,
      tags: s(params.tags),
      area: params.area,
      "area-id": params.area_id,
      "to-dos": nl(params.todos),
      completed: s(params.completed),
      canceled: s(params.canceled),
      reveal: s(params.reveal),
    });
    return {
      content: [{ type: "text" as const, text: `Created project: "${params.title}"` }],
    };
  },
);

// ---- Update To-Do -------------------------------------------------------

server.tool(
  "update_todo",
  "Update an existing to-do in Things 3 by ID.",
  {
    id: z.string().describe("To-do ID"),
    title: z.string().optional(),
    notes: z.string().optional().describe("Replace notes entirely"),
    prepend_notes: z.string().optional(),
    append_notes: z.string().optional(),
    when: z.string().optional(),
    deadline: z.string().optional().describe("yyyy-mm-dd (empty string to clear)"),
    tags: z.array(z.string()).optional().describe("Replace all tags"),
    add_tags: z.array(z.string()).optional().describe("Add to existing tags"),
    checklist_items: z.array(z.string()).optional().describe("Replace checklist"),
    prepend_checklist_items: z.array(z.string()).optional(),
    append_checklist_items: z.array(z.string()).optional(),
    list: z.string().optional().describe("Move to project/area by name"),
    list_id: z.string().optional(),
    heading: z.string().optional(),
    heading_id: z.string().optional(),
    completed: z.boolean().optional(),
    canceled: z.boolean().optional(),
    reveal: z.boolean().optional(),
  },
  async (params) => {
    await things("update", {
      "auth-token": AUTH_TOKEN,
      id: params.id,
      title: params.title,
      notes: params.notes,
      "prepend-notes": params.prepend_notes,
      "append-notes": params.append_notes,
      when: params.when,
      deadline: params.deadline,
      tags: s(params.tags),
      "add-tags": s(params.add_tags),
      "checklist-items": nl(params.checklist_items),
      "prepend-checklist-items": nl(params.prepend_checklist_items),
      "append-checklist-items": nl(params.append_checklist_items),
      list: params.list,
      "list-id": params.list_id,
      heading: params.heading,
      "heading-id": params.heading_id,
      completed: s(params.completed),
      canceled: s(params.canceled),
      reveal: s(params.reveal),
    });
    return { content: [{ type: "text" as const, text: `Updated to-do: ${params.id}` }] };
  },
);

// ---- Update Project -----------------------------------------------------

server.tool(
  "update_project",
  "Update an existing project in Things 3 by ID.",
  {
    id: z.string().describe("Project ID"),
    title: z.string().optional(),
    notes: z.string().optional(),
    prepend_notes: z.string().optional(),
    append_notes: z.string().optional(),
    when: z.string().optional(),
    deadline: z.string().optional(),
    tags: z.array(z.string()).optional(),
    add_tags: z.array(z.string()).optional(),
    area: z.string().optional().describe("Move to area by name"),
    area_id: z.string().optional(),
    completed: z.boolean().optional(),
    canceled: z.boolean().optional(),
    reveal: z.boolean().optional(),
  },
  async (params) => {
    await things("update-project", {
      "auth-token": AUTH_TOKEN,
      id: params.id,
      title: params.title,
      notes: params.notes,
      "prepend-notes": params.prepend_notes,
      "append-notes": params.append_notes,
      when: params.when,
      deadline: params.deadline,
      tags: s(params.tags),
      "add-tags": s(params.add_tags),
      area: params.area,
      "area-id": params.area_id,
      completed: s(params.completed),
      canceled: s(params.canceled),
      reveal: s(params.reveal),
    });
    return {
      content: [{ type: "text" as const, text: `Updated project: ${params.id}` }],
    };
  },
);

// ---- Show ---------------------------------------------------------------

server.tool(
  "show",
  "Navigate to a list, project, area, tag, or to-do in Things 3.",
  {
    id: z
      .string()
      .optional()
      .describe(
        "Item ID or built-in list: inbox, today, anytime, upcoming, someday, logbook, tomorrow, deadlines, repeating, all-projects, logged-projects",
      ),
    query: z.string().optional().describe("Name of area, project, or tag"),
    filter: z.string().optional().describe("Comma-separated tag names to filter by"),
  },
  async (params) => {
    if (!params.id && !params.query) {
      return {
        content: [{ type: "text" as const, text: "Error: provide id or query" }],
        isError: true,
      };
    }
    await things("show", {
      id: params.id,
      query: params.query,
      filter: params.filter,
    });
    return {
      content: [
        { type: "text" as const, text: `Showing: ${params.id ?? params.query}` },
      ],
    };
  },
);

// ---- Search -------------------------------------------------------------

server.tool(
  "search",
  "Open Things 3 search with an optional query.",
  {
    query: z.string().optional(),
  },
  async (params) => {
    await things("search", { query: params.query });
    return {
      content: [
        {
          type: "text" as const,
          text: params.query ? `Searching: "${params.query}"` : "Opened search",
        },
      ],
    };
  },
);

// ---- JSON (bulk / advanced) ---------------------------------------------

server.tool(
  "add_json",
  "Execute bulk or complex operations using Things 3 JSON format. Supports creating/updating multiple to-dos and projects with headings, checklist items, etc.",
  {
    data: z.string().describe("JSON array of item objects per Things 3 JSON spec"),
    reveal: z.boolean().optional().describe("Navigate to first created item"),
  },
  async (params) => {
    try {
      JSON.parse(params.data);
    } catch {
      return {
        content: [{ type: "text" as const, text: "Error: invalid JSON" }],
        isError: true,
      };
    }
    await things("json", {
      data: params.data,
      "auth-token": AUTH_TOKEN,
      reveal: s(params.reveal),
    });
    return { content: [{ type: "text" as const, text: "Executed JSON command" }] };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
