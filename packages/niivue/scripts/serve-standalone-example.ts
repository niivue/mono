/**
 * Static server for examples/standalone/index.html on http://localhost:5403.
 *
 * Mirrors the layout a bundler-free consumer would deploy, with no build step
 * and no module rewriting (this is not Vite, on purpose):
 *
 *   /                 examples/standalone/index.html
 *   /niivue/*         dist/standalone/*   (the self-contained ES module build)
 *   /volumes/*        ../dev-images/images/volumes/*
 *
 * Run `bun run build` first, then: bun run examples:standalone
 */
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const NIIVUE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT ?? 5403)
const ROUTES: Array<[prefix: string, dir: string]> = [
  ['/niivue/', join(NIIVUE_ROOT, 'dist', 'standalone')],
  ['/volumes/', resolve(NIIVUE_ROOT, '..', 'dev-images', 'images', 'volumes')],
  ['/', join(NIIVUE_ROOT, 'examples', 'standalone')],
]

if (!existsSync(join(NIIVUE_ROOT, 'dist', 'standalone', 'niivue.js'))) {
  console.error('dist/standalone/niivue.js is missing. Run `bun run build`.')
  process.exit(1)
}

function resolveFile(pathname: string): string | null {
  for (const [prefix, dir] of ROUTES) {
    if (!pathname.startsWith(prefix)) continue
    let rest = decodeURIComponent(pathname.slice(prefix.length))
    if (rest === '' || rest.endsWith('/')) rest += 'index.html'
    const abs = resolve(dir, rest)
    if (!abs.startsWith(dir + sep)) return null
    return existsSync(abs) && statSync(abs).isFile() ? abs : null
  }
  return null
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const file = resolveFile(new URL(req.url).pathname)
    if (!file) return new Response('Not found', { status: 404 })
    // Serve .nii.gz as opaque bytes: a gzip Content-Encoding would make the
    // browser inflate it before NiiVue sees it.
    const headers = file.endsWith('.gz')
      ? { 'Content-Type': 'application/octet-stream' }
      : undefined
    return new Response(Bun.file(file), { headers })
  },
})

console.log(`Standalone example: http://localhost:${server.port}/`)
