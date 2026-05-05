/**
 * NiiVue + niimath fullstack demo.
 *
 * Frontend (Vite, port 8088) talks to a Bun HTTP server (port 8087)
 * that runs the `niimath` binary as a subprocess. Vite proxies /api/*
 * to the server so the same origin works in dev.
 */
import NiiVueGPU, {
  MULTIPLANAR_TYPE,
  SHOW_RENDER,
  SLICE_TYPE,
} from '@niivue/niivue'
import {
  inferOutputName,
  NIIMATH_OPERATORS,
  type NiimathOperator,
  SAMPLE_VOLUMES,
} from './operators'

interface PipelineStep {
  operator: NiimathOperator
  args: string[]
}

interface JobSummary {
  id: string
  status: 'running' | 'completed' | 'failed'
  inputName: string
  args: string[]
  startedAt: number
  finishedAt?: number
  durationMs?: number
  error?: string
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element #${id} not found`)
  return el as T
}

const status = $('status')
const spinner = $('spinner')
const health = $('health')
const sampleSelect = $<HTMLSelectElement>('sampleSelect')
const fileInput = $<HTMLInputElement>('fileInput')
const currentImageEl = $('currentImage')
const saveBtn = $<HTMLButtonElement>('saveBtn')
const applyBtn = $<HTMLButtonElement>('applyBtn')
const operatorSelect = $<HTMLSelectElement>('operatorSelect')
const addOperatorBtn = $<HTMLButtonElement>('addOperatorBtn')
const pipelineEl = $('pipeline')
const emptyPipeline = $('emptyPipeline')
const commandPreview = $('commandPreview')
const runBtn = $<HTMLButtonElement>('runBtn')
const historyList = $('historyList')
const emptyHistory = $('emptyHistory')

const pipeline: PipelineStep[] = []
// `currentSource` is the user's chosen input — runs always operate on it.
// `displayedResult` is the most recent successful run's output, shown in the
// viewer but NOT used as the next input until the user clicks "Apply" — that
// way reordering pipeline steps re-runs against the same source rather than
// chaining results.
let currentSource:
  | { kind: 'sample'; url: string; name: string }
  | { kind: 'file'; file: File; name: string }
  | null = null
let displayedResult: { url: string; name: string } | null = null
// Monotonic counter used to discard completions from runs the user has
// already invalidated by loading another image, applying, or starting a
// fresh run.
let latestRunId = 0

const nv = new NiiVueGPU({ isDragDropEnabled: false })
await nv.attachTo('gl1')
nv.multiplanarType = MULTIPLANAR_TYPE.GRID
nv.sliceType = SLICE_TYPE.MULTIPLANAR
nv.showRender = SHOW_RENDER.ALWAYS
nv.crosshairGap = 5
nv.addEventListener('locationChange', (e) => {
  status.textContent = e.detail.string
})

// --- Tabs ---
for (const btn of document.querySelectorAll<HTMLButtonElement>('.tab-btn')) {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab
    if (!target) return
    for (const b of document.querySelectorAll('.tab-btn'))
      b.classList.remove('active')
    for (const p of document.querySelectorAll('.tab-panel'))
      p.classList.remove('active')
    btn.classList.add('active')
    $(`tab-${target}`).classList.add('active')
    if (target === 'history') void refreshHistory()
  })
}

// --- Populate sample selector ---
for (const sample of SAMPLE_VOLUMES) {
  const opt = document.createElement('option')
  opt.value = sample.name
  opt.textContent = sample.label
  sampleSelect.appendChild(opt)
}

// --- Populate operator selector ---
for (const op of NIIMATH_OPERATORS) {
  const opt = document.createElement('option')
  opt.value = op.name
  opt.textContent = `${op.name} — ${op.description}`
  operatorSelect.appendChild(opt)
}
operatorSelect.addEventListener('change', () => {
  addOperatorBtn.disabled = !operatorSelect.value
})

// --- Click-to-copy: generated command and status bar ---
attachClickToCopy(commandPreview)
attachClickToCopy(status)

function attachClickToCopy(el: HTMLElement): void {
  el.classList.add('copyable')
  el.addEventListener('click', async () => {
    const text = el.textContent ?? ''
    if (!text.trim()) return
    try {
      await navigator.clipboard.writeText(text)
    } catch (err) {
      // Permission denied, document not focused, etc. Don't show
      // the "copied" flash — it'd be a lie.
      console.warn('clipboard write failed:', err)
      return
    }
    el.classList.add('copied')
    setTimeout(() => el.classList.remove('copied'), 600)
  })
}

// --- Sample load on selection change ---
sampleSelect.addEventListener('change', async () => {
  const name = sampleSelect.value
  if (!name) return
  await loadSample(name)
})

// --- File upload ---
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0]
  if (!file) return
  await loadFile(file)
  fileInput.value = ''
})

// --- Add operator ---
addOperatorBtn.addEventListener('click', () => {
  const op = NIIMATH_OPERATORS.find((o) => o.name === operatorSelect.value)
  if (!op) return
  pipeline.push({
    operator: op,
    args: op.args.map((a) => a.default ?? ''),
  })
  operatorSelect.value = ''
  addOperatorBtn.disabled = true
  renderPipeline()
})

// --- Run ---
runBtn.addEventListener('click', async () => {
  if (!currentSource || pipeline.length === 0) return
  await runPipeline()
})

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadSample(name: string): Promise<void> {
  setStatus(`Loading ${name}…`, true)
  const myRun = ++latestRunId
  await nv.loadVolumes([{ url: `/volumes/${name}` }])
  // Rapid dropdown switching can race the network; ignore stale loads.
  if (myRun !== latestRunId) return
  currentSource = { kind: 'sample', url: `/volumes/${name}`, name }
  displayedResult = null
  setStatus(`Loaded ${name}`)
  updateCurrentImageDisplay()
  updateCommandPreview()
  updateButtons()
}

async function loadFile(file: File): Promise<void> {
  setStatus(`Loading ${file.name}…`, true)
  const myRun = ++latestRunId
  await nv.loadVolumes([{ url: file, name: file.name }])
  if (myRun !== latestRunId) return
  currentSource = { kind: 'file', file, name: file.name }
  displayedResult = null
  setStatus(`Loaded ${file.name}`)
  updateCurrentImageDisplay()
  updateCommandPreview()
  updateButtons()
}

// ---------------------------------------------------------------------------
// Pipeline UI
// ---------------------------------------------------------------------------

let dragFromIdx: number | null = null

function renderPipeline(): void {
  pipelineEl.innerHTML = ''
  emptyPipeline.classList.toggle('hidden', pipeline.length > 0)
  pipeline.forEach((step, idx) => {
    const item = document.createElement('div')
    item.className = 'pipeline-item'
    item.draggable = true
    item.addEventListener('dragstart', (e) => {
      dragFromIdx = idx
      e.dataTransfer?.setData('text/plain', String(idx))
      item.classList.add('dragging')
    })
    item.addEventListener('dragend', () => {
      dragFromIdx = null
      for (const el of pipelineEl.querySelectorAll('.drag-over, .dragging')) {
        el.classList.remove('drag-over', 'dragging')
      }
    })
    item.addEventListener('dragover', (e) => {
      e.preventDefault()
      if (dragFromIdx !== null && dragFromIdx !== idx)
        item.classList.add('drag-over')
    })
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'))
    item.addEventListener('drop', (e) => {
      e.preventDefault()
      if (dragFromIdx === null || dragFromIdx === idx) return
      const [moved] = pipeline.splice(dragFromIdx, 1)
      pipeline.splice(idx, 0, moved)
      renderPipeline()
    })

    const head = document.createElement('div')
    head.className = 'head'
    const left = document.createElement('div')
    const badge = document.createElement('span')
    badge.className = 'badge'
    badge.textContent = step.operator.name
    left.appendChild(badge)
    head.appendChild(left)

    const remove = document.createElement('button')
    remove.className = 'remove'
    remove.textContent = '×'
    remove.title = 'Remove operation'
    remove.addEventListener('click', () => {
      pipeline.splice(idx, 1)
      renderPipeline()
    })
    head.appendChild(remove)

    item.appendChild(head)

    const desc = document.createElement('div')
    desc.className = 'desc'
    desc.textContent = step.operator.description
    item.appendChild(desc)

    step.operator.args.forEach((argSpec, argIdx) => {
      const row = document.createElement('div')
      row.className = 'arg-row'
      const label = document.createElement('label')
      label.textContent = argSpec.name
      label.title = argSpec.description
      const input = document.createElement('input')
      input.type = 'text'
      input.placeholder = argSpec.description
      input.value = step.args[argIdx] ?? ''
      input.addEventListener('input', () => {
        step.args[argIdx] = input.value
        updateCommandPreview()
      })
      row.appendChild(label)
      row.appendChild(input)
      item.appendChild(row)
    })

    pipelineEl.appendChild(item)
  })
  updateCommandPreview()
  updateButtons()
}

function flattenArgs(): string[] {
  const out: string[] = []
  for (const step of pipeline) {
    out.push(step.operator.name)
    for (const a of step.args) {
      const trimmed = a.trim()
      if (trimmed.length > 0) out.push(trimmed)
    }
  }
  return out
}

function updateCommandPreview(): void {
  const input = currentSource?.name ?? 'input.nii.gz'
  const middle = pipeline.length === 0 ? '' : ` ${flattenArgs().join(' ')}`
  commandPreview.textContent = `niimath ${input}${middle} ${inferOutputName(input)}`
}

function updateCurrentImageDisplay(): void {
  if (!currentSource) {
    currentImageEl.textContent = 'none'
    return
  }
  currentImageEl.textContent = displayedResult
    ? `${currentSource.name} → ${displayedResult.name} (preview, not yet applied)`
    : currentSource.name
}

function updateButtons(): void {
  runBtn.disabled = !currentSource || pipeline.length === 0
  saveBtn.disabled = !currentSource && !displayedResult
  applyBtn.disabled = !displayedResult
}

// Save whatever is in the viewer right now: the most recent server result
// if there is one, otherwise the user's chosen source.
saveBtn.addEventListener('click', () => {
  let href: string
  let download: string
  let revoke = false
  if (displayedResult) {
    href = displayedResult.url
    download = displayedResult.name
  } else if (currentSource?.kind === 'sample') {
    href = currentSource.url
    download = currentSource.name
  } else if (currentSource?.kind === 'file') {
    href = URL.createObjectURL(currentSource.file)
    download = currentSource.name
    revoke = true
  } else {
    return
  }
  const a = document.createElement('a')
  a.href = href
  a.download = download
  document.body.appendChild(a)
  a.click()
  a.remove()
  if (revoke) URL.revokeObjectURL(href)
})

// Promote the most recent result to be the new working input. Lets the user
// chain pipelines explicitly without auto-chaining on every successful run.
applyBtn.addEventListener('click', () => {
  if (!displayedResult) return
  latestRunId++
  currentSource = {
    kind: 'sample',
    url: displayedResult.url,
    name: displayedResult.name,
  }
  displayedResult = null
  updateCurrentImageDisplay()
  updateCommandPreview()
  updateButtons()
  setStatus(`Applied: ${currentSource.name} is now the input.`)
})

// ---------------------------------------------------------------------------
// Run pipeline (server round-trip)
// ---------------------------------------------------------------------------

async function runPipeline(): Promise<void> {
  if (!currentSource) return
  const args = flattenArgs()
  if (args.length === 0) return

  setStatus('Uploading + running niimath on server…', true)
  runBtn.disabled = true

  // Bump on every Run so any earlier in-flight job is invalidated. Each
  // side-effect that mutates global state below is guarded with
  // `if (myRun !== latestRunId) return`. The user clicking Run / loading a
  // new image / applying a result also bumps latestRunId, so a slow job
  // can't smear over user actions.
  const myRun = ++latestRunId
  // Snapshot the source so a mid-flight `currentSource` change doesn't make
  // us re-fetch a different file or relabel the result with the new name.
  const source = currentSource

  try {
    // Bun's req.formData() rejects browser-built multipart bodies on larger
    // files ("missing final boundary"). We send raw bytes + headers instead.
    // Pass `file` (a Blob) directly so fetch can stream rather than buffer
    // the whole ArrayBuffer in JS first.
    let file: File
    if (source.kind === 'file') {
      file = source.file
    } else {
      const srcRes = await fetch(source.url)
      if (!srcRes.ok)
        throw new Error(`Failed to fetch ${source.url}: ${srcRes.status}`)
      file = new File([await srcRes.blob()], source.name, {
        type: 'application/gzip',
      })
    }
    const t0 = performance.now()
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Niimath-Filename': encodeURIComponent(file.name),
        'X-Niimath-Args': JSON.stringify(args),
      },
      body: file,
    })
    const elapsed = ((performance.now() - t0) / 1000).toFixed(2)

    // Read response as text first so a non-JSON body (proxy timeout HTML,
    // empty 504, etc.) tells us what actually came back instead of throwing
    // an opaque "Unexpected end of JSON input".
    const text = await res.text()
    if (myRun !== latestRunId) return // user moved on; don't smear over them
    let body: {
      id?: string
      status?: string
      resultUrl?: string
      error?: string
      durationMs?: number
    } | null = null
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        setStatus(
          `Server returned non-JSON (status ${res.status} after ${elapsed}s): ${text.slice(0, 200)}`,
        )
        return
      }
    }
    if (!res.ok || !body?.resultUrl) {
      const detail =
        body?.error ?? (text.length === 0 ? '(empty body)' : res.statusText)
      setStatus(
        `Server error (status ${res.status} after ${elapsed}s): ${detail}`,
      )
      return
    }

    // Don't pull the result into memory or overwrite currentSource — point
    // at the server URL so reordering pipeline steps re-runs against the
    // same input rather than chaining results. The user clicks "Apply" if
    // they want to chain. (Bonus: avoids a niivue worker-transfer bug where
    // a re-uploaded Blob can come up byte-short.)
    const filename = inferOutputName(file.name)
    // Guard before mutating global state: a stale completion shouldn't
    // smear `displayedResult` or flash its volume into the viewer after
    // the user has moved on. Re-check after `loadVolumes` too — the user
    // may have started another run while it was decoding.
    if (myRun !== latestRunId) return
    displayedResult = { url: body.resultUrl, name: filename }
    await nv.loadVolumes([{ url: body.resultUrl, name: filename }])
    if (myRun !== latestRunId) return
    updateCurrentImageDisplay()
    const serverMs = body.durationMs
      ? `${(body.durationMs / 1000).toFixed(2)}s server`
      : ''
    setStatus(`Done in ${elapsed}s${serverMs ? ` (${serverMs})` : ''}`)
    void refreshHistory()
  } catch (err) {
    if (myRun !== latestRunId) return
    const msg = err instanceof Error ? err.message : String(err)
    // "Failed to fetch" is the canonical browser error for "the request never
    // got a response" — usually the API server isn't running. Probe the
    // health endpoint to confirm and give the user something actionable.
    if (msg.toLowerCase().includes('failed to fetch')) {
      const reachable = await fetch('/api/health')
        .then((r) => r.ok)
        .catch(() => false)
      setStatus(
        reachable
          ? `Run failed: ${msg} (server reachable but request was dropped — check the server terminal).`
          : 'Run failed: niimath server unreachable on :8087. Start it with `bunx nx dev demo-ext-fullstack` (or `bun run server`).',
      )
    } else {
      setStatus(`Run failed: ${msg}`)
    }
  } finally {
    // Only the live run owns the run button; otherwise a stale completion
    // would re-enable Run while a fresh job is still in flight, letting the
    // user double-submit.
    if (myRun === latestRunId) {
      runBtn.disabled = false
      updateButtons()
    }
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

async function refreshHistory(): Promise<void> {
  try {
    const res = await fetch('/api/jobs')
    if (!res.ok) return
    const { jobs } = (await res.json()) as { jobs: JobSummary[] }
    historyList.innerHTML = ''
    emptyHistory.classList.toggle('hidden', jobs.length > 0)
    for (const job of jobs) renderHistoryItem(job)
  } catch {
    /* server not reachable — leave history empty */
  }
}

function renderHistoryItem(job: JobSummary): void {
  const item = document.createElement('div')
  item.className = 'history-item'

  const top = document.createElement('div')
  top.className = 'top'
  const cmd = document.createElement('code')
  cmd.textContent = job.args.join(' ')
  top.appendChild(cmd)
  const statusSpan = document.createElement('span')
  statusSpan.className = `status-${job.status}`
  statusSpan.textContent = job.status
  top.appendChild(statusSpan)
  item.appendChild(top)

  const meta = document.createElement('div')
  meta.className = 'meta'
  const when = new Date(job.startedAt).toLocaleTimeString()
  const dur = job.durationMs ? `${(job.durationMs / 1000).toFixed(2)}s` : '—'
  meta.textContent = `${job.inputName} · ${when} · ${dur}`
  item.appendChild(meta)

  if (job.error) {
    const err = document.createElement('div')
    err.className = 'meta status-failed'
    err.textContent = job.error
    item.appendChild(err)
  }

  if (job.status === 'completed') {
    const reload = document.createElement('button')
    reload.style.marginTop = '0.4rem'
    reload.textContent = 'Reload result'
    reload.addEventListener('click', async () => {
      setStatus(`Reloading job ${job.id}…`, true)
      latestRunId++
      const url = `/api/result/${job.id}`
      const filename = inferOutputName(job.inputName)
      try {
        await nv.loadVolumes([{ url, name: filename }])
      } catch (err) {
        setStatus(
          `Reload failed (result may have been cleared on server restart): ${err instanceof Error ? err.message : String(err)}`,
        )
        return
      }
      currentSource = { kind: 'sample', url, name: filename }
      displayedResult = null
      updateCurrentImageDisplay()
      updateCommandPreview()
      updateButtons()
      setStatus('Reloaded.')
    })
    item.appendChild(reload)
  }

  historyList.appendChild(item)
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function checkHealth(): Promise<void> {
  try {
    const res = await fetch('/api/health')
    const body = (await res.json()) as {
      ok: boolean
      niimath: { tag: string } | null
    }
    if (body.niimath) {
      health.textContent = `server ok · niimath ${body.niimath.tag}`
      health.classList.remove('error')
      health.classList.add('ok')
    } else {
      health.textContent =
        'server up · niimath NOT installed (run `bun run setup`)'
      health.classList.add('error')
    }
  } catch {
    health.textContent = 'server unreachable'
    health.classList.add('error')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setStatus(text: string, busy = false): void {
  status.textContent = text
  spinner.classList.toggle('hidden', !busy)
}

renderPipeline()
void checkHealth()
void refreshHistory()
sampleSelect.value = SAMPLE_VOLUMES[0].name
void loadSample(SAMPLE_VOLUMES[0].name)
