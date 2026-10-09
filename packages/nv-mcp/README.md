# @niivue/nv-mcp

An [MCP](https://modelcontextprotocol.io) server for a [NiiVue](https://github.com/niivue) page, so an agent can load volumes, move the crosshair, cut planes, find atlas regions and take screenshots of a scene a person is looking at.

An agent connects to the server over streamable HTTP; the page keeps a WebSocket open to the same server; each tool call is written to the page as one JSON request and answered with one JSON response. The server holds no anatomy and no scene of its own, so it stays small and the page stays the one place the state lives.

The package has three entry points, and nothing in it knows about the app that hosts it:

| Entry | Runs in | Holds |
|---|---|---|
| `@niivue/nv-mcp` | both | The wire messages, the plane arithmetic, region matching and the AAL spoken-name table |
| `@niivue/nv-mcp/server` | Bun | The bridge that knows tabs by id, the core tools, `startServer` |

An app adds its own tools as an *extension* without touching the core.

## Installation

```bash
bun add @niivue/nv-mcp
```

The server side runs under [Bun](https://bun.sh), because it uses `Bun.serve` for the HTTP and WebSocket ends together. The browser side is plain DOM and WebSocket. `@niivue/niivue` is an optional peer dependency: the browser entry is written against its 1.0 API but imports nothing from it, so any object with the same member names will do (see `View` in `browser/scene.ts`).

## Usage

### The server

```ts
import { startServer } from '@niivue/nv-mcp/server'

startServer({
  name: 'my-niivue-app',
  version: '0.1.0',
  pageUrl: 'http://localhost:8091',
  bridge: { noTabHint: 'Open http://localhost:8091 in a browser.' },
})
```

That listens on `127.0.0.1:4242` (both configurable) and serves three paths:

| Path | What |
|---|---|
| `/mcp` | The streamable HTTP endpoint an agent's client connects to. Stateless: each request gets its own `McpServer`, all sharing one bridge. |
| `/app` | The WebSocket the page keeps open |
| `/` | A plain-text status page listing the connected tabs, with `*` on the one that answers |

`startServer` returns the running server with its `bridge`, `url`, `appUrl` and a `stop()`. Pass `log` to route its lines somewhere other than the console, `bridge` options to tune timeouts or the message an agent reads when no page is connected, `pageUrl` so `new_tab` can hand out the address that opens the page as a named tab, `instructions` for what an agent reads when it connects (what the page shows and can fetch, which the tools cannot know), and a `Bridge` of your own if you wire the HTTP yourself.

Loopback keeps the network out but not other web pages: any site open in the same browser can ask it to open a socket to `127.0.0.1`, and a hostname an attacker controls can resolve there. So `/app` refuses a page whose `Origin` is not loopback (`localhost`, `127.0.0.1` or `[::1]` on any port; a client that sends no `Origin`, which is not a browser, is let in), and `/mcp` refuses a request whose `Host` header does not name this server. A page served from elsewhere goes in `allowedOrigins`; a name for the server other than loopback goes in `allowedHosts`, with its port:

```ts
startServer({
  allowedOrigins: ['https://viewer.example.org'],
  allowedHosts: ['niivue.local:4242'],
})
```

Calls to one tab go one at a time, in the order they were made. The page's handlers all change the one scene, so an agent that fires several tools together gets each answered against the scene the one before left rather than racing them.

### Connecting an agent

For Claude Code:

```bash
claude mcp add --transport http my-niivue-app http://127.0.0.1:4242/mcp
```

The page's first address, `/agent` on its own origin, is for browsers that let a page reach one origin only, such as the pane inside Claude's desktop app. It needs the dev server to proxy it. In Vite:

```ts
server: {
  proxy: {
    '/agent': {
      target: 'ws://127.0.0.1:4242',
      ws: true,
      rewrite: (path) => path.replace(/^\/agent/, '/app'),
    },
  },
},
```

A page served over HTTPS cannot open `ws://127.0.0.1` at all; the proxy is the way through for that too.

Run Vite under Node for this (`bunx vite`, not `bunx --bun vite`). Vite's WebSocket proxy goes through http-proxy's upgrade path, which hangs under Bun's `node:http`: the socket neither opens nor closes, and the page only reaches the server through its second address. Building with `--bun` is fine; only the dev server is affected.

## The core tools

| Tool | Input | What it does |
|---|---|---|
| `list_tabs` | | The connected tabs: id, title, address, when each connected and which one answers |
| `use_tab` | `id` | Makes one tab the one that answers every later call |
| `new_tab` | | Makes up an id for a tab that is not open yet and gives the address that opens the page as that tab, `pageUrl` with `?tab=<id>` on it |

Every tool below `new_tab` also takes `tab?`, the id of the tab to ask; without it the answering tab is asked, as the Tabs section explains.

Every reply is a line of prose for the agent to read, then the JSON the page returned. Failures are tool errors with the page's own message.

## Tabs

Every page that connects says hello with an id, a title, its address and its state, and the server welcomes it with the id it will list the tab under. The id is kept in the tab's `sessionStorage`, which a browser scopes to one tab and keeps across reloads, so a reload arrives as the same id on a new socket and a second tab arrives as a new id. A duplicated tab is the exception: the browser copies its `sessionStorage`, so the copy arrives with the original's id while the original is still connected. The bridge keeps the original as it is and welcomes the copy with a spare id, the original's with `-2` on the end, which the copy keeps for its own reloads; both are then listed, and a call with neither chosen asks, as with any two tabs.

A page opened with `?tab=<id>` in its address takes that id instead, and keeps it in `sessionStorage` too, so its reloads and a later address without the parameter still arrive as it. A duplicate of such a tab is renamed by the server as any duplicate is, and keeps the spare id across its own reloads although its address still names the original. That is how an agent names a tab before it exists: `new_tab` makes up a UUID and returns it with the address to open, the person opens it, and every later call in the conversation passes the id as `tab` and reaches that tab whatever else is connected or chosen. An agent may make up any id itself and put it in the address the same way; `new_tab` only spares it the guessing and knows where the page is.

Which tab answers a call:

- **The call names a `tab`**: that one, if it is connected, else the call fails and lists the tabs. The choice made with `use_tab` is left as it was.
- **One tab connected**: that one.
- **A tab chosen with `use_tab`**: that one, for as long as it is connected.
- **Several connected and none chosen**: the one that answered last, if it is still connected; otherwise the call fails and lists the tabs, so the agent can call `use_tab` rather than drive a tab nobody is looking at.
- **The tab reloads mid-call**: the call fails saying so. On the next call the bridge waits a few seconds for the same id to come back, then answers from it and puts a note at the top of the reply saying the tab reloaded and what its state was before and is now, so the agent knows the crosshair, plane and anything the app adds started over. The note is said once. A page that comes back on a new socket without reloading, after the server restarted or the socket dropped, says so in its hello and gets no note, since its scene is as it was.
- **No tab connected**: the call fails with `NO_APP` plus the server's `noTabHint`, so the agent can tell the person what to open.

Every answer carries `tab: {id, title}` in `where_am_i`, and `list_tabs` marks the one that is answering.

## Adding tools

Extra handlers on the page are more entries in the object passed to `AgentClient`; they receive the tool's arguments and return the JSON the agent sees, or throw to fail the call. Add their state to what the `state` callback returns and the reload note will cover it.

On the server, an `Extension` is a name and a `register(server, context)` that calls `server.registerTool` for each tool, answering through `context.answer(method, params, options)`, which forwards to the bound tab, or to the one `options.tab` names, and wraps the reply. Spread `TAB_ARG` into the tool's schema so an agent can name the tab for it as it does for the core tools:

```ts
import { z } from 'zod'
import { type Extension, TAB_ARG } from '@niivue/nv-mcp/server'

const light: Extension = {
  name: 'light',
  register(server, context) {
    server.registerTool(
      'set_light',
      { description: 'Turns the room light on or off.', inputSchema: { ...TAB_ARG, on: z.boolean() } },
      ({ tab, ...params }) => context.answer('set_light', params, { tab, lead: () => 'Done.' }),
    )
  },
}

startServer({ name: 'my-niivue-app', extensions: [light] })
```

## Development

```bash
bunx nx build nv-mcp       # Build
bunx nx test nv-mcp        # Run the tests (bun test)
bunx nx typecheck nv-mcp   # Type-check
bunx nx lint nv-mcp        # Biome
```

## Part of the [NiiVue](https://github.com/niivue) ecosystem
