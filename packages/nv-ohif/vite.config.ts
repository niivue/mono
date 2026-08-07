import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev-only: serves the Phase-1 proof harness in demo/. Not part of the published
// library (build:lib bundles src/index.ts and externalizes react).
export default defineConfig({
  root: 'demo',
  plugins: [react()],
  server: { port: 5183 },
  // The viewport is imported from ../src while React is resolved for the demo;
  // dedupe so hooks share one React instance (avoids "Invalid hook call").
  resolve: { dedupe: ['react', 'react-dom'] },
})
