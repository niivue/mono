# demo-mcp

A NiiVue page an agent can drive through [`@niivue/nv-mcp`](../../packages/nv-mcp): load volumes, move the crosshair to an atlas region or a point, cut and face a plane, and take a screenshot of what the person is looking at.

The page shows the MNI152 template in a render view and describes itself to the core as a `NiiVueHost`: the NiiVue instance, the AAL atlas from `@niivue/dev-images` for `list_regions` and `go_to_region`, and how it tells the person where an agent has taken them. The server adds no tools of its own, so the whole app is three short files.

The stack is two processes:

| Process    | Port | What it does                                                          |
|------------|------|-----------------------------------------------------------------------|
| Vite       | 8091 | Serves the page and the `@niivue/dev-images` volumes                  |
| Bun server | 4242 | The MCP endpoint at `/mcp`, the page's WebSocket at `/app`, a status page at `/` |

## Run

```bash
bunx nx dev demo-mcp
```

Starts the MCP server and the Vite dev server (auto-opens). The header turns green when the page has reached the server. Either child crashing takes the other down, so no orphan is left on a port.

To run them separately:

```bash
bunx nx run demo-mcp:server      # MCP server only
bunx nx run demo-mcp:frontend    # Vite only
```

`NV_MCP_PORT` and `NV_MCP_HOST` move the server; the Vite proxy follows them.

Vite runs under Node here (`bunx vite`), not `--bun`: the page's `/agent` WebSocket proxy goes through http-proxy's upgrade path, which hangs under Bun's `node:http`. The page would still reach the server through its second address, after the client gave up on the first, but the proxy is the point of the exercise.

## Connect an agent

Claude Code:

```bash
claude mcp add --transport http niivue http://127.0.0.1:4242/mcp
```

The page's own "Connect an agent" panel shows the same line, with whatever `NV_MCP_HOST` and `NV_MCP_PORT` were set to. Then ask it to go to the left insula, cut an axial plane through the crosshair, or send a screenshot. `http://127.0.0.1:4242/` lists the connected tabs. The [package README](../../packages/nv-mcp/README.md) covers the Claude desktop app, the tools and how tabs and reloads are handled.

## How it works

1. `server/server.ts` calls `startServer` with a name and a hint for the agent to read when no page is connected.
2. `src/main.ts` builds the host and opens an `AgentClient` with `coreHandlers(host)`. The client tries `/agent` on the page's own origin first, which Vite proxies to the server's WebSocket, then the server directly.
3. `src/atlas.ts` fetches `aal.nii.gz` and `aal.json`, reads them with `nifti-reader-js` and NiiVue's `nii2volume`, and answers the four `AtlasLike` questions from the voxel grid, so a region's centroid and the region under any point come from the same volume.

The client connects before NiiVue starts, and every tool answers in words until the page is ready. That matters for a tab in the background: the browser gives it no animation frames, so NiiVue does not finish attaching until the tab is brought to the front, and a screenshot of it would be blank.

Nothing here is deployed to GitHub Pages: the page needs the Bun server beside it.
