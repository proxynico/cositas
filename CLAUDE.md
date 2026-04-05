# cositas

MCP server for Things 3 on macOS. Gives Claude Code the ability to create, update, and navigate tasks and projects in Things 3 via the [URL scheme API](https://culturedcode.com/things/support/articles/2803573/).

## Stack

- Bun + TypeScript
- `@modelcontextprotocol/sdk` (stdio transport)
- Things 3 URL scheme (`things:///`) executed via `open` on macOS

## How it works

Every tool builds a `things:///command?params` URL and fires it with `execFile("open", [url])`. Auth token is injected via `THINGS_AUTH_TOKEN` env var for update operations. All calls are fire-and-forget — the URL scheme doesn't return data.

## Tools (8)

| Tool | What it does |
|------|-------------|
| `add_todo` | Create one or many to-dos (single title or bulk via `titles`) |
| `add_project` | Create a project with optional child to-dos |
| `update_todo` | Modify an existing to-do by ID (requires auth token) |
| `update_project` | Modify an existing project by ID (requires auth token) |
| `show` | Navigate to a list (`today`, `inbox`, etc.) or item by ID/name |
| `search` | Open Things search with optional query |
| `add_json` | Bulk/complex operations using Things 3 JSON spec |

## Configuration

Registered in `~/.mcp.json` as `cositas`. Auth token set in env.

## Current status

**v0.1.0 — write-only, not yet tested**

- All write/navigate tools implemented against the full URL scheme spec
- No read capability — the URL scheme cannot list or query existing tasks
- Fire-and-forget execution — no confirmation of success or created IDs returned
- Not yet tested end-to-end (need to restart Claude Code to load the MCP server)

## Known limitations

- **No reads.** Can't list todos, projects, areas, or tags. The URL scheme is write/navigate only. To add reads, we'd need AppleScript (JXA via `osascript`) or direct SQLite access to the Things database.
- **No return values.** `open` doesn't capture x-callback-url responses, so we don't get back created item IDs. Updates require knowing the ID upfront.
- **macOS only.** Uses `open` to dispatch URL schemes.

## Next steps

- [ ] Test all tools end-to-end
- [ ] Add read capability (AppleScript or SQLite) for listing todos/projects/areas/tags
- [ ] Consider capturing x-callback-url responses for created IDs
