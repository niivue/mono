import { defineConfig } from "vite";
import { devImagesPlugin } from "@niivue/dev-images/vite-plugin";

export default defineConfig({
  plugins: [devImagesPlugin()],
  server: {
    port: 8085,
  },
  build: {
    outDir: "dist",
    target: "esnext",
    rollupOptions: {
      input: "index.html",
    },
  },
});
