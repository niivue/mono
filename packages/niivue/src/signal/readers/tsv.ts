import * as NVGz from '@/codecs/NVGz'
import type { NVSignalPhysioRaw, SignalSidecar } from '@/NVTypes'

export const extensions = ['tsv', 'tsv.gz']
export const type = 'tsv'

/** Blank or a recognized BIDS missing-value token. */
function isMissingToken(token: string): boolean {
  const t = token.trim().toLowerCase()
  return t === '' || t === 'n/a' || t === 'na' || t === 'nan'
}

/** Parse a single cell as float; blank/non-numeric becomes NaN (a trace gap). */
function toFloat(token: string): number {
  if (isMissingToken(token)) return Number.NaN
  const v = Number(token.trim())
  return Number.isNaN(v) ? Number.NaN : v
}

/** A genuine text label: non-empty, not a missing token, and not numeric. */
function isLabelToken(token: string): boolean {
  return !isMissingToken(token) && Number.isNaN(Number(token.trim()))
}

/**
 * Parse BIDS physio TSV text into typed columns.
 *
 * BIDS physio files have no header row, but this is robust to a stray leading
 * all-non-numeric row (treated as column labels) and to non-numeric cells
 * (stored as NaN gaps). Column labels prefer the sidecar `Columns`, then an
 * in-file header row, then a generic fallback.
 */
export function parseTsv(
  text: string,
  sidecar?: SignalSidecar | null,
): NVSignalPhysioRaw {
  const rows: string[][] = []
  let header: string[] | null = null
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (line.trim() === '') continue
    const cells = line.split('\t')
    if (rows.length === 0 && header === null) {
      // A leading row is a header only if every cell is non-numeric AND at least
      // one is a genuine label (not just missing-value tokens) — so a first data
      // row of all-missing values is kept as data, not mistaken for labels.
      const allNonNumeric = cells.every((c) => Number.isNaN(toFloat(c)))
      if (allNonNumeric && cells.some(isLabelToken)) {
        header = cells.map((c) => c.trim())
        continue
      }
    }
    rows.push(cells)
  }
  if (rows.length === 0) {
    throw new Error('tsv reader: no data rows found')
  }
  const ncol = rows.reduce((m, r) => Math.max(m, r.length), 0)
  const columns: Float32Array[] = []
  for (let c = 0; c < ncol; c++) {
    const col = new Float32Array(rows.length)
    for (let r = 0; r < rows.length; r++) {
      const cells = rows[r]
      col[r] = c < cells.length ? toFloat(cells[c]) : Number.NaN
    }
    columns.push(col)
  }
  const labels = sidecar?.columns ?? header
  const columnLabels = columns.map((_, i) => labels?.[i] ?? `column ${i}`)
  return {
    kind: 'physio',
    columns,
    columnLabels,
    samplingFrequency: sidecar?.samplingFrequency ?? null,
    startTime: sidecar?.startTime ?? 0,
  }
}

export async function read(
  buffer: ArrayBuffer,
  _name?: string,
  sidecar?: SignalSidecar | null,
): Promise<NVSignalPhysioRaw> {
  const raw = await NVGz.maybeDecompress(buffer)
  const text = new TextDecoder().decode(raw)
  return parseTsv(text, sidecar)
}
