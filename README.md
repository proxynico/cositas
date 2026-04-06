# cositas

A [Things 3](https://culturedcode.com/things/) MCP server for macOS. Gives your AI assistant full read/write access to Things — without ever stealing focus from whatever you're doing.

Things has no public API. cositas bridges that gap using JXA via `osascript` for most operations, and Things URL/JSON commands for the few write cases JXA can't handle cleanly.

## Tools

| Tool | What it does |
|------|-------------|
| `read` | Read a built-in list, project, area, or single item by ID |
| `search` | Find open todos by name or tag |
| `add_todo` | Create a todo with notes, deadlines, tags, checklists, list placement |
| `add_project` | Create a project with child todos, area placement, and all the trimmings |
| `update` | Update any item by ID (auto-detects todo vs project) |
| `bulk_update` | Update many items in one call |
| `delete` | Move an item to Trash |
| `empty_trash` | Permanently clear Trash |
| `show` | Navigate Things to a list, project, or item in the background |

## Setup

You need macOS, [Things 3](https://culturedcode.com/things/), and [Bun](https://bun.sh).

```bash
git clone https://github.com/proxynico/cositas.git
cd cositas
bun install
```

Register in your MCP client:

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

Get the auth token from Things: **Settings > General > Enable Things URLs**.

## Environment

| Variable | Required | What it does |
|----------|----------|--------------|
| `THINGS_AUTH_TOKEN` | For some writes | Bulk updates, special `when` values, checklist writes, comma-containing tags |
| `THINGS_APP_PATH` | No | Override Things path (default: `/Applications/Things3.app`) |
| `THINGS_FAST_READS` | No | Set `0` to disable SQLite fast path for `logbook`/`trash` |
| `THINGS_DB_PATH` | No | Override auto-detected Things SQLite path |

## How it works

**JXA** handles most reads and writes. Arguments go in as JSON, not string-interpolated script fragments.

**Things URL/JSON commands** handle the cases JXA doesn't cover well: bulk updates, checklist writes, and scheduling edge cases like `evening`, `anytime`, and `someday`.

**SQLite** (read-only, opt-in) accelerates large `logbook` and `trash` reads by querying IDs from the local DB, then hydrating details through Things automation.

## Development

```bash
bun test
bun test --coverage
```

Tests are fully mocked. No live Things writes, no macOS required to run them.

## Limitations

- macOS only (it's a Things 3 server, after all)
- Bulk updates and some write operations require `THINGS_AUTH_TOKEN`
- Mixed list ordering depends on Things DB internals for `upcoming` and `today`

## License

MIT
