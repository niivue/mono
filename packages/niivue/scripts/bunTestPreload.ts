// Bun test preload: resolves the Vite-only imports (`*.wgsl?raw`,
// `?worker&inline`) so modules such as NVControlBase load under bun test.
import { dirname, resolve } from 'node:path'
import { plugin } from 'bun'

/** `?worker` imports resolve to this module, so this is their default export. */
export default class UnavailableWorker {
  constructor() {
    throw new Error('Vite workers are not available under bun test')
  }
}

// Bun has a global Worker, so NVWorker.isSupported() would send work to the
// stand-in above. Without it the worker bridges take their main-thread path.
Reflect.deleteProperty(globalThis, 'Worker')

plugin({
  name: 'vite-imports',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(dirname(args.importer), args.path.slice(0, -'?raw'.length)),
    }))
    build.onLoad({ filter: /\.wgsl$/ }, async (args) => ({
      exports: { default: await Bun.file(args.path).text() },
      loader: 'object',
    }))
    build.onResolve({ filter: /\?worker/ }, () => ({ path: import.meta.path }))
  },
})
