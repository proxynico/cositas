# cositas

MCP server for [Things 3](https://culturedcode.com/things/) on macOS.

It gives an AI assistant background read/write access to Things without foregrounding the app. Reads come back as JSON, writes return IDs, and the server stays close to Things' supported automation surface instead of doing direct database writes.

## Why it exists

Things has no public API.

- `things:///` is good for commands, but not for reading data.
- Direct SQLite is fast, but brittle for writes.

`cositas` uses JXA via `osascript` for the main interface, then uses Things' URL / JSON commands only for the write cases JXA does not cover well.

## What it can do

- `read`: read a built-in list, project, area, or item by ID
- `search`: search open todos by name or tag
- `add_todo`: create todos with notes, deadlines, tags, list placement, and checklist items
- `add_project`: create projects with notes, deadlines, tags, area placement, and child todos
- `update`: update one item by ID
- `bulk_update`: update many items in one call
- `delete`: move a todo, project, or area to Trash
- `empty_trash`: permanently clear Trash
- `show`: navigate Things in the background

Built-in list reads can include both todos and projects. Mixed ordering uses local DB sort keys when available. All tool responses are JSON.

## Setup

Requirements:

- macOS
- [Things 3](https://culturedcode.com/things/)
- [Bun](https://bun.sh)

Install:

```bash
git clone https://github.com/proxynico/cositas.git
cd cositas
bun install
```

Register it in your MCP client:

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

Environment:

| Variable | Required | Purpose |
|----------|----------|---------|
| `THINGS_AUTH_TOKEN` | Sometimes | Needed for JSON / URL updates: bulk updates, special `when` values, clearing `when`, checklist writes, and comma-containing tag writes |
| `THINGS_APP_PATH` | No | Override the Things app path. Default: `/Applications/Things3.app` |
| `THINGS_FAST_READS` | No | Set to `0` to disable the SQLite fast path for large `logbook` / `trash` reads |
| `THINGS_DB_PATH` | No | Override the detected Things SQLite path for fast reads |

Get the auth token from Things: `Settings -> General -> Enable Things URLs`.

## How it works

- JXA via `osascript` is the primary read/write path.
- Things URL / JSON commands handle complex writes like bulk updates, checklist writes, and special `when` values.
- Large `logbook` and `trash` reads can use a narrow SQLite fast path for paging/filtering IDs, then hydrate the final item details through Things automation.

Arguments are passed into JXA as JSON, not string-interpolated script fragments.

## Examples

- "What's on my Today list?"
- "Find all open todos tagged urgent"
- "Create a todo Review Q2 budget with deadline 2026-04-15 in Finance"
- "Move this item to Someday"
- "Bulk-complete these IDs"
- "Show the Launch project"

## Development

```bash
bun test
bun test --coverage
```

The test suite mocks the runtime. It does not execute live writes against a real Things database.

## Limitations

- macOS only
- Bulk updates still require `THINGS_AUTH_TOKEN`
- `logbook` / `trash` are faster now, but final item hydration still goes through Things automation
- Mixed built-in list ordering still depends on Things internals, especially for `upcoming`

## License

MIT
