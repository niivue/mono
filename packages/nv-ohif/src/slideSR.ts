// Slide measurement rows as the Comprehensive 3D SR OHIF's microscopy
// extension writes (constructSR) and reads back (loadSR): TID 1500 groups with
// an SCOORD3D image region in the slide's frame of reference. OHIF's measurement
// panel Save runs storeMeasurements in CORNERSTONE_STRUCTURED_REPORT, which
// NIIVUE cannot shadow: routeSlideSR wraps that definition so slide rows take
// this path and every other save goes to OHIF untouched.
import { code, header, newUid } from './segExport'
import { SLIDE_UID_PREFIX } from './toolBridge'

type Ds = Record<string, unknown>

export interface SlideRow {
  uid: string
  label?: string
  /** Slide base-level px (x column, y row, 0 at the first pixel's corner), z 0. */
  points: number[][]
  data?: { length?: number; area?: number; unit?: string }
  metadata?: { slideTool?: string }
  displaySetInstanceUID?: string
}

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v) as Ds | undefined
const nums = (v: unknown) => (Array.isArray(v) ? v.map(Number) : [])

/**
 * The base level's px -> slide mm, as dicom-microscopy-viewer's buildTransform;
 * undefined without the geometry (no guessed spacing or origin).
 */
function slideToFrame(sm: Ds): ((p: number[]) => number[]) | undefined {
  const origin = first(sm.TotalPixelMatrixOriginSequence)
  const o = nums(sm.ImageOrientationSlide)
  const ps = nums(
    first(first(sm.SharedFunctionalGroupsSequence)?.PixelMeasuresSequence)
      ?.PixelSpacing,
  )
  const x0 = Number(origin?.XOffsetInSlideCoordinateSystem)
  const y0 = Number(origin?.YOffsetInSlideCoordinateSystem)
  if (!sm.FrameOfReferenceUID || o.length !== 6 || ps.length !== 2)
    return undefined
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return undefined
  const [o0 = 0, o1 = 0, , o3 = 0, o4 = 0] = o
  const [sr = 0, sc = 0] = ps
  // dmv's half-pixel correction: its origin is the first pixel's centre.
  return ([c = 0, r = 0]) => {
    const [u, v] = [c - 0.5, r - 0.5]
    return [
      +(x0 + o0 * sc * u + o3 * sr * v).toFixed(4),
      +(y0 + o1 * sc * u + o4 * sr * v).toFixed(4),
      0,
    ]
  }
}

/** A row's SCOORD3D graphic: types loadSR reads (POINT, POLYLINE, POLYGON, ELLIPSE). */
function graphic(row: SlideRow): { type: string; points: number[][] } {
  const p = row.points
  const tool = row.metadata?.slideTool
  if (tool === 'point') return { type: 'POINT', points: p.slice(0, 1) }
  if (tool === 'line' || tool === 'freehandLine')
    return { type: 'POLYLINE', points: p }
  if (tool === 'circle') {
    const [[cx = 0, cy = 0] = [], [rx = 0] = []] = p
    const r = rx - cx
    return {
      type: 'ELLIPSE',
      points: [
        [cx - r, cy],
        [cx + r, cy],
        [cx, cy - r],
        [cx, cy + r],
      ],
    }
  }
  if (tool === 'ellipse') {
    // Row points: vertical axis, then horizontal; ELLIPSE lists the major first.
    const len = (a = [0, 0], b = [0, 0]) =>
      Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0))
    const [t, b, l, r] = p
    return {
      type: 'ELLIPSE',
      points: (len(t, b) >= len(l, r)
        ? [t, b, l, r]
        : [l, r, t, b]) as number[][],
    }
  }
  // Closed outlines repeat the first vertex, as dmv's OpenLayers rings do.
  return { type: 'POLYGON', points: [...p, p[0] as number[]] }
}

type Name = [string, string, string]
const item = (rel: string, type: string, [v, s, m]: Name, value: Ds) => ({
  RelationshipType: rel,
  ValueType: type,
  ConceptNameCodeSequence: [code(v, s, m)],
  ...value,
})
const ucum = (unit: string, meaning: string) => ({
  MeasurementUnitsCodeSequence: [code(unit, 'UCUM', meaning)],
})

/**
 * A Comprehensive 3D SR of `rows` (TID 1500, laid out as dcmjs' templates);
 * `smOf` gives each row's base-level SM instance (its frame of reference and
 * transform). Throws when a row lacks slide geometry, so a save never drops
 * rows silently.
 */
// ponytail: hand-built: dcmjs' sr.templates (constructSR's) throw on
// TrackingIdentifier, an Array subclass whose filter() re-runs its constructor.
export function buildSlideSR(
  rows: ReadonlyArray<SlideRow>,
  smOf: (row: SlideRow) => Ds | undefined,
  h: { SeriesDescription?: string; SeriesNumber?: number },
): Ds | undefined {
  const placed = rows.flatMap((row) => {
    const sm = smOf(row)
    const toFrame = sm && slideToFrame(sm)
    return sm && toFrame ? [{ row, sm, toFrame }] : []
  })
  const missing = rows.length - placed.length
  if (missing)
    throw new Error(
      `No slide metadata for ${missing} of ${rows.length} measurements`,
    )
  const sm0 = placed[0]?.sm
  if (!sm0) return undefined
  const specimen = first(sm0.SpecimenDescriptionSequence)
  const groups = placed.map(({ row, sm, toFrame }, i) => {
    const g = graphic(row)
    const { length, area, unit } = row.data ?? {}
    const num = (name: Name, value: number, u: Ds) =>
      item('CONTAINS', 'NUM', name, {
        MeasuredValueSequence: [{ ...u, NumericValue: value }],
      })
    return item(
      'CONTAINS',
      'CONTAINER',
      ['125007', 'DCM', 'Measurement Group'],
      {
        ContinuityOfContent: 'SEPARATE',
        ContentTemplateSequence: [
          { MappingResource: 'DCMR', TemplateIdentifier: '1410' },
        ],
        ContentSequence: [
          item(
            'HAS OBS CONTEXT',
            'TEXT',
            ['112039', 'DCM', 'Tracking Identifier'],
            {
              TextValue: `ROI #${i + 1}`,
            },
          ),
          item(
            'HAS OBS CONTEXT',
            'UIDREF',
            ['112040', 'DCM', 'Tracking Unique Identifier'],
            {
              UID: newUid(),
            },
          ),
          // loadSR reads a row's label back from the finding's code value.
          ...(row.label
            ? [
                item('CONTAINS', 'CODE', ['121071', 'DCM', 'Finding'], {
                  ConceptCodeSequence: [
                    code(
                      row.label,
                      '@ohif/extension-dicom-microscopy',
                      'FREETEXT',
                    ),
                  ],
                }),
              ]
            : []),
          item('CONTAINS', 'SCOORD3D', ['111030', 'DCM', 'Image Region'], {
            GraphicType: g.type,
            GraphicData: g.points.flatMap(toFrame),
            ReferencedFrameOfReferenceUID: sm.FrameOfReferenceUID,
          }),
          ...(unit === 'µm' && length !== undefined
            ? [
                num(
                  ['410668003', 'SCT', 'Length'],
                  length,
                  ucum('um', 'micrometer'),
                ),
              ]
            : []),
          ...(unit === 'µm' && area !== undefined
            ? [
                num(
                  ['42798000', 'SCT', 'Area'],
                  area,
                  ucum('um2', 'square micrometer'),
                ),
              ]
            : []),
        ],
      },
    )
  })
  const evidence = [...new Set(placed.map((p) => p.sm))]
  const series = [...new Set(evidence.map((e) => e.SeriesInstanceUID))]
  return {
    ...header(sm0, '1.2.840.10008.5.1.4.1.1.88.34', 'SR', {
      SeriesDescription:
        h.SeriesDescription || 'Whole slide imaging structured report',
      SeriesNumber: h.SeriesNumber ?? 4701,
    }),
    CompletionFlag: 'COMPLETE',
    VerificationFlag: 'UNVERIFIED',
    ValueType: 'CONTAINER',
    ConceptNameCodeSequence: [
      code('126000', 'DCM', 'Imaging Measurement Report'),
    ],
    ContinuityOfContent: 'SEPARATE',
    ContentTemplateSequence: [
      { MappingResource: 'DCMR', TemplateIdentifier: '1500' },
    ],
    CurrentRequestedProcedureEvidenceSequence: [
      {
        StudyInstanceUID: sm0.StudyInstanceUID,
        ReferencedSeriesSequence: series.map((uid) => ({
          SeriesInstanceUID: uid,
          ReferencedSOPSequence: evidence
            .filter((e) => e.SeriesInstanceUID === uid)
            .map((e) => ({
              ReferencedSOPClassUID: e.SOPClassUID,
              ReferencedSOPInstanceUID: e.SOPInstanceUID,
            })),
        })),
      },
    ],
    ContentSequence: [
      item(
        'HAS CONCEPT MOD',
        'CODE',
        ['121049', 'DCM', 'Language of Content Item and Descendants'],
        {
          ConceptCodeSequence: [code('eng', 'RFC5646', 'English')],
        },
      ),
      item(
        'HAS OBS CONTEXT',
        'PNAME',
        ['121008', 'DCM', 'Person Observer Name'],
        {
          PersonName: '@niivue/nv-ohif',
        },
      ),
      // The subject is the specimen, as constructSR's observation context.
      item('HAS OBS CONTEXT', 'CODE', ['121024', 'DCM', 'Subject Class'], {
        ConceptCodeSequence: [code('121027', 'DCM', 'Specimen')],
      }),
      item('HAS OBS CONTEXT', 'UIDREF', ['121039', 'DCM', 'Specimen UID'], {
        UID: specimen?.SpecimenUID ?? sm0.SeriesInstanceUID,
      }),
      item(
        'HAS OBS CONTEXT',
        'TEXT',
        ['121041', 'DCM', 'Specimen Identifier'],
        {
          TextValue: specimen?.SpecimenIdentifier ?? sm0.SeriesInstanceUID,
        },
      ),
      item(
        'HAS OBS CONTEXT',
        'TEXT',
        ['111700', 'DCM', 'Specimen Container Identifier'],
        {
          TextValue: sm0.ContainerIdentifier ?? sm0.SeriesInstanceUID,
        },
      ),
      item('HAS CONCEPT MOD', 'CODE', ['121058', 'DCM', 'Procedure reported'], {
        ConceptCodeSequence: [code('112703', 'DCM', 'Whole Slide Imaging')],
      }),
      item('CONTAINS', 'CONTAINER', ['126010', 'DCM', 'Imaging Measurements'], {
        ContinuityOfContent: 'SEPARATE',
        ContentSequence: groups,
      }),
    ],
  }
}

const SR_CONTEXT = 'CORNERSTONE_STRUCTURED_REPORT'
type Definition = { commandFn: (o: Record<string, unknown>) => unknown }
export interface CommandsLike {
  runCommand?: (n: string, o?: Record<string, unknown>) => unknown
  getCommand?: (name: string, context: string) => Definition | undefined
  registerCommand?: (context: string, name: string, def: Definition) => void
}
const routed = new WeakSet<Definition>()

/**
 * Wrap OHIF's storeMeasurements so a save holding slide rows writes them as a
 * microscopy SR (to the dialog's data source, as OHIF's SR store does).
 */
export function routeSlideSR(
  commands: CommandsLike | undefined,
  smOf: (row: SlideRow) => Ds | undefined,
): void {
  const original = commands?.getCommand?.('storeMeasurements', SR_CONTEXT)
  if (!original || routed.has(original)) return
  const def: Definition = {
    ...original,
    commandFn: async (opts) => {
      const all = (opts.measurementData ?? []) as ReadonlyArray<SlideRow>
      const isSlide = (m: SlideRow) => m.uid?.startsWith(SLIDE_UID_PREFIX)
      const rows = all.filter(isSlide)
      if (!rows.length) return original.commandFn(opts)
      // Built first: a build that throws must not leave OHIF's SR stored, or a retry duplicates it.
      const dataset = buildSlideSR(rows, smOf, opts.options ?? {})
      if (!dataset) throw new Error('No slide metadata for these measurements')
      // Other rows still go to OHIF's SR (its own series, stored first).
      const rest = all.filter((m) => !isSlide(m))
      if (rest.length)
        await original.commandFn({ ...opts, measurementData: rest })
      const store = commands?.runCommand?.('createStoreFunction', {
        dataSource: opts.dataSource,
        defaultFileName: 'sr-microscopy.dcm',
      }) as ((ds: Ds) => Promise<void>) | null | undefined
      if (!store) throw new Error(`No valid store for ${opts.dataSource}`)
      await store(dataset)
      return dataset
    },
  }
  routed.add(def)
  commands?.registerCommand?.(SR_CONTEXT, 'storeMeasurements', def)
}
