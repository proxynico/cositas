# cositas

MCP server for [Things 3](https://culturedcode.com/things/) on macOS. Full read and write access to your tasks without ever foregrounding the app.

Built for AI assistants (Claude, GPT, etc.) that support the [Model Context Protocol](https://modelcontextprotocol.io). Your assistant can read your task list, create todos, update projects, and navigate the app -- all in the background.

## Why

Things 3 has no official API. The two common workarounds each have problems:

- **URL scheme** (`things:///`): Always foregrounds the app. Cannot return data.
- **Direct SQLite**: Read-only. Breaks when Things changes its schema. Depends on finding the database file.

cositas uses **JXA** (JavaScript for Automation) via Apple Events. This gives full read/write access, returns structured data, and never activates the Things window. For the few operations JXA can't handle (scheduling to someday/anytime/evening, checklist items), it falls back to URL scheme dispatch via `NSWorkspace` with `activates = false` -- still no foreground.

## Tools

| Tool | Description |
|------|-------------|
| `read` | Read todos from any list, project, area, or by ID. Returns JSON with full details. |
| `search` | Search open todos by name or tag. |
| `add_todo` | Create a todo with tags, deadline, scheduling, checklist items, and project assignment. |
| `add_project` | Create a project with optional child todos. |
| `update` | Update any item by ID: title, notes, tags, deadline, scheduling, status, move between projects/areas. |
| `show` | Navigate the Things 3 UI to any list, project, area, or item (background URL dispatch). |

All tools return JSON with item IDs, so your assistant can chain operations (create a todo, then update it, then move it).

## Setup

### Requirements

- macOS (uses `osascript` and Apple Events)
- [Things 3](https://culturedcode.com/things/)
- [Bun](https://bun.sh)

### Install

```bash
git clone https://github.com/proxynico/cositas.git
cd cositas
bun install
```

### Register as an MCP server

Add to your MCP client config (e.g. `~/.mcp.json` for Claude Code, or your client's MCP settings):

```json
{
  "mcpServers": {
    "cositas": {
      "command": "bun",
      "args": ["run", "/path/to/cositas/src/index.ts"],
      "env": {
        "THINGS_AUTH_TOKEN": "your-token-here"
      }
    }
  }
}
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `THINGS_AUTH_TOKEN` | For some operations | Auth token from Things 3 settings. Needed for URL-scheme fallback operations: scheduling to `anytime`, `someday`, or `evening`, and adding checklist items. |
| `THINGS_APP_PATH` | No | Override the Things app bundle path. Defaults to `/Applications/Things3.app`. |

To get your auth token: Things 3 > Settings > General > Enable Things URLs > copy the token.

## How it works

```
MCP Client (Claude, etc.)
    |
    | stdio (JSON-RPC)
    v
cositas (Bun + TypeScript)
    |
    |-- JXA via osascript (primary engine)
    |   Uses Apple Events to talk to Things 3.
    |   Never foregrounds the app.
    |   Returns JSON via stdout.
    |
    |-- NSWorkspace URL dispatch (fallback)
        For operations JXA can't handle natively.
        Dispatches things:// URLs with activates=false.
        Used for: someday/anytime/evening scheduling,
        checklist items, UI navigation.
```

Arguments are passed to JXA as `argv[0]` (JSON-serialized), avoiding string interpolation and injection issues.

## Usage examples

Once registered, your AI assistant can do things like:

**Read your today list:**
> "What's on my Things today list?"

**Create a todo with a deadline:**
> "Add a todo 'Review Q2 budget' with deadline 2026-04-15 in my Finance project"

**Search by tag:**
> "Find all todos tagged 'urgent'"

**Update a todo:**
> "Mark that todo as completed" / "Move it to the Someday list"

**Create a project with child todos:**
> "Create a project 'Website Redesign' with todos: wireframes, design review, implementation"

## Development

```bash
bun test              # run test suite
bun test --coverage   # with coverage
```

The test suite mocks the JXA runtime and covers all tool handlers. It does not run live operations against a real Things database.

## Known limitations

- **macOS only** -- relies on `osascript` and Apple Events
- **No delete** -- todos can be canceled but not moved to Trash (Things API limitation)
- **No bulk operations** -- updates are one-at-a-time by ID
- **Tag commas** -- tags containing commas will be split incorrectly (Things uses comma-separated `tagNames`)
- **`when` cannot be cleared** -- neither JXA nor URL scheme support removing activation dates
- **Large logbooks** -- `read(list: "logbook")` returns all completed items with no pagination

## License

MIT
