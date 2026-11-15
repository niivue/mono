import { convert } from '@niivue/dcm2niix'
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

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue()
  await nv.attachToCanvas(canvas)
  const say = ui.status()
  let busy = false

  const show = async (label: string, files: () => Promise<File[]> | File[]) => {
    if (busy) return
    busy = true
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
      say(
        `${label}: ${input.length} file(s) to ${series.length} series in ${s} s; ` +
          `showing ${series[0].image.name}`,
      )
    } catch (e) {
      say(`Could not convert ${label}: ${e instanceof Error ? e.message : e}`)
    } finally {
      busy = false
    }
  }

  const enhanced = () =>
    show('enhanced DICOM', async () => [
      await fetchFile(asset('dicom/enhanced_T1w.dcm')),
    ])
  ui.button('Enhanced DICOM (1 file)', enhanced)
  ui.button('Classic series (120 files)', () =>
    show('classic series', () => fetchSeries(SERIES)),
  )
  ui.files('Your DICOM folder', (files) => show('your folder', () => files), {
    directory: true,
  })
  await enhanced()
  return nv
}

export default demo
