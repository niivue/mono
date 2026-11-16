import { Niimath } from '@niivue/niimath'
import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import type { Demo } from './types'

// The 7T scans live beside the niivue-niimath demo, which serves them with CORS.
const NIIMATH_SITE = 'https://niivue.github.io/niivue-niimath/'
const VOLUMES: [
  label: string,
  url: (asset: (p: string) => string) => string,
][] = [
  ['mni152', (asset) => asset('volumes/mni152.nii.gz')],
  ['T1w 7T', () => `${NIIMATH_SITE}T1w7T.nii.gz`],
  ['T2w 7T', () => `${NIIMATH_SITE}T2w7T.nii.gz`],
]

// Pipelines as niimath options: args() takes them as typed on the command line.
// An empty list shows the input as is; null meshes it.
const PIPELINES: [label: string, args: (string | number)[] | null][] = [
  ['Original', []],
  ['Smooth (-s 3)', ['-s', 3]],
  ['Edges (-dog 2 3.2)', ['-dog', 2, 3.2]],
  ['Otsu mask (-otsu 3)', ['-otsu', 3]],
  ['Threshold 50% and binarize', ['-thrp', 50, '-bin']],
  ['Mesh (marching cubes)', null],
]

const demo: Demo = async (canvas, { ui, asset }) => {
  // Drops are handled here, so they become niimath's input.
  const nv = new NiiVue({ isColorbarVisible: false, isDragDropEnabled: false })
  await nv.attachToCanvas(canvas)
  const say = ui.status()
  const niimath = new Niimath()
  await niimath.init()

  // What is on screen. Each operation commits these only once it succeeds,
  // and the menus always return to them, so a failure leaves the menus
  // naming what is shown.
  let input: File | null = null
  let pipeline = 0
  // Empty until the first volume shows, so a failed first load can be retried.
  let shown = ''
  const controls: HTMLSelectElement[] = []
  const busy = () => controls.some((c) => c.disabled)
  const sync = () => {
    volumeMenu.value = shown
    pipelineMenu.value = String(pipeline)
  }

  // One operation at a time, from the choice until the viewer shows its result:
  // a Niimath instance serves one run(), and a volume picked mid-run would
  // otherwise be replaced by the old input's result.
  const act = async (label: string, step: () => Promise<void>) => {
    if (busy()) return
    for (const c of controls) c.disabled = true
    say(`${label}...`)
    try {
      await step()
    } catch (e) {
      say(`${label} failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      for (const c of controls) c.disabled = false
      sync()
    }
  }
  // The status names a result once it is on screen.
  const report = (out: File, t0: number) =>
    say(`${out.name} in ${((performance.now() - t0) / 1000).toFixed(1)} s`)

  // Show `source` through pipeline `p`.
  const apply = async (source: File, p: number) => {
    const [label, args] = PIPELINES[p]
    const t0 = performance.now()
    if (args === null) {
      // Geometry: marching cubes at a medium isosurface, bubbles filled.
      const out = await niimath
        .image(source)
        .mesh({ i: 'm', b: 1 })
        .run('mesh.mz3')
      await nv.removeAllMeshes()
      await nv.loadVolumes([{ url: source }])
      await nv.loadMeshes([{ url: out }])
      // The mesh hides the 2D slices, so show it in 3D.
      nv.sliceType = SLICE_TYPE.RENDER
      report(out, t0)
      return
    }
    const out =
      args.length === 0
        ? source
        : await niimath.image(source).args(args).run('result.nii.gz')
    await nv.removeAllMeshes()
    await nv.loadVolumes([{ url: out }])
    nv.sliceType = SLICE_TYPE.MULTIPLANAR
    if (args.length === 0) say(`${source.name}: ${label.toLowerCase()}`)
    else report(out, t0)
  }

  /** Open a volume as `menuValue` through the current pipeline. */
  const open = (
    label: string,
    menuValue: string,
    file: () => Promise<File>,
    onShown = () => {},
  ) =>
    act(`Loading ${label}`, async () => {
      const source = await file()
      await apply(source, pipeline)
      input = source
      shown = menuValue
      onShown()
    })
  const fetchVolume = (index: number) => {
    const [label, url] = VOLUMES[index]
    return open(label, String(index), async () => {
      const href = url(asset)
      const res = await fetch(href)
      if (!res.ok) throw new Error(`${href}: ${res.status}`)
      return new File([await res.arrayBuffer()], href.split('/').pop() ?? label)
    })
  }

  // Your file gets its own entry once shown, so "Local file..." always opens
  // the picker.
  let localFile: File | null = null
  const mine = new Option('', 'mine')
  const picker = document.createElement('input')
  picker.type = 'file'
  picker.accept = '.nii,.nii.gz'
  const volumeMenu = ui.select(
    'Volume',
    [
      ...VOLUMES.map(([label], i): [string, string] => [label, String(i)]),
      ['Local file...', 'local'],
    ],
    '0',
    (v) => {
      if (v === 'local') {
        sync()
        picker.click()
      } else if (v === 'mine' && localFile) {
        const file = localFile
        open(file.name, 'mine', async () => file)
      } else fetchVolume(Number(v))
    },
  )
  const pipelineMenu = ui.select(
    'Pipeline',
    PIPELINES.map(([label], i) => [label, String(i)]),
    '0',
    (v) => {
      const p = Number(v)
      act(PIPELINES[p][0], async () => {
        if (!input) return
        await apply(input, p)
        pipeline = p
      })
    },
  )
  controls.push(volumeMenu, pipelineMenu)

  const local = (file: File) => {
    if (busy()) {
      say('Still working: drop again when it finishes.')
      return
    }
    open(
      file.name,
      'mine',
      async () => file,
      () => {
        localFile = file
        mine.text = file.name
        volumeMenu.add(mine, volumeMenu.options.length - 1)
      },
    )
  }
  picker.onchange = () => {
    const file = picker.files?.[0]
    if (file) local(file)
    picker.value = ''
  }
  canvas.addEventListener('dragover', (e) => e.preventDefault())
  canvas.addEventListener('drop', (e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files[0]
    if (file) local(file)
  })

  await fetchVolume(0)
  return nv
}

export default demo
