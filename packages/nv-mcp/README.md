# @niivue/nv-mcp

An [MCP](https://modelcontextprotocol.io) server for a [NiiVue](https://github.com/niivue) page, so an agent can load volumes, move the crosshair, cut planes, find atlas regions and take screenshots of a scene a person is looking at.

An agent connects to the server over streamable HTTP; the page keeps a WebSocket open to the same server; each tool call is written to the page as one JSON request and answered with one JSON response. The server holds no anatomy and no scene of its own, so it stays small and the page stays the one place the state lives.

The package has three entry points, and nothing in it knows about the app that hosts it:

| Entry | Runs in | Holds |
|---|---|---|
| `@niivue/nv-mcp` | both | The wire messages, the plane arithmetic, region matching and the AAL spoken-name table |
| `@niivue/nv-mcp/server` | Bun | The bridge that knows tabs by id |

## Installation

```bash
bun add @niivue/nv-mcp
```

The server side runs under [Bun](https://bun.sh), because it uses `Bun.serve` for the HTTP and WebSocket ends together. The browser side is plain DOM and WebSocket. `@niivue/niivue` is an optional peer dependency: the browser entry is written against its 1.0 API but imports nothing from it, so any object with the same member names will do (see `View` in `browser/scene.ts`).

## Development

```bash
bunx nx build nv-mcp       # Build
bunx nx test nv-mcp        # Run the tests (bun test)
bunx nx typecheck nv-mcp   # Type-check
bunx nx lint nv-mcp        # Biome
```

## Part of the [NiiVue](https://github.com/niivue) ecosystem
