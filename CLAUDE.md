# cositas

Things 3 MCP server for macOS. Background read/write automation via JXA, with Things URL / JSON updates for the cases JXA does not cover cleanly.

## Stack

- Bun + TypeScript
- `@modelcontextprotocol/sdk`
- JXA via `osascript`
- Things URL / JSON commands for complex writes
- Narrow SQLite read assist for large built-in lists

## Tools

- `doctor`
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

- Reads are trending SQLite-first; JXA is the runtime boundary, not the whole architecture.
- Bulk updates, special `when` values, checklist writes, and comma-containing tag writes use Things URL / JSON updates and require `THINGS_AUTH_TOKEN`.
- If `completed` and `canceled` both arrive in a bulk update, `canceled` wins to match single-item `update`.
- `logbook` and `trash` can use the local Things SQLite DB to page/filter IDs quickly, then hydrate final item details through JXA.
- Built-in list reads can include both todos and projects. Mixed ordering uses DB sort keys when available, and pagination is applied after that ordering.
- Returned item payloads normalize terminal timestamps so completed items keep `completionDate`, canceled items keep `cancellationDate`, and clients do not have to reconcile both.
- Exact area reads still use project filtering because `area.projects()` is unreliable in JXA here.
- Process startup performs a read-only access probe so automation permission or app-path problems fail immediately.
- `doctor` exposes the same checks on demand without mutating Things data. Missing `THINGS_AUTH_TOKEN` degrades write capability but does not mark the whole server unhealthy if reads still work.

## Config

- `THINGS_AUTH_TOKEN`
- `THINGS_APP_PATH`
- `THINGS_FAST_READS`
- `THINGS_DB_PATH`

`THINGS_AUTH_TOKEN` is optional for read-only use.

## Development

- `bun test`
- `bun test --coverage`

The test suite is mocked. It does not perform live Things writes.
