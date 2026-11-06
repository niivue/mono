// lcov parsing and source-size estimates shared by lcov-to-summary.ts and
// coverage-merge.ts.

export type LcovRecord = {
  file: string
  /** DA records: line number to hit count. */
  lines: Map<number, number>
  linesFound: number
  linesHit: number
  fnFound: number
  fnHit: number
  brFound: number
  brHit: number
}

/** Parses lcov text. LF/LH/FNF/FNH/BRF/BRH are taken as written. */
export function parseLcov(lcov: string): LcovRecord[] {
  const records: LcovRecord[] = []
  let current: LcovRecord | null = null
  for (const rawLine of lcov.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('SF:')) {
      current = {
        file: line.slice(3),
        lines: new Map(),
        linesFound: 0,
        linesHit: 0,
        fnFound: 0,
        fnHit: 0,
        brFound: 0,
        brHit: 0,
      }
      continue
    }
    if (!current) continue
    if (line === 'end_of_record') {
      records.push(current)
      current = null
      continue
    }
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon)
    const rest = line.slice(colon + 1)
    if (key === 'DA') {
      const [lineNo, hits] = rest.split(',').map(Number)
      if (lineNo !== undefined && hits !== undefined && !Number.isNaN(lineNo))
        current.lines.set(lineNo, (current.lines.get(lineNo) ?? 0) + hits)
      continue
    }
    const value = Number(rest)
    if (Number.isNaN(value)) continue
    switch (key) {
      case 'LF':
        current.linesFound = value
        break
      case 'LH':
        current.linesHit = value
        break
      case 'FNF':
        current.fnFound = value
        break
      case 'FNH':
        current.fnHit = value
        break
      case 'BRF':
        current.brFound = value
        break
      case 'BRH':
        current.brHit = value
        break
    }
  }
  return records
}

// Estimate executable lines and functions of a file no test loaded: strip
// TypeScript-only syntax, then count non-blank lines and function forms.
const transpiler = new Bun.Transpiler({ loader: 'ts' })
const functionPattern =
  /\bfunction\b|=>|^\s*(?:(?:static|async|get|set|public|private|protected)\s+)*(?:constructor|[A-Za-z_$#][\w$]*)\s*\([^)]*\)\s*\{/gm

export function estimateSource(code: string): {
  lines: number
  functions: number
} {
  let js: string
  try {
    js = transpiler.transformSync(code)
  } catch {
    js = code
  }
  const lines = js.split('\n').filter((l) => {
    const t = l.trim()
    return t !== '' && !t.startsWith('//')
  }).length
  const functions = (js.match(functionPattern) ?? []).filter(
    (m) => !/^\s*(?:if|for|while|switch|catch|return)\b/.test(m),
  ).length
  return { lines, functions }
}
