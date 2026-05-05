/**
 * NiiVue + niimath WASM demo.
 *
 * Same UI as demo-ext-fullstack, but niimath runs in a Web Worker via the
 * @niivue/niimath package — no backend, no HTTP, no auth, deployable as a
 * static site to GitHub Pages.
 */

import NiiVueGPU, {
  MULTIPLANAR_TYPE,
  SHOW_RENDER,
  SLICE_TYPE,
} from '@niivue/niivue'
import {
  Niimath,
  type NiimathStep,
  runNiimathPipeline,
} from '@niivue/nv-ext-niimath'
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

interface HistoryEntry {
  id: string
  args: string[]
  inputName: string
  outputName: string
  startedAt: number
  durationMs: number
  status: 'completed' | 'failed'
  blob?: Blob
  error?: string
}

// Cap in-memory history. Each entry retains a result Blob, so user uploads
// of hundreds of MB can blow through browser memory if we only count
// entries. Apply both a count cap and a total-bytes cap; evict oldest
// until both are satisfied.
const HISTORY_CAP = 20
const HISTORY_BYTE_CAP = 256 * 1024 * 1024 // 256 MB

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
// `displayedResult` is the most recent successful run's output, shown in
// the viewer but NOT used as the next input until the user clicks Apply
// — that way reordering pipeline steps re-runs against the same source
// rather than chaining results.
let currentSource:
  | { kind: 'sample'; url: string; name: string }
  | { kind: 'file'; file: File; name: string }
  | null = null
let displayedResult: { blob: Blob; name: string } | null = null
const history: HistoryEntry[] = []
// Monotonic counter used to discard completions from runs the user has
// already invalidated by loading another image, applying, or starting a
// fresh run.
let latestRunId = 0

const niimath = new Niimath()
const niimathReady = niimath.init()

const nv = new NiiVueGPU({ isDragDropEnabled: false })
await nv.attachTo('gl1')
nv.multiplanarType = MULTIPLANAR_TYPE.GRID
nv.sliceType = SLICE_TYPE.MULTIPLANAR
nv.showRender = SHOW_RENDER.ALWAYS
nv.crosshairGap = 5
nv.addEventListener('locationChange', (e) => {
  status.textContent = e.detail.string
})

niimathReady
  .then((ok) => {
    if (ok) {
      health.textContent = 'niimath WASM ready'
      health.classList.add('ok')
    } else {
      health.textContent = 'niimath WASM failed to initialize'
      health.classList.add('error')
    }
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    health.textContent = `niimath WASM error: ${msg}`
    health.classList.add('error')
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
    if (target === 'history') renderHistory()
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
    await navigator.clipboard.writeText(text)
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
    href = URL.createObjectURL(displayedResult.blob)
    download = displayedResult.name
    revoke = true
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

// Promote the most recent result to be the new working input.
applyBtn.addEventListener('click', () => {
  if (!displayedResult) return
  latestRunId++
  const file = new File([displayedResult.blob], displayedResult.name, {
    type: 'application/gzip',
  })
  currentSource = { kind: 'file', file, name: displayedResult.name }
  displayedResult = null
  updateCurrentImageDisplay()
  updateCommandPreview()
  updateButtons()
  setStatus(`Applied: ${currentSource.name} is now the input.`)
})

// ---------------------------------------------------------------------------
// Run pipeline (WASM in-browser)
// ---------------------------------------------------------------------------

async function runPipeline(): Promise<void> {
  if (!currentSource || pipeline.length === 0) return

  setStatus('Running niimath WASM…', true)
  runBtn.disabled = true
  const myRun = ++latestRunId
  const source = currentSource
  const steps: NiimathStep[] = pipeline.map((s) => ({
    method: s.operator.name.slice(1), // drop leading '-'
    args: s.args.map((a) => a.trim()).filter((a) => a.length > 0),
  }))
  // Reconstruct the dash-prefixed flat form for history display. Coerce
  // numeric args back to strings — NiimathStep allows numbers.
  const args = steps.flatMap((s) => [`-${s.method}`, ...s.args.map(String)])

  try {
    await niimathReady
    const file = await sourceAsFile(source)
    const t0 = performance.now()
    const blob = await runNiimathPipeline(niimath, file, steps)
    const elapsed = ((performance.now() - t0) / 1000).toFixed(2)
    if (myRun !== latestRunId) return

    const filename = inferOutputName(file.name)
    displayedResult = { blob, name: filename }
    const previewFile = new File([blob], filename, { type: 'application/gzip' })
    await nv.loadVolumes([{ url: previewFile, name: filename }])
    if (myRun !== latestRunId) return
    updateCurrentImageDisplay()
    pushHistory({
      id: crypto.randomUUID(),
      args,
      inputName: file.name,
      outputName: filename,
      startedAt: Date.now(),
      durationMs: Number(elapsed) * 1000,
      status: 'completed',
      blob,
    })
    setStatus(`Done in ${elapsed}s`)
  } catch (err) {
    if (myRun !== latestRunId) return
    const msg = err instanceof Error ? err.message : String(err)
    pushHistory({
      id: crypto.randomUUID(),
      args,
      inputName: source.name,
      outputName: inferOutputName(source.name),
      startedAt: Date.now(),
      durationMs: 0,
      status: 'failed',
      error: msg,
    })
    setStatus(`Run failed: ${msg}`)
  } finally {
    if (myRun === latestRunId) {
      runBtn.disabled = false
      updateButtons()
    }
  }
}

async function sourceAsFile(
  src: NonNullable<typeof currentSource>,
): Promise<File> {
  if (src.kind === 'file') return src.file
  const res = await fetch(src.url)
  if (!res.ok) throw new Error(`Failed to fetch ${src.url}: ${res.status}`)
  const blob = await res.blob()
  return new File([blob], src.name, { type: 'application/gzip' })
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function historyByteSize(): number {
  let n = 0
  for (const e of history) n += e.blob?.size ?? 0
  return n
}

function pushHistory(entry: HistoryEntry): void {
  history.unshift(entry)
  // Evict oldest entries until both caps are satisfied. The just-pushed
  // entry sits at index 0 and is never the eviction target.
  while (
    history.length > HISTORY_CAP ||
    (history.length > 1 && historyByteSize() > HISTORY_BYTE_CAP)
  ) {
    history.pop()
  }
  renderHistory()
}

function renderHistory(): void {
  historyList.innerHTML = ''
  emptyHistory.classList.toggle('hidden', history.length > 0)
  for (const entry of history) renderHistoryItem(entry)
}

function renderHistoryItem(entry: HistoryEntry): void {
  const item = document.createElement('div')
  item.className = 'history-item'

  const top = document.createElement('div')
  top.className = 'top'
  const cmd = document.createElement('code')
  cmd.textContent = entry.args.join(' ')
  top.appendChild(cmd)
  const statusSpan = document.createElement('span')
  statusSpan.className = `status-${entry.status}`
  statusSpan.textContent = entry.status
  top.appendChild(statusSpan)
  item.appendChild(top)

  const meta = document.createElement('div')
  meta.className = 'meta'
  const when = new Date(entry.startedAt).toLocaleTimeString()
  const dur =
    entry.durationMs > 0 ? `${(entry.durationMs / 1000).toFixed(2)}s` : '—'
  meta.textContent = `${entry.inputName} · ${when} · ${dur}`
  item.appendChild(meta)

  if (entry.error) {
    const err = document.createElement('div')
    err.className = 'meta status-failed'
    err.textContent = entry.error
    item.appendChild(err)
  }

  if (entry.status === 'completed' && entry.blob) {
    const reload = document.createElement('button')
    reload.style.marginTop = '0.4rem'
    reload.textContent = 'Reload result'
    reload.addEventListener('click', async () => {
      if (!entry.blob) return
      latestRunId++
      const file = new File([entry.blob], entry.outputName, {
        type: 'application/gzip',
      })
      await nv.loadVolumes([{ url: file, name: entry.outputName }])
      currentSource = { kind: 'file', file, name: entry.outputName }
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
// Helpers
// ---------------------------------------------------------------------------

function setStatus(text: string, busy = false): void {
  status.textContent = text
  spinner.classList.toggle('hidden', !busy)
}

renderPipeline()
sampleSelect.value = SAMPLE_VOLUMES[0].name
void loadSample(SAMPLE_VOLUMES[0].name)
