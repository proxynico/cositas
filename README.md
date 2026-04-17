# cositas

Things 3 has no API. Now it does.

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants full read/write access to [Things 3](https://culturedcode.com/things/) on macOS. Runs entirely in the background — Things never steals focus, your AI never loses context.

## What it can do

| Tool | |
|------|--|
| `doctor` | Run a non-mutating health check for app access, auth-token setup, and fast-read availability |
| `read` | Pull any list, project, area, or item. Built-in lists are ordered before pagination, and terminal dates are normalized. |
| `search` | Find open todos by name or tag |
| `add_todo` | Create todos with notes, deadlines, tags, checklists, project placement |
| `add_project` | Create projects with child todos and area placement |
| `update` | Change any item by ID — figures out if it's a todo or project on its own |
| `bulk_update` | Update a pile of items in one shot. If `completed` and `canceled` conflict, `canceled` wins. |
| `delete` | Trash it |
| `empty_trash` | Really trash it |
| `show` | Point Things at something without yanking it to the foreground |

## Setup

You need macOS, [Things 3](https://culturedcode.com/things/), and [Bun](https://bun.sh). That's it.

```bash
git clone https://github.com/proxynico/cositas.git
cd cositas
bun install
```

Add to your MCP client config:

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

Grab the auth token from Things: **Settings > General > Enable Things URLs**.

If you only need reads, you can omit `THINGS_AUTH_TOKEN`. The server still starts, `doctor` still reports read health, and write paths that rely on Things URL / JSON updates stay unavailable until the token is configured.

## Configuration

| Variable | Required | |
|----------|----------|-|
| `THINGS_AUTH_TOKEN` | Only for some writes | Bulk updates, special scheduling (`evening`, `anytime`, `someday`), checklists, tags with commas. Read-only mode works without it. |
| `THINGS_APP_PATH` | No | If Things isn't where it usually is. Default: `/Applications/Things3.app` |
| `THINGS_FAST_READS` | No | Set to `0` if you don't want SQLite-accelerated `logbook`/`trash` reads |
| `THINGS_DB_PATH` | No | Override the auto-detected Things database path |

## Under the hood

**SQLite-first reads** handle the heavy list work where Things stores the truth locally. Fast paths use the Things database for paging, filtering, and ordering, then hydrate final item shapes through the runtime boundary when needed. Built-in list reads apply ordering before `limit` / `offset`, so pagination follows the same order you would expect from Things.

**Things URL/JSON commands** are the primary write fallback for bulk updates, checklists, comma-containing tags, and scheduling values that JXA does not model cleanly.

**JXA** is now the thin macOS runtime boundary: item hydration, direct app actions, and the few operations where the URL/JSON path is not a clean fit.

**Item normalization** keeps terminal state fields consistent for clients: completed items expose `completionDate`, canceled items expose `cancellationDate`, and open items do not emit stale terminal timestamps.

**Startup** does a read-only Things access probe before the MCP server connects, so missing automation permission or a bad app path fails fast instead of surfacing on the first tool call.

**Doctor** gives you the same checks on demand from the MCP side: app path, automation reachability, auth token presence, and whether the SQLite fast-read path is usable. Its top-level `ok` reflects whether the server can actually read Things successfully; missing `THINGS_AUTH_TOKEN` is surfaced as missing write capability rather than a total health failure.

## Development

```bash
bun test            # run the suite
bun test --coverage # with coverage
```

No macOS automation, no Things installation, no network. The entire test suite runs offline against a mocked runtime boundary.

## Limitations

- macOS only — it's a Things 3 server, there was never another option
- Some writes need `THINGS_AUTH_TOKEN`
- `today` and `upcoming` sort order leans on Things database internals

## License

MIT
