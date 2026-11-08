import type NiiVue from '../src/NVControl'
import { registerScenes, type Scene } from './renderHarness'

// Reference images for label colormaps (issue #69): a NIFTI_INTENT_LABEL
// volume defaults to the generated Random palette, label LUTs wrap into rows
// of 256 so wide ID ranges upload on any GPU, the palette grows with IDs
// written later (edits, 4D frames, streamed bricks), and setVolume switches
// between continuous and label colormaps. State-only cases are in
// src/cmap/labelColormaps.test.ts. See renderHarness.ts for how scenes run.
//
// Every scene draws a 32x32x4 int16 label volume, axial: the left half holds
// ID 3 and the right half ID 20000. A one-row LUT that wide exceeds
// SwiftShader's 8192-texel limit; wrapped, ID 20000 sits in row 78.

type Source = Parameters<NiiVue['loadChunkedVolume']>[0]

const SCENES: Scene[] = [
  {
    name: 'label-intent',
    options: { sliceType: 0 },
    setup: async ({ nv, p, check }) => {
      const labels = p.labelHalves
      await nv.loadVolumes([{ url: labels() }])
      const v = nv.volumes[0]
      check(v.colormap === 'Random', `colormap ${v.colormap}`)
      check(
        v.colormapLabel?.min === 0 && v.colormapLabel?.max === 20000,
        `range ${v.colormapLabel?.min}..${v.colormapLabel?.max}`,
      )
    },
  },
  {
    // A live edit writes ID 30000 into the right half: a LUT fixed at load
    // would clamp it to ID 20000's colour. An in-place isDirty edit grows it
    // the same way.
    name: 'label-grow',
    options: { sliceType: 0 },
    setup: async ({ nv, p, check }) => {
      const labels = p.labelHalves
      await nv.loadVolumes([{ url: labels() }])
      const v = nv.volumes[0]
      const next = Int16Array.from(v.img as Int16Array, (id) =>
        id === 20000 ? 30000 : id,
      )
      await nv.updateVolumeData(0, next)
      check(v.colormapLabel?.max === 30000, `max ${v.colormapLabel?.max}`)
    },
    steps: [
      {
        name: 'dirty',
        run: async ({ nv, check }) => {
          const v = nv.volumes[0]
          const img = v.img as Int16Array
          for (let i = 0; i < img.length; i++) if (img[i] === 3) img[i] = 31000
          v.isDirty = true
          await nv.updateGLVolume()
          check(v.colormapLabel?.max === 31000, `max ${v.colormapLabel?.max}`)
        },
      },
    ],
  },
  {
    // Frame 0's range says nothing about frame 1's IDs (only the right half
    // is labelled in frame 1, in ID 20000's colour).
    name: 'label-4d',
    options: { sliceType: 0 },
    setup: async ({ nv, p, check }) => {
      const labels = p.labelHalves
      await nv.loadVolumes([{ url: labels(2) }])
      const v = nv.volumes[0]
      await nv.setFrame4D(v.id, 1)
      check(v.nFrame4D === 2, `frames ${v.nFrame4D}`)
      check(v.colormapLabel?.max === 20000, `max ${v.colormapLabel?.max}`)
    },
  },
  {
    // The coarse level (all the floor and window samples read) holds only
    // ID 3; only the decoded fine bricks can widen the palette to 20000.
    name: 'label-streamed',
    sameAs: 'label-intent',
    options: { sliceType: 0 },
    setup: async ({ nv, p, check, settle }) => {
      await nv.loadChunkedVolume(p.labelHalvesSource() as Source, {
        colormap: 'Random',
      })
      await settle()
      const lut = nv.volumes[0]?.colormapLabel
      check(lut?.max === 20000, `max ${lut?.max}`)
      // Re-streamed bricks are covered, so the palette settles.
      await settle()
      check(nv.volumes[0]?.colormapLabel === lut, 'palette settled')
    },
  },
  {
    // Explicit bounds do not stop the growth.
    name: 'label-streamed-explicit',
    sameAs: 'label-intent',
    options: { sliceType: 0 },
    setup: async ({ nv, p, check, settle }) => {
      await nv.loadChunkedVolume(p.labelHalvesSource() as Source, {
        colormap: 'Random',
        calMin: 0,
        calMax: 1,
      })
      await settle()
      const max = nv.volumes[0]?.colormapLabel?.max
      check(max === 20000, `max ${max}`)
    },
  },
  {
    // Shown in gray first, so every brick is decoded (and cached) before the
    // palette is generated; switching to Random must cover them.
    name: 'label-streamed-switch',
    sameAs: 'label-intent',
    options: { sliceType: 0 },
    setup: async ({ nv, p, check, settle }) => {
      await nv.loadChunkedVolume(p.labelHalvesSource() as Source, {
        colormap: 'gray',
        calMin: 0,
        calMax: 1,
      })
      await settle()
      await nv.setVolume(0, { colormap: 'Random' })
      await settle()
      check(
        nv.volumes[0]?.colormapLabel?.max === 20000,
        `max ${nv.volumes[0]?.colormapLabel?.max}`,
      )
    },
  },
  {
    // setVolume switches a label volume to gray (no label table) and to a
    // named label table: ID 3 green, ID 20000 red. Re-registering the name
    // recolours the volume using it.
    name: 'label-switch',
    options: { sliceType: 0 },
    setup: async ({ nv, p, check }) => {
      const labels = p.labelHalves
      await nv.loadVolumes([{ url: labels() }])
      await nv.setVolume(0, { colormap: 'gray' })
      check(nv.volumes[0].colormapLabel === null, 'gray has no label table')
      const name = nv.addColormap('halves', {
        R: [0, 0, 255],
        G: [0, 255, 0],
        B: [0, 0, 0],
        I: [0, 3, 20000],
        labels: ['air', 'left', 'right'],
      })
      await nv.setVolume(0, { colormap: name })
      const lut = nv.volumes[0].colormapLabel
      check(
        lut?.labels?.[3] === 'left' && lut?.labels?.[20000] === 'right',
        'label names',
      )
      check(nv.colormapNames('label').includes(name), 'listed as label')
      check(!nv.colormapNames('continuous').includes(name), 'not continuous')
    },
    steps: [
      {
        name: 'reregistered',
        run: async ({ nv }) => {
          nv.addColormap('halves', {
            R: [0, 0, 0],
            G: [0, 0, 0],
            B: [0, 255, 255],
            I: [0, 3, 20000],
            labels: ['air', 'left', 'right'],
          })
          await nv.updateGLVolume()
        },
      },
    ],
  },
  {
    // prepareVolume loads without adding; addVolume applies its colormap.
    name: 'label-prepared',
    sameAs: 'label-switch',
    options: { sliceType: 0 },
    setup: async ({ nv, p, check }) => {
      const labels = p.labelHalves
      const prepared = await nv.prepareVolume({
        url: labels(),
        colormap: 'gray',
      })
      check(nv.volumes.length === 0, 'prepareVolume adds nothing')
      prepared.colormap = nv.addColormap('preparedHalves', {
        R: [0, 0, 255],
        G: [0, 255, 0],
        B: [0, 0, 0],
        I: [0, 3, 20000],
        labels: ['air', 'left', 'right'],
      })
      await nv.addVolume(prepared)
      const lut = nv.volumes[0].colormapLabel
      check(nv.volumes.length === 1, 'addVolume adds it')
      check(
        lut?.labels?.[3] === 'left' && lut?.labels?.[20000] === 'right',
        'label names',
      )
    },
  },
]

registerScenes(SCENES)
