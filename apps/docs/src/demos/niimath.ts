import { Niimath } from '@niivue/niimath'
import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import type { Demo } from './types'

// Pipelines as niimath options: args() takes them as typed on the command line.
const PIPELINES: [label: string, args: (string | number)[]][] = [
  ['Smooth (-s 3)', ['-s', 3]],
  ['Edges (-dog 2 3.2)', ['-dog', 2, 3.2]],
  ['Otsu mask (-otsu 3)', ['-otsu', 3]],
  ['Threshold 50% and binarize', ['-thrp', 50, '-bin']],
]

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue({ isColorbarVisible: false })
  await nv.attachToCanvas(canvas)
  const say = ui.status()
  const niimath = new Niimath()
  await niimath.init()

  const res = await fetch(asset('volumes/mni152.nii.gz'))
  let input = new File([await res.arrayBuffer()], 'mni152.nii.gz')
  await nv.loadVolumes([{ url: input }])
  let pipeline = 0
  const controls: (HTMLButtonElement | HTMLInputElement | HTMLSelectElement)[] =
    []

  // One operation at a time, from the click until the viewer shows its result:
  // a Niimath instance serves one run(), and a file picked mid-run would
  // otherwise be replaced by the old input's result.
  const act = async (label: string, step: () => Promise<void>) => {
    if (controls.some((c) => c.disabled)) return
    for (const c of controls) c.disabled = true
    say(`${label}...`)
    try {
      await step()
    } catch (e) {
      say(`${label} failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      for (const c of controls) c.disabled = false
    }
  }
  const timed = async (job: () => Promise<File>) => {
    const t0 = performance.now()
    const out = await job()
    say(`${out.name} in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
    return out
  }

  controls.push(
    ui.select(
      'Pipeline',
      PIPELINES.map(([label], i) => [label, String(i)]),
      '0',
      (v) => {
        pipeline = Number(v)
      },
    ),
    ui.button('Run', () =>
      act('Running niimath', async () => {
        const out = await timed(() =>
          niimath
            .image(input)
            .args(PIPELINES[pipeline][1])
            .run('result.nii.gz'),
        )
        nv.sliceType = SLICE_TYPE.MULTIPLANAR
        await nv.removeAllMeshes()
        await nv.loadVolumes([{ url: out }])
      }),
    ),
    // Geometry: marching cubes at a medium isosurface, bubbles filled.
    ui.button('Mesh', () =>
      act('Meshing', async () => {
        const source = input
        const out = await timed(() =>
          niimath.image(source).mesh({ i: 'm', b: 1 }).run('mesh.mz3'),
        )
        await nv.loadVolumes([{ url: source }])
        await nv.loadMeshes([{ url: out }])
        // The mesh hides the 2D slices, so show it in 3D.
        nv.sliceType = SLICE_TYPE.RENDER
      }),
    ),
    ui.files(
      'Your NIfTI',
      ([file]) =>
        act(`Loading ${file.name}`, async () => {
          input = file
          nv.sliceType = SLICE_TYPE.MULTIPLANAR
          await nv.removeAllMeshes()
          await nv.loadVolumes([{ url: input }])
          say(`Loaded ${file.name}`)
        }),
      { accept: '.nii,.nii.gz' },
    ),
  )
  return nv
}

export default demo
