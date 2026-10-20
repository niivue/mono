import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

const MCP_PORT = Number(process.env.NV_MCP_PORT ?? 4242)
const MCP_HOST = process.env.NV_MCP_HOST ?? '127.0.0.1'

export default defineConfig({
  base: '/',
  plugins: [devImagesPlugin()],
  define: {
    // The page's "connect an agent" hint, so it follows NV_MCP_HOST and
    // NV_MCP_PORT rather than repeating the defaults.
    __NV_MCP_URL__: JSON.stringify(`http://${MCP_HOST}:${MCP_PORT}/mcp`),
  },
  server: {
    port: 8091,
    proxy: {
      // The page tries `/agent` on its own origin first, for browsers that
      // let a page reach one origin only (the pane inside Claude's desktop
      // app, any page served over HTTPS). Vite forwards it to the MCP
      // server's WebSocket.
      '/agent': {
        target: `ws://${MCP_HOST}:${MCP_PORT}`,
        ws: true,
        rewrite: (path) => path.replace(/^\/agent/, '/app'),
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: 'index.html',
    },
  },
})
