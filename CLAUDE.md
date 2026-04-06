# cositas

Things 3 MCP server for macOS. Background read/write automation via JXA, with Things URL / JSON updates for the cases JXA does not cover cleanly.

## Stack

- Bun + TypeScript
- `@modelcontextprotocol/sdk`
- JXA via `osascript`
- Things URL / JSON commands for complex writes
- Narrow SQLite read assist for large built-in lists

## Tools

- `read`
- `search`
- `add_todo`
- `add_project`
- `update`
- `bulk_update`
- `delete`
- `empty_trash`
- `show`

## Notes

- Primary read/write path is JXA against Things.
- Bulk updates, special `when` values, checklist writes, and comma-containing tag writes use Things URL / JSON updates and require `THINGS_AUTH_TOKEN`.
- `logbook` and `trash` can use the local Things SQLite DB to page/filter IDs quickly, then hydrate final item details through JXA.
- Built-in list reads can include both todos and projects. Mixed ordering uses DB sort keys when available.
- Exact area reads still use project filtering because `area.projects()` is unreliable in JXA here.

## Config

- `THINGS_AUTH_TOKEN`
- `THINGS_APP_PATH`
- `THINGS_FAST_READS`
- `THINGS_DB_PATH`

## Development

- `bun test`
- `bun test --coverage`

The test suite is mocked. It does not perform live Things writes.
