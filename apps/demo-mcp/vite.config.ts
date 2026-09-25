import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

const MCP_PORT = Number(process.env.NV_MCP_PORT ?? 4242)
const MCP_HOST = process.env.NV_MCP_HOST ?? '127.0.0.1'

export default defineConfig({
  base: '/',
  plugins: [devImagesPlugin()],
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
