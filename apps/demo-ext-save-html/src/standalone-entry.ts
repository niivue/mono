/**
 * Re-export NiiVueGPU as the default export for the standalone bundle.
 * This entry is only used by vite.config.standalone.js.
 */

// biome-ignore lint/performance/noBarrelFile: package entry point
export { default } from '@niivue/niivue'
