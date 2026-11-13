// Philips TIFF (ImageDescription is a DPUfsImport XML): every level is padded
// to whole tiles, so its downsample is not its size ratio. The XML lists each
// pixel data representation's padded size and pixel spacing; the downsample is
// the spacing ratio to representation 0. Spec: scratch/vendor/philips-spec.md.

import { elementText } from './placement'

export interface PhilipsLevel {
  /** Padded storage size, as the TIFF image states it. */
  columns: number
  rows: number
  downsample: number
}

const REPRESENTATION =
  /<DataObject ObjectType="PixelDataRepresentation">([\s\S]*?)<\/DataObject>/g

const attribute = (block: string, name: string) =>
  // A lookahead: a plain `[^<>]*Name=` prefix backtracks quadratically.
  elementText(block, `(?=[^<>]*Name="${name}")`)

/** The representations of a Philips XML by number, or null when it states none. */
export function philipsLevels(xml: string): PhilipsLevel[] | null {
  if (!xml.includes('DPUfsImport')) return null
  const reps = Array.from(xml.matchAll(REPRESENTATION), ([, b = '']) => ({
    n: Number(attribute(b, 'PIIM_PIXEL_DATA_REPRESENTATION_NUMBER')),
    columns: Number(attribute(b, 'PIIM_PIXEL_DATA_REPRESENTATION_COLUMNS')),
    rows: Number(attribute(b, 'PIIM_PIXEL_DATA_REPRESENTATION_ROWS')),
    // "0.000227273" "0.000227273" (quotes may be entity-escaped).
    spacing: Number(
      /[\d.eE+-]+/.exec(
        (attribute(b, 'DICOM_PIXEL_SPACING') ?? '').replace(/&quot;/g, '"'),
      )?.[0],
    ),
  })).sort((a, b) => a.n - b.n)
  const s0 = reps[0]?.spacing
  if (
    !(s0 && s0 > 0) ||
    reps.some((r) => !(r.spacing > 0 && r.columns > 0 && r.rows > 0))
  )
    return null
  return reps.map(({ columns, rows, spacing }) => {
    const d = spacing / s0
    // Spacings are printed to 6 digits: snap to a whole factor within 0.1%.
    const whole = Math.round(d)
    return {
      columns,
      rows,
      downsample: Math.abs(d - whole) <= whole * 1e-3 ? whole : d,
    }
  })
}

// DICOM_PIXEL_SPACING (row\col, mm) in `xml`, as [x, y] mm.
function spacingOf(xml: string): [number, number] | undefined {
  const [row = 0, col = row] =
    (attribute(xml, 'DICOM_PIXEL_SPACING') ?? '')
      .replace(/&quot;/g, '"')
      .match(/[\d.eE+-]+/g)
      ?.map(Number) ?? []
  return row > 0 && col > 0 ? [col, row] : undefined
}

/**
 * The scanned image's DICOM_PIXEL_SPACING (outside any representation) as
 * [x, y] mm, else representation 0's (the lowest number, as `philipsLevels`
 * orders them). Representations state rounded nominal spacings (Philips-1:
 * 0.000227273 against 0.000226891 \ 0.000226907).
 */
export function philipsSpacingMM(xml: string): [number, number] | undefined {
  const reps = Array.from(xml.matchAll(REPRESENTATION), ([, b = '']) => b)
  const n = (b: string) =>
    Number(attribute(b, 'PIIM_PIXEL_DATA_REPRESENTATION_NUMBER'))
  const first = reps.sort((a, b) => n(a) - n(b))[0]
  return (
    spacingOf(xml.replace(REPRESENTATION, '')) ??
    (first === undefined ? undefined : spacingOf(first))
  )
}
