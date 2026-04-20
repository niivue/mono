import { devImagesPlugin } from "@niivue/dev-images/vite-plugin";
import { defineConfig } from "vite";

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
