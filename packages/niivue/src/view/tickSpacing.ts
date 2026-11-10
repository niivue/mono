function nice(x: number, round: boolean): number {
  const exp = Math.floor(Math.log(x) / Math.log(10))
  const f = x / 10 ** exp
  let nf: number
  if (round) {
    if (f < 1.5) nf = 1
    else if (f < 3) nf = 2
    else if (f < 7) nf = 5
    else nf = 10
  } else {
    if (f <= 1) nf = 1
    else if (f <= 2) nf = 2
    else if (f <= 5) nf = 5
    else nf = 10
  }
  return nf * 10 ** exp
}

export function calculateTickSpacing(
  min: number,
  max: number,
): [spacing: number, ticMin: number, ticMax: number] {
  const range = max - min
  if (range <= 0) return [1, min, max]
  const maxTicks = 5
  const niceRange = nice(range, false)
  const spacing = nice(niceRange / (maxTicks - 1), true)
  const ticMin = Math.floor(min / spacing) * spacing
  const ticMax = Math.ceil(max / spacing) * spacing
  return [spacing, ticMin, ticMax]
}

export function humanize(x: number): string {
  return x.toFixed(6).replace(/\.?0*$/, '')
}
