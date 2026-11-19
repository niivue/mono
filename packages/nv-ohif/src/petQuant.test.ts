import { expect, it } from 'bun:test'
import NiiVue from '@niivue/niivue'
import { getNiivueCommandsModule } from './commands'
import {
  getNiivueEntry,
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
import { setOverlayPlanes } from './overlayPlanes'
import {
  armBrush,
  getQuantCommandDefinitions,
  resetQuant,
  showPaneLabel,
  tmtvCsv,
} from './petQuant'
import { tmtvDataset } from './segCommands'

// 2x2x2 uint8 NIfTI-1, 1 mm voxels, every voxel `fill`.
function nifti(fill = 5, name = 'pet.nii'): File {
  const hdr = new DataView(new ArrayBuffer(352))
  hdr.setInt32(0, 348, true)
  for (const [i, d] of [3, 2, 2, 2].entries()) hdr.setInt16(40 + 2 * i, d, true)
  hdr.setInt16(70, 2, true)
  hdr.setInt16(72, 8, true)
  hdr.setFloat32(108, 352, true)
  for (const i of [1, 2, 3]) hdr.setFloat32(76 + 4 * i, 1, true)
  hdr.setUint32(344, 0x00312b6e, true) // magic 'n+1'
  return new File([hdr.buffer, new Uint8Array(8).fill(fill)], name)
}

// Audit 22.3: Add Segment / segment selection must retarget an armed brush;
// an armed eraser keeps painting 0.
it('segment change retargets an armed brush pen, not an eraser', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  await nv.loadVolumes([{ url: nifti() }])
  registerNiivue('pet', nv)
  updateNiivueViewport('pet', {
    displaySets: [{ displaySetInstanceUID: 'pt', Modality: 'PT' } as never],
  })
  const services = {
    services: { viewportGridService: { getActiveViewportId: () => 'pet' } },
  } as never
  const cmd = getQuantCommandDefinitions({
    servicesManager: services,
  } as never) as unknown as Record<string, { commandFn: (o: object) => void }>
  expect(armBrush('pet', 'CircularBrush', services, () => 5)).toBe(true)
  cmd.niivueAddSegment?.commandFn({})
  expect(nv.drawPenValue).toBe(2)
  armBrush('pet', 'CircularEraser', services, () => 5)
  cmd.niivueSetActiveSegment?.commandFn({ segmentIndex: 1 })
  expect(nv.drawPenValue).toBe(0)
  // Holistic review H16: a mode exit drops the masks and the segment list.
  armBrush('pet', 'CircularBrush', services, () => 5)
  cmd.niivueAddSegment?.commandFn({})
  expect(nv.drawPenValue).toBe(3)
  resetQuant()
  expect(nv.drawPenValue).toBe(1)
  cmd.niivueAddSegment?.commandFn({})
  expect(nv.drawPenValue).toBe(2)
  unregisterNiivue('pet')
})

// A CT pane narrower than the PT grid (2 vs 3 voxels) with the PT overlaid;
// `instances` (the PT series') also make the CT pane active.
function fusion(instances?: object[]) {
  const affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
  const vol = (n: number, hdr: object) => ({
    img: new Float32Array(n),
    dimsRAS: [3, n, 1, 1],
    img2RASstep: [1, n, n],
    img2RASstart: [0, 0, 0],
    matRAS: affine,
    hdr,
  })
  const pane = (volumes: object[]) =>
    Object.assign(new EventTarget(), {
      volumes,
      drawingVolume: undefined as undefined | { img: Uint8Array },
      drawIsEnabled: false,
      createEmptyDrawing() {
        this.drawingVolume = {
          img: new Uint8Array((volumes[0] as { img: Float32Array }).img.length),
        }
      },
      refreshDrawing() {},
    })
  const ptHdr = {}
  const pt = pane([vol(3, ptHdr)])
  const ct = pane([vol(2, {}), vol(3, ptHdr)])
  registerNiivue('fpt', pt as never)
  registerNiivue('fct', ct as never)
  const petDs = { displaySetInstanceUID: 'pet', Modality: 'PT', instances }
  updateNiivueViewport('fpt', { displaySets: [petDs] as never })
  updateNiivueViewport('fct', {
    displaySets: [{ displaySetInstanceUID: 'ct', Modality: 'CT' }] as never,
    overlays: new Map([['pet', ptHdr]]) as never,
  })
  const services = {
    services: {
      displaySetService: { getDisplaySetByUID: () => petDs },
      ...(instances && {
        viewportGridService: { getActiveViewportId: () => 'fct' },
      }),
    },
  } as never
  armBrush('fpt', 'CircularBrush', services, () => 5)
  const cmd = getQuantCommandDefinitions({
    servicesManager: services,
  } as never) as unknown as Record<
    string,
    { commandFn: (o?: object) => unknown }
  >
  const mask = (cmd.niivueGetLabelmap?.commandFn() as { label: Uint8Array })
    .label
  const stroke = () => {
    if (!ct.drawingVolume) throw new Error('no CT drawing')
    ct.drawingVolume.img[0] = 2
    ct.dispatchEvent(
      new CustomEvent('drawingChanged', { detail: { action: 'stroke' } }),
    )
  }
  const done = () => {
    unregisterNiivue('fpt')
    unregisterNiivue('fct')
  }
  return { services, cmd, mask, stroke, done }
}

it('a CT pane stroke keeps PET labels outside the CT field of view', () => {
  const f = fusion()
  try {
    f.mask.set([1, 1, 1])
    armBrush('fct', 'CircularBrush', f.services, () => 5)
    f.stroke()
    expect([...f.mask]).toEqual([2, 1, 1])
  } finally {
    f.done()
  }
})

it('a threshold brush stays armed when another pane arms a plain brush', () => {
  const f = fusion()
  try {
    f.mask.fill(0)
    armBrush('fct', 'ThresholdCircularBrush', f.services, () => 5)
    armBrush('fpt', 'CircularBrush', f.services, () => 5)
    // PT is 0 everywhere, below the default [2.5, 50] range.
    f.stroke()
    expect([...f.mask]).toEqual([0, 0, 0])
  } finally {
    f.done()
  }
})

it('TMTV CSV quotes a label holding a comma', () => {
  const segment = {
    value: 1,
    label: 'left,lung',
    count: 1,
    volume: 1,
    mean: 1,
    max: 1,
    min: 1,
    peak: 1,
    lesionGlycolysis: 1,
  }
  const csv = tmtvCsv({}, { tmtv: 1, tlg: 1, segments: [segment] }, {})
  expect(csv.split('\n')[1]).toStartWith('1,"left,lung",1,')
})

it('TMTV CSV total TLG matches the panel (mL x SUV)', () => {
  const segment = {
    value: 1,
    label: 'lesion',
    count: 1000,
    volume: 1000,
    mean: 2,
    max: 2,
    min: 2,
    peak: 2,
    lesionGlycolysis: 2000,
  }
  const csv = tmtvCsv({}, { tmtv: 1, tlg: 2, segments: [segment] }, {})
  expect(csv).toContain('Total Lesion Glycolysis,tlg,2.0000')
})

// D2-08: a pane hung after the label exists (workflow step change) shows it
// without waiting for the next stroke.
it('a pane joining later shows the existing label', async () => {
  const panes = await Promise.all(
    ['first', 'late'].map(async (id) => {
      const nv = new NiiVue({ backend: 'webgl2' })
      nv.drawScene = () => {}
      await nv.loadVolumes([{ url: nifti() }])
      registerNiivue(id, nv)
      return nv
    }),
  )
  const [first, late] = panes as [NiiVue, NiiVue]
  const pt = [{ displaySetInstanceUID: 'pt2', Modality: 'PT' } as never]
  updateNiivueViewport('first', { displaySets: pt })
  armBrush('first', 'CircularBrush', undefined, () => 5)
  ;(first.drawingVolume?.img as Uint8Array)[3] = 1
  first.dispatchEvent(
    new CustomEvent('drawingChanged', { detail: { action: 'stroke' } }),
  )
  updateNiivueViewport('late', { displaySets: pt })
  showPaneLabel(getNiivueEntry('late') as never, undefined)
  expect(Array.from(late.drawingVolume?.img ?? [])).toEqual([
    0, 0, 0, 1, 0, 0, 0, 0,
  ])
  for (const id of ['first', 'late']) unregisterNiivue(id)
})

// D6-12: TMTV saves the PT-grid label on the PT series' frames, from a CT pane too.
it('TMTV SEG and RTSS reference the PT series and keep segment voxel counts', async () => {
  // One PT frame: columns run along RAS x, so pixel c is PT voxel c.
  const f = fusion([
    {
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.128',
      SOPInstanceUID: 'pt.1',
      SeriesInstanceUID: 'ptseries',
      ImagePositionPatient: [0, 0, 0],
      ImageOrientationPatient: [-1, 0, 0, 0, -1, 0],
      PixelSpacing: [1, 1],
      Rows: 1,
      Columns: 3,
    },
  ])
  try {
    f.cmd.niivueAddSegment?.commandFn({ label: 'lesion' })
    f.mask.set([1, 2, 2])
    type Seg = {
      ReferencedSeriesSequence: { SeriesInstanceUID: string }
      SegmentSequence: { SegmentLabel: string }[]
      PerFrameFunctionalGroupsSequence: {
        SegmentIdentificationSequence: { ReferencedSegmentNumber: number }
      }[]
      PixelData: ArrayBuffer
    }
    const seg = (await tmtvDataset(f.services, 'SEG', 'S')) as Seg
    expect(seg.ReferencedSeriesSequence.SeriesInstanceUID).toBe('ptseries')
    expect(seg.SegmentSequence.map((s) => s.SegmentLabel)).toEqual([
      'Segment 1',
      'lesion',
    ])
    const bits = new Uint8Array(seg.PixelData)
    const counts = [0, 0, 0]
    seg.PerFrameFunctionalGroupsSequence.forEach((g, frame) => {
      const s = g.SegmentIdentificationSequence.ReferencedSegmentNumber
      for (let p = 0; p < 3; p++) {
        const b = frame * 3 + p
        if ((bits[b >> 3] as number) & (1 << (b & 7)))
          counts[s] = (counts[s] as number) + 1
      }
    })
    expect(counts).toEqual([0, 1, 2])
    type Rt = {
      ReferencedFrameOfReferenceSequence: {
        RTReferencedStudySequence: {
          RTReferencedSeriesSequence: { SeriesInstanceUID: string }[]
        }[]
      }[]
      StructureSetROISequence: { ROIName: string }[]
      ROIContourSequence: { ContourSequence: { ContourData: number[] }[] }[]
    }
    const rt = (await tmtvDataset(f.services, 'RTSTRUCT', 'C')) as Rt
    expect(
      rt.ReferencedFrameOfReferenceSequence[0]?.RTReferencedStudySequence[0]
        ?.RTReferencedSeriesSequence[0]?.SeriesInstanceUID,
    ).toBe('ptseries')
    expect(rt.StructureSetROISequence.map((r) => r.ROIName)).toEqual([
      'Segment 1',
      'lesion',
    ])
    // Contour areas (1 mm pixels, shoelace in the LPS x/y plane) are the counts.
    const areas = rt.ROIContourSequence.map(({ ContourSequence }) =>
      ContourSequence.reduce((sum, { ContourData: d }) => {
        let a = 0
        for (let i = 0; i < d.length; i += 3) {
          const j = (i + 3) % d.length
          a +=
            (d[i] as number) * (d[j + 1] as number) -
            (d[j] as number) * (d[i + 1] as number)
        }
        return sum + Math.abs(a / 2)
      }, 0),
    )
    expect(areas).toEqual([1, 2])
  } finally {
    f.done()
  }
})

// Holistic review (nv-ohif): a label shown in a pane with a 60xx plane wrote
// TMTV into the plane's drawing. The label takes the drawing; mode exit gives
// it back.
// A tool group with ImageOverlayViewer Enabled.
const planesOn = () => {
  return {
    getModuleEntry: () => ({
      exports: {
        getCornerstoneLibraries: () => ({
          cornerstoneTools: {
            ToolGroupManager: {
              getToolGroup: () => ({
                getToolInstance: () => ({ mode: 'Enabled' }),
              }),
            },
          },
        }),
      },
    }),
  } as never
}

it('a label replaces a shown overlay plane until mode exit', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  await nv.loadVolumes([{ url: nifti() }])
  registerNiivue('plane', nv)
  updateNiivueViewport('plane', {
    displaySets: [{ displaySetInstanceUID: 'pt', Modality: 'PT' } as never],
  })
  const em = planesOn()
  await setOverlayPlanes(nv, [nifti(9, 'x_ROI1.nii')], em, 'g')
  expect(nv.drawingVolume?.img?.[0]).toBe(9)
  const services = {
    services: { viewportGridService: { getActiveViewportId: () => 'plane' } },
  } as never
  expect(armBrush('plane', 'CircularBrush', services, () => 5)).toBe(true)
  expect([...(nv.drawingVolume?.img ?? [])].every((v) => v === 0)).toBe(true)
  resetQuant()
  await Bun.sleep(0)
  await Bun.sleep(0)
  expect(nv.drawingVolume?.img?.[0]).toBe(9)
  unregisterNiivue('plane')
})

// Review of #866: the label's hold outlived the PT, so the next series' plane
// never showed.
it('a pane leaving its PT series gives its overlay planes back', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  await nv.loadVolumes([{ url: nifti() }])
  registerNiivue('swap', nv)
  updateNiivueViewport('swap', {
    displaySets: [{ displaySetInstanceUID: 'pt2', Modality: 'PT' } as never],
  })
  const services = {
    services: { viewportGridService: { getActiveViewportId: () => 'swap' } },
  } as never
  expect(armBrush('swap', 'CircularBrush', services, () => 5)).toBe(true)
  updateNiivueViewport('swap', {
    displaySets: [{ displaySetInstanceUID: 'ct', Modality: 'CT' } as never],
  })
  showPaneLabel(getNiivueEntry('swap') as never, services)
  await setOverlayPlanes(nv, [nifti(9, 'x_ROI1.nii')], planesOn(), 'g')
  expect(nv.drawingVolume?.img?.[0]).toBe(9)
  resetQuant()
  unregisterNiivue('swap')
})

// Review of #866 r2: removing the PT overlay kept its label and plane hold.
for (const how of ['remove', 'toggle'] as const)
  it(`removing a PT overlay (${how}) gives the pane's planes back`, async () => {
    const nv = new NiiVue({ backend: 'webgl2' })
    nv.drawScene = () => {}
    await nv.loadVolumes([{ url: nifti(2, 'ct.nii') }, { url: nifti() }])
    registerNiivue('rm', nv)
    const petDs = { displaySetInstanceUID: 'pet', Modality: 'PT' }
    updateNiivueViewport('rm', {
      displaySets: [{ displaySetInstanceUID: 'ct', Modality: 'CT' }] as never,
      overlays: new Map([['pet', nv.volumes[1]?.hdr]]) as never,
    })
    const services = {
      services: {
        displaySetService: { getDisplaySetByUID: () => petDs },
        viewportGridService: { getActiveViewportId: () => 'rm' },
      },
    } as never
    expect(armBrush('rm', 'CircularBrush', services, () => 5)).toBe(true)
    const { actions } = getNiivueCommandsModule({ servicesManager: services })
    if (how === 'remove')
      await actions.niivueRemoveOverlay({ displaySetInstanceUID: 'pet' })
    else await actions.niivueToggleOverlay()
    await setOverlayPlanes(nv, [nifti(9, 'x_ROI1.nii')], planesOn(), 'g')
    expect(nv.drawingVolume?.img?.[0]).toBe(9)
    resetQuant()
    unregisterNiivue('rm')
  })

// Independent review of #866: dropping a label must not close a SEG drawing
// it was written into.
it('removing a PT overlay keeps a SEG drawing the label borrowed', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  await nv.loadVolumes([{ url: nifti(2, 'ct.nii') }, { url: nifti() }])
  nv.createEmptyDrawing() // stands in for a hung SEG
  const seg = nv.drawingVolume
  registerNiivue('segpt', nv)
  updateNiivueViewport('segpt', {
    displaySets: [{ displaySetInstanceUID: 'ct', Modality: 'CT' }] as never,
    overlays: new Map([['pet', nv.volumes[1]?.hdr]]) as never,
  })
  const services = {
    services: {
      displaySetService: {
        getDisplaySetByUID: () => ({
          displaySetInstanceUID: 'pet',
          Modality: 'PT',
        }),
      },
      viewportGridService: { getActiveViewportId: () => 'segpt' },
    },
  } as never
  expect(armBrush('segpt', 'CircularBrush', services, () => 5)).toBe(true)
  const { actions } = getNiivueCommandsModule({ servicesManager: services })
  await actions.niivueRemoveOverlay({ displaySetInstanceUID: 'pet' })
  expect(nv.drawingVolume).toBe(seg)
  resetQuant()
  unregisterNiivue('segpt')
})
