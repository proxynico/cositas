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
- **Area read via project filter**: JXA's `area.projects()` throws "Can't get object" (JXA limitation). We filter all projects by area name with substring matching instead. This also handles emoji-prefixed area names (e.g., searching "LP Global" matches "LP Global").
- **Status changes in JXA**: `item.status = "completed"` works in JXA despite status being an AppleScript enum. Tested on macOS 15 (Sequoia).
- **quietUrl for show**: JXA's `app.show()` activates the app window. `quietUrl` dispatches via NSWorkspace with `activates=false`.
- **quietUrl for when=someday/anytime/evening**: JXA's `schedule` command only takes dates. These special values require the URL scheme.
- **Checklist items via URL scheme**: JXA can't create checklist items on new todos. Created via quietUrl post-create patch using `append-checklist-items`.

## Known limitations

- **Tag names with commas**: Things 3's `tagNames` property is comma-separated. Tags containing commas will be split incorrectly. No workaround without using a different API to set tags individually.
- **`when` cannot be cleared**: Neither JXA nor URL scheme support removing activation dates (un-scheduling a todo). Would require direct SQLite writes.
- **Logbook can be very large**: `read(list: "logbook")` returns all completed items. No date-range or limit parameter yet.
- **macOS only**: Uses `osascript` and Things 3 Apple Events.
- **No delete**: Todos can be canceled (`update` with `canceled: true`) but not permanently deleted (moved to Trash).
- **No bulk update/complete**: Updates are one-at-a-time by ID. Bulk operations require multiple calls.

## Configuration

Registered in `~/.mcp.json` as `cositas`. Auth token set via `THINGS_AUTH_TOKEN` env var (needed for quietUrl fallback operations only).
