/**
 * Minimal niimath HTTP server.
 *
 * Endpoints:
 *   POST /api/process       body: raw NIfTI bytes (any Content-Type)
 *                           headers: X-Niimath-Filename (URL-encoded),
 *                                    X-Niimath-Args     (JSON string array)
 *                           runs `niimath <input> <...args> <output>`,
 *                           returns { id, status, resultUrl, durationMs, command }
 *
 *                           We deliberately skip multipart/form-data — Bun's
 *                           `req.formData()` parser intermittently rejects
 *                           browser-built bodies as "missing final boundary"
 *                           on larger files. Raw body + headers sidesteps it.
 *   GET  /api/result/:id    streams the processed NIfTI back as application/gzip
 *   GET  /api/jobs          { jobs: Job[] } from in-memory history
 *   GET  /api/health        { ok, niimath: <manifest|null> }
 *
 * No auth, no DB. The Vite dev server proxies /api/* so the frontend hits
 * the API same-origin; we deliberately send no CORS headers so a malicious
 * page in another tab can't read /api/jobs or /api/result/<id> while the
 * dev server is running. curl/Bun callers don't care about CORS.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { niimathBinaryPath, niimathManifest } from './fetch-niimath'

const PORT = Number(process.env.FULLSTACK_SERVER_PORT ?? 8087)
// Bun.serve defaults hostname to 0.0.0.0 — i.e. reachable from anything on
// the LAN. Pin to loopback so this unauthenticated, native-binary-spawning
// API isn't sitting on the wire when a developer takes their laptop to a
// coffee shop.
const HOST = process.env.FULLSTACK_SERVER_HOST ?? '127.0.0.1'
const WORK_DIR = join(tmpdir(), 'niivue-fullstack-demo')
mkdirSync(WORK_DIR, { recursive: true })

// Reject uploads bigger than this before reading them into memory. Even a
// localhost demo shouldn't OOM on a single misbehaving client.
const MAX_BODY_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB

type JobStatus = 'running' | 'completed' | 'failed'

/**
 * Reject anything that isn't either a niimath flag (`-foo`) or a plain
 * number. Stops `["-add","/etc/passwd"]` style attacks where a niimath
 * operator that accepts "value or filename" is steered into reading an
 * arbitrary file off the server's disk.
 */
function validateArgs(args: string[]): string | null {
  const flag = /^-[a-zA-Z][a-zA-Z0-9_]*$/
  const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/
  for (const a of args) {
    if (!flag.test(a) && !num.test(a)) return `Disallowed argument: ${a}`
  }
  return null
}

interface Job {
  id: string
  status: JobStatus
  inputName: string
  args: string[]
  command: string
  outputPath?: string
  error?: string
  startedAt: number
  finishedAt?: number
  durationMs?: number
}

const jobs = new Map<string, Job>()

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

function inferOutputName(inputName: string): string {
  const lower = inputName.toLowerCase()
  let stem = inputName
  if (lower.endsWith('.nii.gz')) stem = inputName.slice(0, -7)
  else if (lower.endsWith('.nii')) stem = inputName.slice(0, -4)
  // Idempotent: chained runs against an already-processed name don't keep
  // appending `_processed`.
  const suffix = stem.endsWith('_processed') ? '' : '_processed'
  return `${stem}${suffix}.nii.gz`
}

function safeFilename(name: string): string {
  // Strip path components and characters niimath / shells dislike. Keep only
  // alphanumerics, dots, dashes, underscores; replace others with `_`.
  const base = name.split(/[\\/]/).pop() ?? 'input.nii.gz'
  return base.replace(/[^A-Za-z0-9._-]/g, '_')
}

async function runNiimath(
  binary: string,
  inputPath: string,
  args: string[],
  outputPath: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveP, rejectP) => {
    // Pin the output extension to .nii.gz regardless of the host's
    // FSLOUTPUTTYPE — niimath / fslmaths add a default extension to whatever
    // we pass when this isn't set, and that has bitten enough users to be
    // worth defending against.
    const child = spawn(binary, [inputPath, ...args, outputPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FSLOUTPUTTYPE: 'NIFTI_GZ' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', rejectP)
    child.on('exit', (code) => {
      resolveP({ stdout, stderr, code: code ?? -1 })
    })
  })
}

async function handleProcess(req: Request): Promise<Response> {
  const binary = niimathBinaryPath()
  if (!existsSync(binary)) {
    return json(
      {
        error:
          'niimath binary not found. Run `bun run setup` (or `bunx nx run demo-ext-fullstack:setup`) first.',
      },
      { status: 503 },
    )
  }

  const rawFilename = req.headers.get('x-niimath-filename')
  if (!rawFilename) {
    return json({ error: 'Missing X-Niimath-Filename header' }, { status: 400 })
  }
  let inputName: string
  try {
    inputName = safeFilename(decodeURIComponent(rawFilename))
  } catch (err) {
    return json(
      { error: `Bad X-Niimath-Filename: ${String(err)}` },
      { status: 400 },
    )
  }

  const argsHeader = req.headers.get('x-niimath-args')
  if (!argsHeader) {
    return json(
      { error: 'Missing X-Niimath-Args header (JSON string array)' },
      { status: 400 },
    )
  }
  let args: string[]
  try {
    const parsed = JSON.parse(argsHeader)
    if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === 'string')) {
      return json(
        { error: 'X-Niimath-Args must be a JSON array of strings' },
        { status: 400 },
      )
    }
    args = parsed
  } catch (err) {
    return json(
      { error: `Invalid X-Niimath-Args JSON: ${String(err)}` },
      { status: 400 },
    )
  }

  if (args.length === 0) {
    return json(
      { error: '`args` must contain at least one operator' },
      { status: 400 },
    )
  }
  const argError = validateArgs(args)
  if (argError) return json({ error: argError }, { status: 400 })

  const cl = Number(req.headers.get('content-length') ?? 0)
  if (cl > MAX_BODY_BYTES) {
    return json(
      { error: `Body too large: ${cl} > ${MAX_BODY_BYTES} bytes` },
      { status: 413 },
    )
  }

  let body: ArrayBuffer
  try {
    body = await req.arrayBuffer()
  } catch (err) {
    return json(
      { error: `Could not read body: ${String(err)}` },
      { status: 400 },
    )
  }
  if (body.byteLength === 0) {
    return json({ error: 'Empty request body' }, { status: 400 })
  }
  // Re-check after reading: chunked uploads carry no Content-Length, so the
  // pre-read header check above lets them through. We still buffered the
  // body, but at least don't kick off niimath and disk I/O on it.
  if (body.byteLength > MAX_BODY_BYTES) {
    return json(
      { error: `Body too large: ${body.byteLength} > ${MAX_BODY_BYTES} bytes` },
      { status: 413 },
    )
  }

  const id = crypto.randomUUID()
  const outputName = inferOutputName(inputName)
  const inputPath = join(WORK_DIR, `${id}_${inputName}`)
  const outputPath = join(WORK_DIR, `${id}_${outputName}`)

  await Bun.write(inputPath, body)

  const command = `niimath ${inputName} ${args.join(' ')} ${outputName}`
  const job: Job = {
    id,
    status: 'running',
    inputName,
    args,
    command,
    startedAt: Date.now(),
  }
  jobs.set(id, job)

  let result: Awaited<ReturnType<typeof runNiimath>>
  try {
    result = await runNiimath(binary, inputPath, args, outputPath)
  } finally {
    // Inputs are scratch — outputs need to stick around for /api/result/:id
    // and the history reload button. Without this every job permanently
    // doubles its disk footprint.
    await unlink(inputPath).catch(() => {})
  }
  job.finishedAt = Date.now()
  job.durationMs = job.finishedAt - job.startedAt

  if (result.code !== 0 || !existsSync(outputPath)) {
    job.status = 'failed'
    job.error = (
      result.stderr ||
      result.stdout ||
      `niimath exited ${result.code}`
    ).trim()
    return json(
      {
        id,
        status: job.status,
        error: job.error,
        command,
        durationMs: job.durationMs,
      },
      { status: 500 },
    )
  }

  job.status = 'completed'
  job.outputPath = outputPath
  return json({
    id,
    status: 'completed',
    resultUrl: `/api/result/${id}`,
    command,
    durationMs: job.durationMs,
    outputName,
  })
}

function handleResult(id: string): Response {
  const job = jobs.get(id)
  if (!job?.outputPath || !existsSync(job.outputPath)) {
    return json({ error: 'Result not found' }, { status: 404 })
  }
  const file = Bun.file(job.outputPath)
  return new Response(file, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${inferOutputName(job.inputName)}"`,
    },
  })
}

function handleJobs(): Response {
  const list = [...jobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(({ outputPath: _outputPath, ...rest }) => rest)
  return json({ jobs: list })
}

function handleHealth(): Response {
  return json({
    ok: true,
    niimath: niimathManifest(),
    workDir: WORK_DIR,
    jobs: jobs.size,
  })
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  // Bun.serve defaults idleTimeout to 10 seconds. Heavy niimath operations
  // (large smoothing kernels, 4D timeseries) can run longer; the upstream
  // socket goes "idle" while the subprocess works, the server drops the
  // connection, and the Vite proxy returns 500 with an empty body to the
  // browser. Bun caps idleTimeout at 255s — pick the maximum.
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url)
    const t0 = Date.now()
    const log = (status: number): void => {
      console.log(
        `${req.method} ${url.pathname} -> ${status} (${Date.now() - t0}ms)`,
      )
    }
    try {
      if (url.pathname === '/api/health') {
        const res = handleHealth()
        log(res.status)
        return res
      }
      if (url.pathname === '/api/jobs' && req.method === 'GET') {
        const res = handleJobs()
        log(res.status)
        return res
      }
      if (url.pathname === '/api/process' && req.method === 'POST') {
        const res = await handleProcess(req)
        log(res.status)
        return res
      }
      const resultMatch = url.pathname.match(
        /^\/api\/result\/([0-9a-f-]{36})$/i,
      )
      if (resultMatch && req.method === 'GET') {
        const res = handleResult(resultMatch[1])
        log(res.status)
        return res
      }
      log(404)
      return json({ error: 'Not found' }, { status: 404 })
    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : String(err)
      console.error(`${req.method} ${url.pathname} threw:`, msg)
      log(500)
      return json({ error: `Server exception: ${msg}` }, { status: 500 })
    }
  },
  error(err) {
    console.error('Bun.serve error:', err)
    return json(
      {
        error: `Server error: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    )
  },
})

console.log(
  `niimath server listening on http://${server.hostname}:${server.port}`,
)
console.log(`work dir: ${WORK_DIR}`)
const manifest = niimathManifest()
if (manifest) {
  console.log(`niimath: ${manifest.tag} (installed ${manifest.installedAt})`)
} else {
  console.log('niimath: NOT INSTALLED — run `bun run setup` to download.')
}
