# cositas

Things 3 has no API. Now it does.

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants full read/write access to [Things 3](https://culturedcode.com/things/) on macOS. Runs entirely in the background — Things never steals focus, your AI never loses context.

## What it can do

| Tool | |
|------|--|
| `read` | Pull any list, project, area, or item. Paginate, filter by completion date — the works. |
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

## Configuration

| Variable | Required | |
|----------|----------|-|
| `THINGS_AUTH_TOKEN` | For writes | Bulk updates, special scheduling (`evening`, `anytime`, `someday`), checklists, tags with commas |
| `THINGS_APP_PATH` | No | If Things isn't where it usually is. Default: `/Applications/Things3.app` |
| `THINGS_FAST_READS` | No | Set to `0` if you don't want SQLite-accelerated `logbook`/`trash` reads |
| `THINGS_DB_PATH` | No | Override the auto-detected Things database path |

## Under the hood

**JXA** does the heavy lifting. Reads and most writes go through `osascript` with structured JSON args — no string-interpolated script fragments.

**Things URL/JSON commands** pick up what JXA drops: bulk updates, checklists, and scheduling values that JXA pretends don't exist.

**SQLite** speeds up `logbook` and `trash` by querying IDs from the local Things database first, then hydrating through JXA. On by default, zero config.

**Startup** does a read-only Things access probe before the MCP server connects, so missing automation permission or a bad app path fails fast instead of surfacing on the first tool call.

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
