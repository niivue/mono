import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { devImagesPlugin } from "@niivue/dev-images/vite-plugin";

export default defineConfig({
  plugins: [devImagesPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 8080,
  },
});
