---
title: Connecting agents
description: "Connect Claude, Codex, Gemini CLI, VS Code, Cursor, Windsurf or your own program to a NiiVue MCP server, and fix a connection that does not work."
sidebar:
  order: 1
---

Every agent connects to the same address: `http://127.0.0.1:4242/mcp`,
unless you started the server somewhere else. There is no login or token.
The steps are always the same:

1. Start the server and the page. For the demo in this repository,
   `bunx nx dev demo-mcp` does both.
2. Bring the page's tab to the front. A hidden tab gets no animation
   frames, so NiiVue cannot draw, and a screenshot would be blank.
3. Add the address to your agent, as shown below.
4. Ask for something: "go to the left hippocampus", "cut an axial plane
   through the crosshair", "send me a screenshot".

The examples call the server `niivue`. Any name works: it only changes how
the agent labels the tools, such as `mcp__niivue__go_to_region` in Claude
Code.

`http://127.0.0.1:4242/` is a plain status page listing the connected
tabs, with `*` on the one that answers. When something does not work,
look there first.

## Claude Code

```bash
claude mcp add --transport http niivue http://127.0.0.1:4242/mcp
```

This adds the server for you, in this folder. Add `--scope user` to have
it everywhere, or `--scope project` to write a `.mcp.json` that others on
the project pick up:

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

Type `/mcp` in a session to see whether the server connected and which
tools it has. `claude mcp remove niivue` takes it out again.

To run one request without a session, save that JSON as `niivue.json` and
allow the tools up front:

```bash
claude -p --mcp-config niivue.json --strict-mcp-config \
  --allowedTools "mcp__niivue__*" --output-format text \
  "Load the template, go to the left hippocampus, and tell me what is under the crosshair."
```

`--strict-mcp-config` ignores your other servers, so the run behaves the
same every time.

## Claude desktop app

The desktop app's connector settings only take servers on HTTPS, so a
server on your own machine goes through the `mcp-remote` bridge instead.
Add it to `claude_desktop_config.json` (Settings, Developer, Edit Config;
on macOS it is in `~/Library/Application Support/Claude/`):

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

Use the full path to `npx`, which `which npx` prints: the app does not
start from a shell, so it cannot find tools that Homebrew or nvm put on
your `PATH`. Quit and reopen the app after editing the file. The server
shows up under the tools icon in a new chat.

## Codex CLI

```bash
codex mcp add niivue --url http://127.0.0.1:4242/mcp
```

That writes this to `~/.codex/config.toml`:

```toml
[mcp_servers.niivue]
url = "http://127.0.0.1:4242/mcp"
```

Codex may say the server needs a login. It does not, so skip
`codex mcp login`. `codex mcp list` shows the entry, and `/mcp` in a
session shows the tools.

## Gemini CLI

```bash
gemini mcp add --transport http niivue http://127.0.0.1:4242/mcp
```

This writes `.gemini/settings.json` in the current folder; add
`--scope user` to write `~/.gemini/settings.json` instead.

`/mcp` in a session lists the servers and their tools. Gemini asks before
each tool call unless you add `--trust` to the `add` command.

## VS Code with GitHub Copilot

From a shell:

```bash
code --add-mcp '{"name":"niivue","type":"http","url":"http://127.0.0.1:4242/mcp"}'
```

Or by hand, in `.vscode/mcp.json`. Note that the key is `servers`, not
`mcpServers`:

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

Open the Chat view and choose Agent mode: the tools appear in the tools
picker. The `MCP: List Servers` command starts and stops the server and
shows its output.

## Cursor

In `.cursor/mcp.json` for one project, or `~/.cursor/mcp.json` for all of
them:

```json
{
  "mcpServers": {
    "niivue": {
      "url": "http://127.0.0.1:4242/mcp"
    }
  }
}
```

Cursor's MCP settings show a green dot once it has the tool list. Use the
tools from Agent mode in the chat pane.

## Windsurf

In `~/.codeium/windsurf/mcp_config.json`, which the Cascade panel's MCP
settings also open:

```json
{
  "mcpServers": {
    "niivue": {
      "serverUrl": "http://127.0.0.1:4242/mcp"
    }
  }
}
```

Press refresh in those settings after editing the file.

## Any other agent

An agent that takes an HTTP (or "streamable HTTP") server needs only the
address. One that can only start local commands reaches the server through
`mcp-remote`, as the Claude desktop app does:

```json
{
  "command": "npx",
  "args": ["-y", "mcp-remote", "http://127.0.0.1:4242/mcp"]
}
```

The same bridge helps an agent that only speaks the older SSE transport,
which the server does not offer.

## Your own program

With the TypeScript SDK:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'my-agent', version: '0.1.0' })
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4242/mcp')))

const where = await client.callTool({ name: 'where_am_i', arguments: {} })
```

`client.getInstructions()` returns what the app told agents about itself,
such as which files its server has.

With the Python SDK (`pip install mcp`):

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async with streamablehttp_client("http://127.0.0.1:4242/mcp") as (read, write, _):
    async with ClientSession(read, write) as session:
        await session.initialize()
        where = await session.call_tool("where_am_i", {})
```

A program that opens several pages can pass `tab`, the id of the tab to
ask, to any tool that works on a page. `list_tabs` names the tabs.

## Checking the connection without an agent

The MCP Inspector is a small web app for calling tools by hand:

```bash
bunx @modelcontextprotocol/inspector
```

Choose Streamable HTTP, enter `http://127.0.0.1:4242/mcp` and connect. The
Tools tab lists every tool. Calling `where_am_i` is a good first check.

## When something does not work

**"No NiiVue tab is connected."** The server is running but no page is
connected to it. Open the page, or bring its tab to the front and wait
for it to connect. The rest of the message, if the app set one, says
which address to open.

**A call times out after 15 seconds, or the screenshot is blank.** The
page's tab is hidden or covered, and NiiVue cannot draw in it. Bring the
tab to the front. For runs nobody watches, use a headless browser such as
Playwright's Chromium.

**The agent cannot connect, with an "Invalid Host header" error.** The
agent reached the server under a name the server does not know, such as a
name from `/etc/hosts` or a tunnel. Add it, with its port, to
`allowedHosts` in `startServer`.

**The agent connects, but the page cannot.** If the server log says
"refused a socket from" an address, the page is served from somewhere
other than this machine: add its origin to `allowedOrigins`. A page served
over HTTPS cannot reach the server's plain `ws://` address at all, so it
needs the `/agent` proxy. See
[Serving the page from another address](/packages/nv-mcp/your-app/#serving-the-page-from-another-address).

**A new tool or argument is missing.** In this repository, the demo uses
the built package. Restart `bunx nx dev demo-mcp`, which builds it first.

**The wrong tab answers.** Ask the agent to list the tabs and use the one
you want, or to name the tab on each call.
