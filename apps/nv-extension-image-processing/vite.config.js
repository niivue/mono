import { fileURLToPath } from "node:url"
import { devImagesPlugin } from "@niivue/dev-images/vite-plugin"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [devImagesPlugin()],
  server: {
    port: 8081,
  },
  build: {
    outDir: "dist",
    target: "esnext",
    rollupOptions: {
      input: {
        imgproc: fileURLToPath(new URL("imgproc.html", import.meta.url)),
      },
    },
  },
})
