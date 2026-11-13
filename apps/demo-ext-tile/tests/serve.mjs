/**
 * The demo's dist/ on a free local port, with Range and HEAD (zarrita reads a
 * shard index's offset from a HEAD's Content-Length). `route(path, req, res)`
 * returns a file path to serve, nothing for dist/<path>, or anything else
 * once it has answered.
 */

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.json': 'application/json',
}

export async function serve(route = () => undefined) {
  const server = createServer(async (req, res) => {
    const path =
      normalize(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') ||
      'index.html'
    const file = await route(path, req, res)
    if (file !== undefined && typeof file !== 'string') return
    let body
    try {
      body = await readFile(file ?? join(DIST, path))
    } catch {
      return res.writeHead(404).end()
    }
    const type = TYPES[extname(path)] ?? 'application/octet-stream'
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    if (!m)
      return res
        .writeHead(200, { 'content-type': type, 'content-length': body.length })
        .end(req.method === 'HEAD' ? undefined : body)
    const start = m[1] ? Number(m[1]) : body.length - Number(m[2])
    const end = m[1] && m[2] ? Number(m[2]) : body.length - 1
    res
      .writeHead(206, {
        'content-type': type,
        'content-range': `bytes ${start}-${end}/${body.length}`,
      })
      .end(body.subarray(start, end + 1))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return server
}
