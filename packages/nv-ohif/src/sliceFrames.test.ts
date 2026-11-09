import { afterEach, describe, expect, it } from 'bun:test'
import type NiiVue from '@niivue/niivue'
import { generateShape, type VectorAnnotation } from '@niivue/niivue'
import { reflectNiivueAnnotation } from './commands'
import {
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
import type { OhifExtensionParams } from './ohif-types'
import { buildSliceFrames, frameAt } from './sliceFrames'

type Vec3 = [number, number, number]
const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [
  a[0] + s * b[0],
  a[1] + s * b[1],
  a[2] + s * b[2],
]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

interface Geometry {
  ipp: Vec3 // first slice, in acquisition order
  row: Vec3 // IOP[0..2]: direction of increasing column index
  col: Vec3 // IOP[3..5]
  spacing: number
  sliceStep: number // signed, along row x col
  rows: number
  columns: number
  slices: number
}

// The sform dcm2niix writes for a DICOM stack: rows flipped (NIfTI j = rows-1-j),
// LPS -> RAS. `reverse` stores the slices last-first (dcm2niix flipping to a
// positive-determinant sform), so slice k holds acquired slice n-1-k.
function niftiHeader(g: Geometry, reverse = false): ArrayBuffer {
  const normal = cross(g.row, g.col)
  let origin = add(g.ipp, g.col, (g.rows - 1) * g.spacing)
  let ck = normal.map((v) => v * g.sliceStep) as Vec3
  if (reverse) {
    origin = add(origin, ck, g.slices - 1)
    ck = ck.map((v) => -v) as Vec3
  }
  const cols: Vec3[] = [
    g.row.map((v) => v * g.spacing) as Vec3,
    g.col.map((v) => -v * g.spacing) as Vec3,
    ck,
    origin,
  ]
  const view = new DataView(new ArrayBuffer(352))
  view.setInt32(0, 348, true)
  ;[3, g.columns, g.rows, g.slices].forEach((d, i) => {
    view.setInt16(40 + 2 * i, d, true)
  })
  view.setInt16(254, 1, true) // sform_code
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++)
      view.setFloat32(
        280 + 16 * r + 4 * c,
        (r < 2 ? -1 : 1) * (cols[c]?.[r] ?? 0),
        true,
      )
  return view.buffer
}

const imageId = (sop: string) =>
  `wadors:https://pacs/dicom-web/studies/st/series/se/instances/${sop}/frames/1`

function classic(g: Geometry, prefix: string, extra = {}) {
  return Array.from({ length: g.slices }, (_, k) => ({
    SOPInstanceUID: `${prefix}${k}`,
    imageId: imageId(`${prefix}${k}`),
    ImagePositionPatient: add(g.ipp, cross(g.row, g.col), k * g.sliceStep),
    ImageOrientationPatient: [...g.row, ...g.col],
    ...extra,
  }))
}

const axial: Geometry = {
  ipp: [-100.5, -120, 30],
  row: [1, 0, 0],
  col: [0, 1, 0],
  spacing: 0.5,
  sliceStep: 2.5,
  rows: 8,
  columns: 6,
  slices: 4,
}
const sops = (sf: ReturnType<typeof buildSliceFrames>) =>
  sf?.frames.map((f) => f && `${f.SOPInstanceUID}:${f.frameNumber}`)

describe('buildSliceFrames', () => {
  it('maps an axial series, whatever the instance order', () => {
    const sf = buildSliceFrames(
      niftiHeader(axial),
      classic(axial, 'ax').reverse(),
    )
    expect(sops(sf)).toEqual(['ax0:1', 'ax1:1', 'ax2:1', 'ax3:1'])
    expect(sf?.frames[2]?.referencedImageId).toBe(imageId('ax2'))
  })

  it('follows a flipped (reversed-slice) sform', () => {
    const sf = buildSliceFrames(niftiHeader(axial, true), classic(axial, 'ax'))
    expect(sops(sf)).toEqual(['ax3:1', 'ax2:1', 'ax1:1', 'ax0:1'])
  })

  it('maps a sagittal series and skips a frame on another plane', () => {
    const sag: Geometry = {
      ...axial,
      ipp: [10, -80, 60],
      row: [0, 1, 0],
      col: [0, 0, -1],
      sliceStep: -3,
    }
    const localizer = {
      SOPInstanceUID: 'loc',
      ImagePositionPatient: [4, -80, 60],
      ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    }
    const sf = buildSliceFrames(niftiHeader(sag), [
      ...classic(sag, 'sag'),
      localizer,
    ])
    expect(sops(sf)).toEqual(['sag0:1', 'sag1:1', 'sag2:1', 'sag3:1'])
  })

  it('maps enhanced per-frame positions with a shared orientation', () => {
    const positions = classic(axial, '').map((i) => i.ImagePositionPatient)
    const enhanced = {
      SOPInstanceUID: 'enh',
      imageId: imageId('enh'),
      NumberOfFrames: 4,
      // dcmjs collapses one-item sequences; accept both shapes.
      SharedFunctionalGroupsSequence: {
        PlaneOrientationSequence: {
          ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
        },
      },
      PerFrameFunctionalGroupsSequence: [2, 0, 3, 1].map((k) => ({
        PlanePositionSequence:
          k % 2
            ? [{ ImagePositionPatient: positions[k] }]
            : { ImagePositionPatient: positions[k] },
      })),
    }
    const sf = buildSliceFrames(niftiHeader(axial), [enhanced])
    expect(sops(sf)).toEqual(['enh:2', 'enh:4', 'enh:1', 'enh:3'])
    expect(sf?.frames[0]?.referencedImageId).toBe(
      imageId('enh').replace('/frames/1', '/frames/2'),
    )
  })

  it('keeps the shown echo of a multi-echo series, else leaves ties unmapped', () => {
    const instances = [
      ...classic(axial, 'e1-', { EchoNumbers: 1 }),
      ...classic(axial, 'e2-', { EchoNumbers: 2 }),
    ]
    const header = niftiHeader(axial)
    expect(
      sops(buildSliceFrames(header, instances, { echo: 2, part: false })),
    ).toEqual(['e2-0:1', 'e2-1:1', 'e2-2:1', 'e2-3:1'])
    expect(sops(buildSliceFrames(header, instances))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  it('keeps magnitude or phase frames to match the shown output', () => {
    const instances = [
      ...classic(axial, 'm', { ImageType: ['ORIGINAL', 'PRIMARY', 'M'] }),
      ...classic(axial, 'p', { ImageType: ['ORIGINAL', 'PRIMARY', 'P'] }),
    ]
    const header = niftiHeader(axial)
    expect(sops(buildSliceFrames(header, instances))?.[1]).toBe('m1:1')
    expect(sops(buildSliceFrames(header, instances, { part: true }))?.[1]).toBe(
      'p1:1',
    )
  })

  it('maps only frames lying in a slice (not resampled, tilted or degenerate)', () => {
    const frames = classic(axial, 'ax')
    // _Eq: an acquired frame 0.4 slice off its nearest output slice.
    ;(frames[1] as { ImagePositionPatient: Vec3 }).ImagePositionPatient = [
      -100.5, -120, 33.5,
    ]
    // _Tilt: tilted 5 degrees about x, through slice 2's position.
    const t = (5 * Math.PI) / 180
    ;(
      frames[2] as { ImageOrientationPatient: number[] }
    ).ImageOrientationPatient = [1, 0, 0, 0, Math.cos(t), Math.sin(t)]
    // A degenerate orientation (row = col).
    ;(
      frames[3] as { ImageOrientationPatient: number[] }
    ).ImageOrientationPatient = [1, 0, 0, 1, 0, 0]
    expect(sops(buildSliceFrames(niftiHeader(axial), frames))).toEqual([
      'ax0:1',
      undefined,
      undefined,
      undefined,
    ])
  })

  it('needs an sform', () => {
    const header = niftiHeader(axial)
    new DataView(header).setInt16(254, 0, true)
    expect(buildSliceFrames(header, classic(axial, 'ax'))).toBeUndefined()
  })
})

describe('frameAt', () => {
  const sf = buildSliceFrames(niftiHeader(axial), classic(axial, 'ax'))
  it('needs every point on one slice', () => {
    if (!sf) throw new Error('no map')
    expect(frameAt(sf, [[0, 0, 35]])?.SOPInstanceUID).toBe('ax2')
    expect(
      frameAt(sf, [
        [0, 0, 35],
        [0, 0, 37.5],
      ]),
    ).toBeUndefined()
    expect(frameAt(sf, [[0, 0, 100]])).toBeUndefined()
  })

  it('gives no identity to a depth between slices', () => {
    if (!sf) throw new Error('no map')
    // Slices at z 30, 32.5, 35, 37.5. The viewport snaps the crosshair to slice
    // centres; a ruler at z 31.2 lies on no frame.
    const at = (z: number) =>
      frameAt(sf, [
        [0, 0, z],
        [9, 4, z],
      ])?.SOPInstanceUID
    expect(at(32.5)).toBe('ax1')
    expect(at(31.2)).toBeUndefined()
  })

  it('needs every point on the frame plane, not just its slab', () => {
    if (!sf) throw new Error('no map')
    const coronal: [number, number, number][] = [
      [0, 0, 30],
      [0, 0, 31],
    ]
    expect(frameAt(sf, coronal)).toBeUndefined()
    expect(
      frameAt(sf, [
        [0, 0, 30],
        [9, 4, 30],
      ])?.SOPInstanceUID,
    ).toBe('ax0')
    // Each 0.009 slice (2.5 mm slices) off slice 0, but 0.018 apart: tilted.
    expect(
      frameAt(sf, [
        [0, 0, 30 - 0.0225],
        [9, 4, 30 + 0.0225],
      ]),
    ).toBeUndefined()
  })
})

describe('reflected measurement identity', () => {
  afterEach(() => unregisterNiivue('vp-id'))

  function reflect(annotation: VectorAnnotation) {
    const backing = [
      {
        SeriesInstanceUID: 'se',
        StudyInstanceUID: 'st',
        displaySetInstanceUID: 'ds',
        instances: [{ FrameOfReferenceUID: 'for' }],
      },
    ]
    let schema: Record<string, unknown> = {}
    const servicesManager = {
      services: {
        measurementService: {
          createSource: () => ({}),
          addMapping: () => {},
          addRawMeasurement: (
            _s: unknown,
            _t: string,
            data: { uid: string; measurement: Record<string, unknown> },
          ) => {
            schema = data.measurement
            return data.uid
          },
        },
        displaySetService: { getDisplaySetsForSeries: () => backing },
      },
    } as unknown as OhifExtensionParams['servicesManager']
    registerNiivue('vp-id', { annotations: [] } as unknown as NiiVue)
    updateNiivueViewport('vp-id', {
      displaySets: backing,
      sliceFrames: buildSliceFrames(niftiHeader(axial), classic(axial, 'ax')),
    })
    expect(reflectNiivueAnnotation('vp-id', servicesManager, annotation)).toBe(
      true,
    )
    return schema
  }

  const line = (
    sliceType: number,
    slicePosition: number,
    start: { x: number; y: number },
    end: { x: number; y: number },
  ) =>
    ({
      id: 'l',
      label: 0,
      group: '',
      sliceType,
      slicePosition,
      polygons: generateShape('measureLine', start, end, 1),
      style: {
        fillColor: [1, 1, 1, 1],
        strokeColor: [1, 1, 1, 1],
        strokeWidth: 1,
      },
      shape: { type: 'measureLine', start, end },
    }) as unknown as VectorAnnotation

  it('emits LPS points on the source frame and its identity', () => {
    // DICOM pixels (column 1, row 2) and (column 5, row 7) of acquired slice 1, in
    // LPS from IPP/IOP alone; NiiVue draws in RAS (-L, -P, S).
    const lps = (i: number, j: number): Vec3 =>
      add(
        add(
          add(axial.ipp, axial.row, i * axial.spacing),
          axial.col,
          j * axial.spacing,
        ),
        [0, 0, 1],
        axial.sliceStep,
      )
    const a = lps(1, 2)
    const b = lps(5, 7)
    const m = reflect(
      line(0, a[2], { x: -a[0], y: -a[1] }, { x: -b[0], y: -b[1] }),
    )
    expect(m.points).toEqual([a, b])
    expect(m.SOPInstanceUID).toBe('ax1')
    expect(m.frameNumber).toBe(1)
    expect(m.referencedImageId).toBe(imageId('ax1'))
  })

  it('omits identity for a shape across acquired slices', () => {
    const m = reflect(line(1, 0, { x: 0, y: 30 }, { x: 0, y: 40 }))
    expect('SOPInstanceUID' in m).toBe(false)
    expect('frameNumber' in m).toBe(false)
    expect('referencedImageId' in m).toBe(false)
  })
})
