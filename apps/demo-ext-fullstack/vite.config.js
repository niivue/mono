import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

const SERVER_PORT = Number(process.env.FULLSTACK_SERVER_PORT ?? 8087)
const SERVER_HOST = process.env.FULLSTACK_SERVER_HOST ?? '127.0.0.1'

export default defineConfig({
  base: '/',
  plugins: [devImagesPlugin()],
  server: {
    port: 8088,
    proxy: {
      '/api': {
        target: `http://${SERVER_HOST}:${SERVER_PORT}`,
        changeOrigin: false,
        // No upstream timeout — niimath can take a while on big volumes /
        // heavy operators, and the Bun server has its own idleTimeout cap.
        timeout: 0,
        proxyTimeout: 0,
        configure(proxy) {
          proxy.on('error', (err, _req, res) => {
            console.error('[vite proxy] /api error:', err.message)
            // Surface the error to the browser as JSON instead of letting
            // http-proxy send an empty 500.
            if (res && 'writeHead' in res && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' })
              res.end(
                JSON.stringify({
                  error: `Proxy could not reach niimath server: ${err.message}`,
                }),
              )
            }
          })
        },
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
