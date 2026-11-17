// DICOM SEG and RTSTRUCT from a NiiVue drawing, on the frames of the series it
// was drawn over: each source instance's pixel grid is sampled from the drawing
// (RAS voxels) through the base volume's LPS->voxel map, so frames, positions
// and references are the source's own and dcm2niix rebuilds the same grid.
// Builders return naturalized datasets (OHIF's store functions write them).

type Ds = Record<string, unknown>
type Vec3 = [number, number, number]

export interface ExportSegment {
  value: number
  label: string
  rgb: readonly [number, number, number]
}

export interface DrawingSource {
  bitmap: Uint8Array
  /** RAS voxel dims of the bitmap. */
  dims: Vec3
  /** Row-major 3x4 LPS mm -> RAS voxel (rtDrawing lpsToVoxel). */
  lps2vox: ReadonlyArray<number>
  /** Naturalized source instances (classic, single frame). */
  instances: ReadonlyArray<Ds>
}

export interface FrameLabels {
  inst: Ds
  rows: number
  cols: number
  ipp: Vec3
  /** Unit LPS vectors along a row (next column) and a column (next row). */
  rowDir: Vec3
  colDir: Vec3
  /** PixelSpacing: [between rows, between columns]. */
  spacing: [number, number]
  labels: Uint8Array
}

const nums = (v: unknown): number[] =>
  Array.isArray(v)
    ? v.map(Number)
    : typeof v === 'string'
      ? v.split('\\').map(Number)
      : []

/** Each classic source instance's pixels, labelled from the drawing (0 off it). */
export function frameLabels({
  bitmap,
  dims,
  lps2vox: m,
  instances,
}: DrawingSource): FrameLabels[] {
  const [nx, ny, nz] = dims
  const out: FrameLabels[] = []
  const at = (i: number) => m[i] as number
  for (const inst of instances) {
    const ipp = nums(inst.ImagePositionPatient)
    const iop = nums(inst.ImageOrientationPatient)
    const ps = nums(inst.PixelSpacing)
    const rows = Number(inst.Rows)
    const cols = Number(inst.Columns)
    if (ipp.length !== 3 || iop.length !== 6 || ps.length !== 2) continue
    if (!(rows > 0 && cols > 0)) continue
    const [sr = 1, sc = 1] = ps
    const rowDir = iop.slice(0, 3) as Vec3
    const colDir = iop.slice(3, 6) as Vec3
    // Voxel coordinates of pixel (0,0) and per-column / per-row steps.
    const o = [0, 1, 2].map(
      (r) =>
        at(4 * r) * (ipp[0] as number) +
        at(4 * r + 1) * (ipp[1] as number) +
        at(4 * r + 2) * (ipp[2] as number) +
        at(4 * r + 3),
    )
    const step = (d: Vec3, s: number) =>
      [0, 1, 2].map(
        (r) =>
          (at(4 * r) * d[0] + at(4 * r + 1) * d[1] + at(4 * r + 2) * d[2]) * s,
      )
    const [ox = 0, oy = 0, oz = 0] = o
    const [ux = 0, uy = 0, uz = 0] = step(rowDir, sc)
    const [vx = 0, vy = 0, vz = 0] = step(colDir, sr)
    const labels = new Uint8Array(rows * cols)
    for (let r = 0, i = 0; r < rows; r++) {
      const bx = ox + r * vx
      const by = oy + r * vy
      const bz = oz + r * vz
      for (let c = 0; c < cols; c++, i++) {
        const x = Math.round(bx + c * ux)
        const y = Math.round(by + c * uy)
        const z = Math.round(bz + c * uz)
        if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue
        labels[i] = bitmap[x + nx * (y + ny * z)] as number
      }
    }
    out.push({
      inst,
      rows,
      cols,
      ipp: ipp as Vec3,
      rowDir,
      colDir,
      spacing: [sr, sc],
      labels,
    })
  }
  return out
}

/** A DICOM UID from a random UUID (PS3.5 B.2). */
export function newUid(): string {
  return `2.25.${BigInt(`0x${crypto.randomUUID().replace(/-/g, '')}`)}`
}

const PATIENT_STUDY = [
  'PatientName',
  'PatientID',
  'PatientBirthDate',
  'PatientSex',
  'PatientAge',
  'StudyInstanceUID',
  'StudyDate',
  'StudyTime',
  'StudyID',
  'AccessionNumber',
  'ReferringPhysicianName',
  'StudyDescription',
  'FrameOfReferenceUID',
]

function dicomNow() {
  const iso = new Date().toISOString()
  return {
    date: iso.slice(0, 10).replace(/-/g, ''),
    time: iso.slice(11, 19).replace(/:/g, ''),
  }
}

export interface SeriesHeader {
  SeriesDescription: string
  SeriesNumber: number
}

/** The new series' identity, with patient/study copied from `src`. */
function header(src: Ds, sopClass: string, modality: string, h: SeriesHeader) {
  const { date, time } = dicomNow()
  const sop = newUid()
  const out: Ds = {
    _meta: {},
    SOPClassUID: sopClass,
    SOPInstanceUID: sop,
    SeriesInstanceUID: newUid(),
    Modality: modality,
    SeriesDescription: h.SeriesDescription,
    SeriesNumber: h.SeriesNumber,
    InstanceNumber: 1,
    SeriesDate: date,
    SeriesTime: time,
    ContentDate: date,
    ContentTime: time,
    InstanceCreationDate: date,
    InstanceCreationTime: time,
    Manufacturer: 'NiiVue',
    ManufacturerModelName: '@niivue/nv-ohif',
    SoftwareVersions: '1',
    DeviceSerialNumber: '1',
    SpecificCharacterSet: 'ISO_IR 192',
  }
  for (const key of PATIENT_STUDY)
    if (src[key] !== undefined) out[key] = src[key]
  return out
}

const code = (
  CodeValue: string,
  CodingSchemeDesignator: string,
  CodeMeaning: string,
) => ({
  CodeValue,
  CodingSchemeDesignator,
  CodeMeaning,
})
const ref = (inst: Ds) => ({
  ReferencedSOPClassUID: inst.SOPClassUID,
  ReferencedSOPInstanceUID: inst.SOPInstanceUID,
})

/** Smallest nonzero gap between the frames' positions along their normal. */
function sliceStep(frames: ReadonlyArray<FrameLabels>): number | undefined {
  const f = frames[0]
  if (!f) return undefined
  const [a, b, c] = f.rowDir
  const [d, e, g] = f.colDir
  const n = [b * g - c * e, c * d - a * g, a * e - b * d]
  const depth = frames
    .map(
      (x) =>
        x.ipp[0] * (n[0] as number) +
        x.ipp[1] * (n[1] as number) +
        x.ipp[2] * (n[2] as number),
    )
    .sort((p, q) => p - q)
  let step = Number.POSITIVE_INFINITY
  for (let i = 1; i < depth.length; i++) {
    const gap = (depth[i] as number) - (depth[i - 1] as number)
    if (gap > 1e-3 && gap < step) step = gap
  }
  return Number.isFinite(step) ? +step.toFixed(6) : undefined
}

/**
 * A BINARY DICOM SEG of `segments` (numbered 1..n in value order: SEG numbers
 * segments consecutively) on the source frames that hold them. `source`
 * supplies the original SegmentSequence items to keep their codes. Undefined
 * when nothing is drawn.
 */
export function buildSegDataset(
  // A function reads each segment alone (overlapping RTSTRUCT ROIs).
  frames:
    | ReadonlyArray<FrameLabels>
    | ((s: ExportSegment) => ReadonlyArray<FrameLabels>),
  segments: ReadonlyArray<ExportSegment>,
  h: SeriesHeader,
  toLab: (rgb: readonly number[]) => number[],
  source?: ReadonlyArray<Ds>,
): Ds | undefined {
  const framesFor = typeof frames === 'function' ? frames : () => frames
  const sorted = [...segments].sort((a, b) => a.value - b.value)
  let all: ReadonlyArray<FrameLabels> = []
  const perFrame: Ds[] = []
  const bits: Uint8Array[] = []
  sorted.forEach((s, i) => {
    all = framesFor(s)
    all.forEach((f, k) => {
      if (!f.labels.includes(s.value)) return
      const mask = new Uint8Array(f.labels.length)
      for (let p = 0; p < mask.length; p++)
        mask[p] = f.labels[p] === s.value ? 1 : 0
      bits.push(mask)
      perFrame.push({
        FrameContentSequence: { DimensionIndexValues: [i + 1, k + 1] },
        PlanePositionSequence: { ImagePositionPatient: f.ipp },
        DerivationImageSequence: {
          SourceImageSequence: {
            ...ref(f.inst),
            PurposeOfReferenceCodeSequence: code(
              '121322',
              'DCM',
              'Source image for image processing operation',
            ),
          },
          DerivationCodeSequence: code('113076', 'DCM', 'Segmentation'),
        },
        SegmentIdentificationSequence: { ReferencedSegmentNumber: i + 1 },
      })
    })
  })
  const first = all[0]
  if (!first || !bits.length) return undefined
  const n = first.rows * first.cols
  // Frames pack contiguously, first pixel in the low bit (PS3.5 8.1.1).
  const packed = new Uint8Array(Math.ceil((bits.length * n) / 8))
  bits.forEach((mask, f) => {
    for (let p = 0; p < n; p++)
      if (mask[p]) {
        const b = f * n + p
        packed[b >> 3] = (packed[b >> 3] as number) | (1 << (b & 7))
      }
  })
  const dimOrg = newUid()
  const step = sliceStep(all)
  const ds: Ds = {
    ...header(first.inst, '1.2.840.10008.5.1.4.1.1.66.4', 'SEG', h),
    _vrMap: { PixelData: 'OB' },
    ImageType: ['DERIVED', 'PRIMARY'],
    ContentLabel: 'SEGMENTATION',
    ContentDescription: h.SeriesDescription,
    ContentCreatorName: 'NiiVue',
    SamplesPerPixel: 1,
    PhotometricInterpretation: 'MONOCHROME2',
    Rows: first.rows,
    Columns: first.cols,
    BitsAllocated: 1,
    BitsStored: 1,
    HighBit: 0,
    PixelRepresentation: 0,
    LossyImageCompression: '00',
    SegmentationType: 'BINARY',
    NumberOfFrames: bits.length,
    DimensionOrganizationSequence: { DimensionOrganizationUID: dimOrg },
    DimensionIndexSequence: [
      {
        DimensionOrganizationUID: dimOrg,
        DimensionIndexPointer: 0x0062000b,
        FunctionalGroupPointer: 0x0062000a,
        DimensionDescriptionLabel: 'ReferencedSegmentNumber',
      },
      {
        DimensionOrganizationUID: dimOrg,
        DimensionIndexPointer: 0x00200032,
        FunctionalGroupPointer: 0x00209113,
        DimensionDescriptionLabel: 'ImagePositionPatient',
      },
    ],
    SegmentSequence: sorted.map((s, i) => {
      const orig = source?.find((o) => Number(o.SegmentNumber) === s.value)
      return {
        SegmentedPropertyCategoryCodeSequence: code(
          '91723000',
          'SCT',
          'Anatomical Structure',
        ),
        SegmentedPropertyTypeCodeSequence: code('85756007', 'SCT', 'Tissue'),
        ...orig,
        SegmentNumber: i + 1,
        SegmentLabel: s.label,
        SegmentAlgorithmType: orig?.SegmentAlgorithmType ?? 'MANUAL',
        RecommendedDisplayCIELabValue: toLab(s.rgb.map((v) => v / 255)),
      }
    }),
    SharedFunctionalGroupsSequence: {
      PlaneOrientationSequence: {
        ImageOrientationPatient: [...first.rowDir, ...first.colDir],
      },
      PixelMeasuresSequence: {
        PixelSpacing: first.spacing,
        SliceThickness: first.inst.SliceThickness ?? first.spacing[0],
        // The source's slice step: readers (dcm2niix) place a SEG holding only
        // some slices, or one, on the source grid from it.
        ...(step ? { SpacingBetweenSlices: step } : {}),
      },
    },
    PerFrameFunctionalGroupsSequence: perFrame,
    ReferencedSeriesSequence: {
      SeriesInstanceUID: first.inst.SeriesInstanceUID,
      ReferencedInstanceSequence: all.map((f) => ref(f.inst)),
    },
    PixelData: packed.buffer,
  }
  return ds
}

/**
 * Closed loops along pixel edges around the set pixels of a rows x cols mask,
 * as flat [c, r, ...] corner coordinates (corner (c, r) is pixel (r, c)'s
 * top-left). Holes are loops of their own: filling every loop even-odd with
 * pixel centres inside gives back the mask exactly.
 */
export function traceLoops(
  mask: ArrayLike<number>,
  rows: number,
  cols: number,
): number[][] {
  const w = cols + 1
  const set = (r: number, c: number) =>
    r >= 0 && c >= 0 && r < rows && c < cols && mask[r * cols + c] !== 0
  // Directed boundary edges, set pixel on the right walking image coordinates.
  const next = new Map<number, number[]>()
  const edge = (a: number, b: number) => {
    const list = next.get(a)
    if (list) list.push(b)
    else next.set(a, [b])
  }
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!set(r, c)) continue
      const tl = r * w + c
      if (!set(r - 1, c)) edge(tl, tl + 1)
      if (!set(r, c + 1)) edge(tl + 1, tl + 1 + w)
      if (!set(r + 1, c)) edge(tl + 1 + w, tl + w)
      if (!set(r, c - 1)) edge(tl + w, tl)
    }
  const loops: number[][] = []
  for (const [start, ends] of next) {
    while (ends.length) {
      const keys = [start]
      let at = ends.pop() as number
      while (at !== start) {
        keys.push(at)
        at = next.get(at)?.pop() as number
      }
      // Corners only: drop vertices between collinear edges.
      const pts: number[] = []
      for (let i = 0; i < keys.length; i++) {
        const a = keys[(i + keys.length - 1) % keys.length] as number
        const b = keys[i] as number
        const c = keys[(i + 1) % keys.length] as number
        if (b - a !== c - b) pts.push(b % w, Math.floor(b / w))
      }
      loops.push(pts)
    }
  }
  return loops
}

/**
 * An RTSTRUCT with one ROI per segment (ROINumber = its value): every source
 * frame's pixel-edge loops (traceLoops) as CLOSED_PLANAR contours.
 * `framesFor` gives the labelled frames a segment is read from (overlapping
 * RT ROIs each need their own fill). Undefined when nothing is drawn.
 */
export function buildRtssDataset(
  framesFor: (s: ExportSegment) => ReadonlyArray<FrameLabels>,
  segments: ReadonlyArray<ExportSegment>,
  h: SeriesHeader,
): Ds | undefined {
  let frames: ReadonlyArray<FrameLabels> = []
  const rois = segments.map((s) => {
    frames = framesFor(s)
    const contours: Ds[] = []
    for (const f of frames) {
      if (!f.labels.includes(s.value)) continue
      const mask = f.labels.map((v) => (v === s.value ? 1 : 0))
      const [sr, sc] = f.spacing
      for (const loop of traceLoops(mask, f.rows, f.cols)) {
        const data: number[] = []
        for (let i = 0; i < loop.length; i += 2) {
          // Corner (c, r) lies half a pixel before pixel (r, c)'s centre.
          const u = ((loop[i] as number) - 0.5) * sc
          const v = ((loop[i + 1] as number) - 0.5) * sr
          for (let a = 0; a < 3; a++)
            data.push(
              +(
                (f.ipp[a] as number) +
                u * (f.rowDir[a] as number) +
                v * (f.colDir[a] as number)
              ).toFixed(4),
            )
        }
        contours.push({
          ContourImageSequence: ref(f.inst),
          ContourGeometricType: 'CLOSED_PLANAR',
          NumberOfContourPoints: data.length / 3,
          ContourData: data,
        })
      }
    }
    return { s, contours }
  })
  const first = frames[0]
  if (!first || !rois.some((r) => r.contours.length)) return undefined
  const forUid = first.inst.FrameOfReferenceUID
  const { date, time } = dicomNow()
  return {
    ...header(first.inst, '1.2.840.10008.5.1.4.1.1.481.3', 'RTSTRUCT', h),
    StructureSetLabel: h.SeriesDescription.slice(0, 16),
    StructureSetName: h.SeriesDescription,
    StructureSetDate: date,
    StructureSetTime: time,
    ReferencedFrameOfReferenceSequence: {
      FrameOfReferenceUID: forUid,
      RTReferencedStudySequence: {
        ReferencedSOPClassUID: '1.2.840.10008.3.1.2.3.1',
        ReferencedSOPInstanceUID: first.inst.StudyInstanceUID,
        RTReferencedSeriesSequence: {
          SeriesInstanceUID: first.inst.SeriesInstanceUID,
          ContourImageSequence: frames.map((f) => ref(f.inst)),
        },
      },
    },
    StructureSetROISequence: rois.map(({ s }) => ({
      ROINumber: s.value,
      ReferencedFrameOfReferenceUID: forUid,
      ROIName: s.label,
      ROIGenerationAlgorithm: 'MANUAL',
    })),
    ROIContourSequence: rois.map(({ s, contours }) => ({
      ReferencedROINumber: s.value,
      ROIDisplayColor: [...s.rgb],
      ContourSequence: contours,
    })),
    RTROIObservationsSequence: rois.map(({ s }) => ({
      ObservationNumber: s.value,
      ReferencedROINumber: s.value,
      RTROIInterpretedType: '',
      ROIInterpreter: '',
    })),
  }
}

export interface CsvSegment extends ExportSegment {
  count: number
  volume: number
  locked?: boolean
  active?: boolean
}

/** OHIF's segmentation CSV layout (generateSegmentationCSVReport), NiiVue's stats. */
export function segmentationCsv(
  segmentation: { id: string; label?: string },
  reference: Ds,
  segments: ReadonlyArray<CsvSegment>,
): string {
  const refKeys: Array<[string, string]> = [
    ['Series Number', 'SeriesNumber'],
    ['Series Instance UID', 'SeriesInstanceUID'],
    ['Study Instance UID', 'StudyInstanceUID'],
    ['Series Date', 'SeriesDate'],
    ['Series Time', 'SeriesTime'],
    ['Series Description', 'SeriesDescription'],
  ]
  const rows: unknown[][] = [
    ['Segmentation ID', segmentation.id],
    ['Segmentation Label', segmentation.label ?? ''],
    [],
    ...refKeys
      .filter(([, k]) => reference[k] !== undefined && reference[k] !== '')
      .map(([name, k]) => [`reference ${name}`, reference[k]]),
    [],
    ['Segments Statistics'],
    ['Label', ...segments.map((s) => s.label)],
    ['Segment Index', ...segments.map((s) => s.value)],
    ['Locked', ...segments.map((s) => (s.locked ? 'Yes' : 'No'))],
    ['Active', ...segments.map((s) => (s.active ? 'Yes' : 'No'))],
    ['Voxels', ...segments.map((s) => s.count)],
    ['Volume (mm³)', ...segments.map((s) => s.volume)],
  ]
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = String(cell ?? '')
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(','),
    )
    .join('\n')
}
