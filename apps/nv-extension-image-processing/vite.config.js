import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { devImagesPlugin } from "@niivue/dev-images/vite-plugin";

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
});
