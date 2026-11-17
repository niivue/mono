import { convert, filesFromDataTransfer } from '@niivue/dcm2niix'
import NiiVue from '@niivue/niivue'
import type { Demo } from './types'

// A classic DICOM series: one file per slice, listed in a manifest.
const SERIES =
  'https://niivue.github.io/niivue-demo-images/dicom/niivue-manifest.txt'

/** A File that dcm2niix groups into one folder (it reads `_webkitRelativePath`). */
function inFolder(data: BlobPart, name: string): File {
  const file = new File([data], name) as File & { _webkitRelativePath?: string }
  file._webkitRelativePath = `series/${name}`
  return file
}

async function fetchFile(url: string): Promise<File> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return inFolder(await res.arrayBuffer(), url.split('/').pop() ?? 'dicom')
}

async function fetchSeries(manifest: string): Promise<File[]> {
  const res = await fetch(manifest)
  if (!res.ok) throw new Error(`${manifest}: ${res.status}`)
  const names = (await res.text()).split('\n').filter((l) => l.trim())
  return Promise.all(names.map((n) => fetchFile(new URL(n, manifest).href)))
}

/** Loose files (no folder) join one series folder; a dropped folder keeps its own. */
function grouped(files: File[]): File[] {
  return files.map((f) => {
    const path =
      f.webkitRelativePath ||
      (f as File & { _webkitRelativePath?: string })._webkitRelativePath
    return path?.includes('/') ? f : inFolder(f, f.name)
  })
}

const demo: Demo = async (canvas, { ui, asset }) => {
  // Drops are converted here: NiiVue would try to read DICOM as an image.
  const nv = new NiiVue({ isDragDropEnabled: false })
  await nv.attachToCanvas(canvas)
  const say = ui.status()
  let busy = false
  // The menu entry on screen. Each conversion commits it only once its image
  // shows, and the menu always returns to it, so a failure leaves the menu
  // naming what is shown.
  // Empty until the first image shows, so a failed first load can be retried.
  let shown = ''

  /** Convert files and show the first series as `menuValue`. */
  const show = async (
    label: string,
    menuValue: string,
    files: () => Promise<File[]> | File[],
    onShown = () => {},
  ) => {
    if (busy) return
    busy = true
    menu.disabled = true
    say(`Reading ${label}...`)
    try {
      const input = await files()
      const t0 = performance.now()
      // A nonzero exit still returns the series that converted.
      const { series, log } = await convert(input)
      const s = ((performance.now() - t0) / 1000).toFixed(1)
      if (!series.length) {
        say(`No image from ${label}: ${log.at(-1) ?? ''}`)
        return
      }
      await nv.loadVolumes([{ url: series[0].image }])
      shown = menuValue
      onShown()
      say(
        `${label}: ${input.length} file(s) to ${series.length} series in ${s} s; ` +
          `showing ${series[0].image.name}`,
      )
    } catch (e) {
      say(`Could not convert ${label}: ${e instanceof Error ? e.message : e}`)
    } finally {
      busy = false
      menu.disabled = false
      menu.value = shown
    }
  }

  // Your files get their own entry once shown, so "Local files..." always
  // opens the picker.
  let localFiles: File[] = []
  const mine = new Option('', 'mine')
  const sources: Record<string, () => Promise<void>> = {
    enhanced: () =>
      show('enhanced DICOM', 'enhanced', async () => [
        await fetchFile(asset('dicom/enhanced_T1w.dcm')),
      ]),
    classic: () => show('classic series', 'classic', () => fetchSeries(SERIES)),
    mine: () => show('your files', 'mine', () => grouped(localFiles)),
  }
  const picker = document.createElement('input')
  picker.type = 'file'
  picker.multiple = true
  const menu = ui.select(
    'DICOM',
    [
      ['Enhanced (1 file)', 'enhanced'],
      ['Classic series (120 files)', 'classic'],
      ['Local files...', 'local'],
    ],
    'enhanced',
    (v) => {
      if (v === 'local') {
        menu.value = shown
        picker.click()
      } else sources[v]()
    },
  )
  const busyNote = () => say('Still converting: drop again when it finishes.')
  const local = (files: File[]) => {
    if (busy) return busyNote()
    show(
      'your files',
      'mine',
      () => grouped(files),
      () => {
        localFiles = files
        mine.text = files.length === 1 ? files[0].name : `${files.length} files`
        menu.add(mine, menu.options.length - 1)
      },
    )
  }
  picker.onchange = () => {
    if (picker.files?.length) local(Array.from(picker.files))
    picker.value = ''
  }
  canvas.addEventListener('dragover', (e) => e.preventDefault())
  canvas.addEventListener('drop', async (e) => {
    e.preventDefault()
    if (!e.dataTransfer) return
    if (busy) return busyNote()
    // Read before any await: the drop's data is gone once the event returns.
    // Folders need the entry walk; plain files are the fallback where it finds
    // none (browsers without webkitGetAsEntry).
    const loose = Array.from(e.dataTransfer.files)
    const walked = await filesFromDataTransfer(e.dataTransfer.items)
    local(walked.length ? walked : loose)
  })
  await sources.enhanced()
  return nv
}

export default demo
