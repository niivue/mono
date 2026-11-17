import { expect, test } from 'bun:test'
import dcmjs from 'dcmjs'
import { fillRuns, lpsToVoxel, rasterizeContours } from './rtDrawing'
import { buildRtssDataset, buildSegDataset, frameLabels } from './segExport'

// Axial source frames (rows along LPS y at 2 mm, columns along x at 1 mm,
// slices 3 mm apart) under a RAS grid flipped in x and y: voxel (i,j,k) is
// pixel (r = ny-1-j, c = nx-1-i) of slice k.
function fixture(nx: number, ny: number, nz: number) {
  const vox2mm = ([i, j, k]: [number, number, number]) =>
    [i - (nx - 1), 2 * (j - (ny - 1)), 3 * k] as [number, number, number]
  // Listed out of slice order: references follow the instance, not the list.
  const instances = Array.from({ length: nz }, (_, k) => ({
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.4',
    SOPInstanceUID: `1.2.3.${k}`,
    SeriesInstanceUID: '1.2.3',
    StudyInstanceUID: '1.2',
    FrameOfReferenceUID: '1.2.9',
    PatientID: 'P',
    ImagePositionPatient: [0, 0, 3 * k],
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    PixelSpacing: [2, 1],
    Rows: ny,
    Columns: nx,
  })).reverse()
  return { lps2vox: lpsToVoxel(vox2mm) as number[], instances }
}

const h = { SeriesDescription: 'edit', SeriesNumber: 300 }
const seg = (value: number) => ({
  value,
  label: `s${value}`,
  rgb: [value * 40, 0, 0] as const,
})

test('SEG written, read back with dcmjs and placed by its own geometry, is the drawing', () => {
  const [nx, ny, nz] = [4, 3, 2]
  const bitmap = new Uint8Array(nx * ny * nz)
  bitmap[0] = 2 // (0,0,0)
  bitmap[1 + nx * (2 + ny)] = 1 // (1,2,1)
  bitmap[2 + nx * (2 + ny)] = 1 // (2,2,1)
  bitmap[3 + nx * 1] = 5 // (3,1,0): label values need not be consecutive
  const { lps2vox, instances } = fixture(nx, ny, nz)
  const frames = frameLabels({ bitmap, dims: [nx, ny, nz], lps2vox, instances })
  const ds = buildSegDataset(frames, [seg(5), seg(1), seg(2)], h, () => [
    0, 0, 0,
  ])
  if (!ds) throw new Error('no SEG')
  const { DicomMessage, DicomMetaDictionary } = dcmjs.data
  const bytes = dcmjs.data.datasetToDict(ds).write()
  const back = DicomMetaDictionary.naturalizeDataset(
    DicomMessage.readFile(bytes).dict,
  )
  const bits = new Uint8Array(back.PixelData[0])
  const values = back.SegmentSequence.map(
    (s: { SegmentNumber: number; SegmentLabel: string }) =>
      Number(s.SegmentLabel.slice(1)),
  )
  expect(values).toEqual([1, 2, 5])
  const placed = new Uint8Array(bitmap.length)
  const n = nx * ny
  back.PerFrameFunctionalGroupsSequence.forEach(
    (
      g: Record<
        string,
        { ReferencedSegmentNumber?: number; ImagePositionPatient?: number[] }
      >,
      f: number,
    ) => {
      const segment = g.SegmentIdentificationSequence
        ?.ReferencedSegmentNumber as number
      const k =
        (g.PlanePositionSequence?.ImagePositionPatient?.[2] as number) / 3
      for (let p = 0; p < n; p++) {
        const b = f * n + p
        if (!((bits[b >> 3] as number) & (1 << (b & 7)))) continue
        const [r, c] = [Math.floor(p / nx), p % nx]
        placed[nx - 1 - c + nx * (ny - 1 - r + ny * k)] = values[segment - 1]
      }
    },
  )
  expect(placed).toEqual(bitmap)
  // Readers place a SEG covering some slices by the source's step (dcm2niix
  // otherwise takes the gap between painted slices).
  const shared = [back.SharedFunctionalGroupsSequence].flat()[0]
  expect([shared.PixelMeasuresSequence].flat()[0].SpacingBetweenSlices).toBe(3)
  expect(back.NumberOfFrames).toBe(3)
})

test('RTSS pixel-edge contours re-rasterize to the drawing (hole, lone voxel, diagonal touch)', () => {
  const [nx, ny, nz] = [6, 5, 2]
  const bitmap = new Uint8Array(nx * ny * nz)
  // Slice 0: a 3x3 ring around a hole, plus a lone voxel; slice 1: diagonal pair.
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++) if (i !== 1 || j !== 1) bitmap[i + nx * j] = 1
  bitmap[5 + nx * 4] = 1
  bitmap[nx * ny + 2 + nx * 2] = 1
  bitmap[nx * ny + 3 + nx * 3] = 1
  const { lps2vox, instances } = fixture(nx, ny, nz)
  const frames = frameLabels({ bitmap, dims: [nx, ny, nz], lps2vox, instances })
  const ds = buildRtssDataset(() => frames, [seg(1)], h) as {
    ROIContourSequence: Array<{
      ContourSequence: Array<{ ContourData: number[] }>
    }>
  }
  const contours =
    ds.ROIContourSequence[0]?.ContourSequence.map((c) => c.ContourData) ?? []
  const { runs } = rasterizeContours([nx, ny, nz], lps2vox, contours)
  const back = new Uint8Array(bitmap.length)
  fillRuns(back, runs, 1)
  expect(back).toEqual(bitmap)
})

test('an enhanced multi-frame source exports a frame per functional group', () => {
  const [nx, ny, nz] = [4, 3, 2]
  const bitmap = new Uint8Array(nx * ny * nz)
  bitmap[1 + nx * (2 + ny)] = 1 // (1,2,1): slice 1 only
  const { lps2vox, instances } = fixture(nx, ny, nz)
  const {
    ImagePositionPatient: _p,
    ImageOrientationPatient: _o,
    PixelSpacing: _s,
    ...inst
  } = instances[0] as (typeof instances)[number]
  const enhanced = {
    ...inst,
    NumberOfFrames: nz,
    SharedFunctionalGroupsSequence: [
      {
        PlaneOrientationSequence: [
          { ImageOrientationPatient: [1, 0, 0, 0, 1, 0] },
        ],
        PixelMeasuresSequence: [{ PixelSpacing: [2, 1] }],
      },
    ],
    PerFrameFunctionalGroupsSequence: [0, 1].map((k) => ({
      PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 3 * k] }],
    })),
  }
  const frames = frameLabels({
    bitmap,
    dims: [nx, ny, nz],
    lps2vox,
    instances: [enhanced],
  })
  expect(frames.map((f) => f.frame)).toEqual([1, 2])
  const ds = buildSegDataset(frames, [seg(1)], h, () => [0, 0, 0])
  const groups = ds?.PerFrameFunctionalGroupsSequence as {
    DerivationImageSequence: {
      SourceImageSequence: { ReferencedFrameNumber?: number }
    }
  }[]
  const src = groups.map(
    (g) => g.DerivationImageSequence.SourceImageSequence.ReferencedFrameNumber,
  )
  expect(src).toEqual([2])
})
