# cositas

MCP server for Things 3 on macOS. Full read + write access without foregrounding the app.

## Stack

- Bun + TypeScript
- `@modelcontextprotocol/sdk` (stdio transport)
- JXA (JavaScript for Automation) via `osascript` — primary engine
- NSWorkspace silent URL dispatch — fallback for JXA edge cases

## How it works

All interaction goes through `osascript -l JavaScript`. JXA talks to Things 3 via Apple Events, which never activates or foregrounds the app. Data comes back as JSON via stdout. Args are passed as `argv[0]` (JSON-serialized), avoiding string interpolation issues.

Two helpers in the JXA scope serialize items: `todoOf(t)` and `projectOf(p)`.

For features JXA can't handle natively, a `things:///` URL is dispatched via `NSWorkspace.openURL` with `NSWorkspaceOpenConfiguration.activates = false` — still no foreground.

Things 3 is only contacted when a tool is actually called — the server starts without touching the app. If Apple Events are blocked by a sandboxed `osascript` environment, individual tool calls will return clear error messages.

## Tools (6)

| Tool | What it does |
|------|-------------|
| `read` | Read todos from any list, project, area, or single item by ID. Returns JSON with IDs. |
| `search` | Search open todos by name or tag. Returns JSON. |
| `add_todo` | Create a todo (with tags, deadline, scheduling, checklist). Returns created item with ID. |
| `add_project` | Create a project with optional child todos. Returns created item with ID. |
| `update` | Update any item by ID: title, notes, tags, deadline, when, status, move. |
| `show` | Navigate Things 3 UI (via quiet URL dispatch). |

## Architecture decisions

- **JXA over URL scheme**: URL scheme (`things:///`) always foregrounds Things 3 via `open`. JXA via Apple Events does not. JXA also returns data, which the URL scheme cannot.
- **JXA over SQLite**: Both reference implementations (things-api, Things3-MCP) use direct SQLite reads. JXA is slower for bulk reads but doesn't depend on database file paths, works for both reads and writes, and won't break if Things changes its schema.
- **Exact area reads via project filter**: JXA's `area.projects()` throws "Can't get object" (JXA limitation). We filter all projects and keep exact `p.area().name() === target` matches instead. This avoids ambiguous substring matches such as `Work` vs `Work Admin`.
- **Status changes in JXA**: `item.status = "completed"` works in JXA despite status being an AppleScript enum. Tested on macOS 15 (Sequoia).
- **quietUrl for show**: JXA's `app.show()` activates the app window. `quietUrl` dispatches via NSWorkspace with `activates=false`.
- **quietUrl for when=someday/anytime/evening**: JXA's `schedule` command only takes dates. These special values require the URL scheme.
- **Checklist items via URL scheme**: JXA can't create checklist items on new todos. Created via quietUrl post-create patch using `append-checklist-items`.
- **Path-based app binding**: JXA now targets `THINGS_APP_PATH` and defaults to `/Applications/Things3.app`. Name-based resolution (`Application("Things3")`) was not reliable in this environment.
- **Fail-fast fallback auth**: URL-scheme-only operations now require `THINGS_AUTH_TOKEN` before mutating anything, so the server does not partially create/update items and only then discover it cannot finish the operation.
- **Final-state returns after fallback writes**: Mutations that need quiet URL patches re-read the item afterward and return the final state rather than the pre-patch JXA snapshot.

## Known limitations

- **Tag names with commas**: Things 3's `tagNames` property is comma-separated. Tags containing commas will be split incorrectly. No workaround without using a different API to set tags individually.
- **`when` cannot be cleared**: Neither JXA nor URL scheme support removing activation dates (un-scheduling a todo). Would require direct SQLite writes.
- **Logbook can be very large**: `read(list: "logbook")` returns all completed items. No date-range or limit parameter yet.
- **macOS only**: Uses `osascript` and Things 3 Apple Events.
- **Codex sandbox cannot run live Things automation**: inside this environment, sandboxed `osascript` is denied `mach-lookup` to `com.apple.hiservices-xpcservice`. Live Things reads and writes work only outside that sandbox.
- **No delete**: Todos can be canceled (`update` with `canceled: true`) but not permanently deleted (moved to Trash).
- **No bulk update/complete**: Updates are one-at-a-time by ID. Bulk operations require multiple calls.

## Configuration

Registered in `~/.mcp.json` as `cositas`.

- `THINGS_AUTH_TOKEN`: required for URL-scheme fallback operations only (`when=anytime|someday|evening`, checklist item patches).
- `THINGS_APP_PATH`: optional override for the Things app bundle path. Defaults to `/Applications/Things3.app`.

## Development

- `bun test`: run the mocked handler/unit suite.
- `bun test --coverage`: run the suite with coverage.
- `bun build src/index.ts --target bun --outdir /tmp/cositas-audit`: compile-check the runtime entrypoint.

The automated suite fully covers the server logic, but it does not run live write operations against a real Things database.
