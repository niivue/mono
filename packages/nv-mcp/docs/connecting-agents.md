# Connecting agents to a NiiVue MCP server

Every client below talks to the same thing: the Streamable HTTP endpoint `startServer` opens, `http://127.0.0.1:4242/mcp` by default. The server needs no login and no token, listens on loopback only, and answers each tool call by asking the NiiVue page that holds a WebSocket to it. So the sequence is always the same:

1. Start the server and the page. For the demo in this repository that is `bunx nx dev demo-mcp`, which starts both and opens the page.
2. Bring the page's browser tab to the front. A background tab gets no animation frames, so NiiVue never finishes attaching and a screenshot of it would be blank.
3. Register the endpoint with the client, in whichever way that client takes an HTTP MCP server.
4. Ask for something: *go to the left hippocampus*, *cut an axial plane through the crosshair*, *send me a screenshot*.

`http://127.0.0.1:4242/` is a plain-text status page listing the connected tabs, with `*` on the one that answers. When a client lists no tools or a call fails, look there first.

The examples name the server `niivue`. Any name works; it only chooses how the client prefixes the tools (Claude Code, for one, shows them as `mcp__niivue__go_to_region`). If `NV_MCP_HOST` or `NV_MCP_PORT` moved the server, the demo page's "Connect an agent" panel shows the adjusted address, and `localhost` works in place of `127.0.0.1`.

## Claude Code

```bash
claude mcp add --transport http niivue http://127.0.0.1:4242/mcp
```

The default scope is `local`, which is this user in this directory. `--scope user` makes it available everywhere; `--scope project` writes a `.mcp.json` next to the code that other people on the project pick up:

```json
{
  "mcpServers": {
    "niivue": {
      "type": "http",
      "url": "http://127.0.0.1:4242/mcp"
    }
  }
}
```

`/mcp` inside a session shows whether the server connected and lists its tools. `claude mcp remove niivue` takes it out again.

For a one-shot run with no interactive session, pass the same JSON as a file and allow the tools up front:

```bash
claude -p --mcp-config niivue.json --strict-mcp-config \
  --allowedTools "mcp__niivue__*" --output-format text \
  "Load the template, go to the left hippocampus, and tell me what is under the crosshair."
```

`--strict-mcp-config` ignores every other configured server, which keeps the run reproducible. This is how the package's own end-to-end checks were run.

## Claude desktop app

The desktop app's own connector settings only accept a remote server over HTTPS, so a loopback server reaches it through the `mcp-remote` bridge, registered as a local command in `claude_desktop_config.json` (on macOS, `~/Library/Application Support/Claude/claude_desktop_config.json`; the file is reachable from Settings, Developer, Edit Config):

```json
{
  "mcpServers": {
    "niivue": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:4242/mcp"]
    }
  }
}
```

The full path to `npx` matters: the app is launched without a shell, so it does not have Homebrew or nvm on its `PATH`. Run `which npx` to find yours. Quit and relaunch the app after editing the file; the server appears under the tools icon in a new chat.

## Codex CLI

```bash
codex mcp add niivue --url http://127.0.0.1:4242/mcp
```

That writes to `~/.codex/config.toml`:

```toml
[mcp_servers.niivue]
url = "http://127.0.0.1:4242/mcp"
```

Codex prints a reminder that the server may require login. It does not; skip `codex mcp login`. `codex mcp list` confirms the entry, and `/mcp` inside a session shows the tools.

## Gemini CLI

```bash
gemini mcp add --transport http niivue http://127.0.0.1:4242/mcp
```

The default scope is the project, which writes `.gemini/settings.json` in the current directory; `--scope user` writes `~/.gemini/settings.json` instead. Either file holds:

```json
{
  "mcpServers": {
    "niivue": {
      "type": "http",
      "url": "http://127.0.0.1:4242/mcp"
    }
  }
}
```

`/mcp` inside a session lists the servers and their tools. By default Gemini asks before each tool call; `--trust` on the `add` line waives that for this server.

## VS Code with GitHub Copilot

From a shell:

```bash
code --add-mcp '{"name":"niivue","type":"http","url":"http://127.0.0.1:4242/mcp"}'
```

Or by hand, in `.vscode/mcp.json` for one workspace. Note that VS Code's key is `servers`, not `mcpServers`:

```json
{
  "servers": {
    "niivue": {
      "type": "http",
      "url": "http://127.0.0.1:4242/mcp"
    }
  }
}
```

Open the Chat view, choose Agent mode, and the server's tools appear in the tools picker. The `MCP: List Servers` command starts, stops and shows the output of each server.

## Cursor

In `.cursor/mcp.json` for one project or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "niivue": {
      "url": "http://127.0.0.1:4242/mcp"
    }
  }
}
```

Cursor's MCP settings page shows the server with a green dot once it has fetched the tool list. The tools are used from Agent mode in the chat pane.

## Windsurf

In `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "niivue": {
      "serverUrl": "http://127.0.0.1:4242/mcp"
    }
  }
}
```

The same file is reachable from the Cascade panel's MCP settings. Press refresh there after editing it.

## Any other client

A client that takes an HTTP or "streamable HTTP" server wants the URL above and nothing else. A client that only launches local commands over stdio gets the same server through `mcp-remote`, as the Claude desktop app does:

```json
{
  "command": "npx",
  "args": ["-y", "mcp-remote", "http://127.0.0.1:4242/mcp"]
}
```

Some clients still speak the older SSE transport only. The server does not serve SSE; `mcp-remote` bridges that gap as well.

## Your own program

With the TypeScript SDK the server is three lines away. The instructions the server was started with, which say what the page shows and which files it can fetch, come back from `getInstructions()`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'my-agent', version: '0.1.0' })
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4242/mcp')))

console.log(client.getInstructions())
const { tools } = await client.listTools()
const where = await client.callTool({ name: 'where_am_i', arguments: {} })
```

With the Python SDK (`pip install mcp`):

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async with streamablehttp_client("http://127.0.0.1:4242/mcp") as (read, write, _):
    async with ClientSession(read, write) as session:
        await session.initialize()
        tools = await session.list_tools()
        where = await session.call_tool("where_am_i", {})
```

Every page-answered tool takes an optional `tab`, the id of the tab it should go to, so a program that opened several pages can address each one. `list_tabs` names them and `new_tab` mints an id and the address that opens a page under it.

## Checking the connection without an agent

The MCP Inspector is a small web app that connects to any server and lets you call tools by hand:

```bash
bunx @modelcontextprotocol/inspector
```

Choose Streamable HTTP as the transport, enter `http://127.0.0.1:4242/mcp`, connect, and the Tools tab lists the 48 core tools plus whatever the app added. Calling `where_am_i` is a good first check: it answers in words even before NiiVue has finished loading.

## When something does not work

**"No NiiVue tab is connected."** The server is up but no page holds a socket to it. Open the page, or bring its tab to the front and wait for its header to show the connection. The app's own hint follows this line, naming the address to open.

**A call times out after 15 seconds, or the screenshot is blank.** The page's tab is hidden or covered. Browsers stop animation frames for a hidden tab and NiiVue cannot draw without them. Bring the tab to the front. For an unattended run, a headless browser (Playwright's Chromium with `--enable-unsafe-webgpu`) is the dependable answer.

**The client lists no tools, and the server log shows a refused request.** The request's `Host` header does not name the server. Loopback names on the server's port pass; anything else, such as a hostname in `/etc/hosts` or a tunnel, goes in `startServer({ allowedHosts: ['niivue.local:4242'] })`.

**The page cannot reach the server, but the client can.** The page's `Origin` is not loopback, which happens when it is served from another host or over HTTPS. Add it to `allowedOrigins`, or serve the page through a dev-server proxy as the package README describes.

**The tools exist but a new argument is ignored.** The server was started before the package was rebuilt, and the demo imports `@niivue/nv-mcp` from its built `dist`. Restart the server after `bunx nx build nv-mcp`.

**Several pages are open and the wrong one answers.** `list_tabs` shows them; `use_tab` chooses one for the rest of the conversation; or pass `tab` on each call.
