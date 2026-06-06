import * as NVGz from '@/codecs/NVGz'
import type { NVSignalPhysioRaw, SignalSidecar } from '@/NVTypes'

export const extensions = ['tsv', 'tsv.gz']
export const type = 'tsv'

/** Parse a single cell as float; blank/non-numeric becomes NaN (a trace gap). */
function toFloat(token: string): number {
  const t = token.trim()
  const lower = t.toLowerCase()
  if (t === '' || lower === 'n/a' || lower === 'na' || lower === 'nan') {
    return Number.NaN
  }
  const v = Number(t)
  return Number.isNaN(v) ? Number.NaN : v
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
      const parsed = cells.map(toFloat)
      const allNaN = parsed.every((v) => Number.isNaN(v))
      const anyText = cells.some((c) => c.trim() !== '')
      if (allNaN && anyText) {
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
