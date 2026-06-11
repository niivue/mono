import type {
  NVSignalDisplay,
  NVSignalPhysioRaw,
  NVSignalRaw,
  NVSignalSpectroscopyRaw,
  SignalAxis,
  SignalSeries,
  SignalSpectrumMode,
} from '@/NVTypes'

/** Result of a display transform: traces plus their shared independent axis. */
export type SignalPlot = {
  series: SignalSeries[]
  axis: SignalAxis
}

// ---------------------------------------------------------------------------
// Nucleus constants (ported verbatim from fsleyes-plugin-mrs constants.py,
// BSD-3, (c) 2021 William Clarke, University of Oxford). See nv-ext-mrs/PORTING.md.
// ---------------------------------------------------------------------------

/** Gyromagnetic ratio (MHz/T) per nucleus. */
export const GYRO_MAG_RATIO: Record<string, number> = {
  '1H': 42.576,
  '2H': 6.536,
  '13C': 10.7084,
  '31P': 17.235,
}

/**
 * Receiver-centre chemical-shift reference (ppm) per nucleus — the ppm value of
 * the 0 Hz bin. Used as the additive offset of the Hz->ppm display transform.
 */
export const PPM_SHIFT: Record<string, number> = {
  '1H': 4.65,
  '2H': 4.8,
  '13C': 0.0,
  '31P': 0.0,
}

/** Default ppm display window [lo, hi] per nucleus. */
export const PPM_RANGE: Record<string, [number, number]> = {
  '1H': [0.2, 4.2],
  '2H': [0.0, 6],
  '13C': [10, 100],
  '31P': [-20, 10],
}

export function ppmRefForNucleus(nucleus: string): number {
  return PPM_SHIFT[nucleus] ?? 0
}

/** Default display state for a freshly loaded signal. */
export function defaultSignalDisplay(): NVSignalDisplay {
  return {
    average: true,
    mode: 'real',
    ppmRange: null,
    ppmRef: null,
    useHz: false,
    // FSL-MRS spectral processing (all off by default so the existing svs.html
    // baseline is unchanged; nv-ext-mrs opts in to halveFirstPoint etc.).
    halveFirstPoint: false,
    apodizeHz: 0,
    phase0: 0,
    phase1Ms: 0,
    selectedColumns: null,
    showLegend: true,
  }
}

// ---------------------------------------------------------------------------
// FSL-MRS spectral transforms (ports of fsleyes-plugin-mrs utils.py /
// fsleyes powerspectrumseries.py). See nv-ext-mrs/PORTING.md for provenance.
// ---------------------------------------------------------------------------

/**
 * Halve the first complex FID sample in place. FSL-MRS `calcSpectrum` does
 * `fid[0] *= 0.5` before the FFT to correct the DC/baseline offset of a
 * discretely-sampled FID (the first point is half-weighted in the integral).
 */
export function halveFirstPoint(re: Float64Array, im: Float64Array): void {
  re[0] *= 0.5
  im[0] *= 0.5
}

/**
 * Exponential apodization (Lorentzian line-broadening) of a complex FID, in
 * place. Mirrors FSL-MRS `apodize`: `window[t] = exp(-t / (1/broadeningHz))`
 * with `t = i * dwell` (seconds). A non-positive broadening is a no-op.
 */
export function apodize(
  re: Float64Array,
  im: Float64Array,
  dwell: number,
  broadeningHz: number,
): void {
  if (!(broadeningHz > 0)) return
  for (let i = 0; i < re.length; i++) {
    const w = Math.exp(-i * dwell * broadeningHz)
    re[i] *= w
    im[i] *= w
  }
}

/**
 * Apply 0th + 1st order phase correction to a complex spectrum in place.
 * Mirrors fsleyes `phaseCorrection`: multiply by
 * `exp(1j * 2*pi * (p0/360 + freqs*p1))`, with `p0` in degrees and `p1` in
 * seconds. `freqs` are the Hz bins in the same order as `re`/`im`.
 */
export function phaseCorrection(
  re: Float64Array,
  im: Float64Array,
  freqs: Float64Array,
  p0deg: number,
  p1sec: number,
): void {
  if (p0deg === 0 && p1sec === 0) return
  for (let i = 0; i < re.length; i++) {
    const ang = 2 * Math.PI * (p0deg / 360 + freqs[i] * p1sec)
    const c = Math.cos(ang)
    const s = Math.sin(ang)
    const r = re[i]
    const m = im[i]
    re[i] = r * c - m * s
    im[i] = r * s + m * c
  }
}

// ---------------------------------------------------------------------------
// FFT (forward, numpy `fft` sign convention: exp(-2*pi*i*k*n/N))
// ---------------------------------------------------------------------------

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0
}

function nextPow2(n: number): number {
  if (n < 1) return 1
  let p = 1
  while (p < n) p <<= 1
  return p
}

/** In-place iterative radix-2 Cooley-Tukey FFT (n must be a power of two). */
function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wre = Math.cos(ang)
    const wim = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cre = 1
      let cim = 0
      for (let k = 0; k < len >> 1; k++) {
        const a = i + k
        const b = a + (len >> 1)
        const tmpRe = cre * re[b] - cim * im[b]
        const tmpIm = cre * im[b] + cim * re[b]
        re[b] = re[a] - tmpRe
        im[b] = im[a] - tmpIm
        re[a] += tmpRe
        im[a] += tmpIm
        const ncre = cre * wre - cim * wim
        cim = cre * wim + cim * wre
        cre = ncre
      }
    }
  }
}

/** Direct O(n^2) DFT fallback for non-power-of-two lengths (correctness over speed). */
function dft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  const outRe = new Float64Array(n)
  const outIm = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    let sre = 0
    let sim = 0
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n
      const c = Math.cos(ang)
      const s = Math.sin(ang)
      sre += re[t] * c - im[t] * s
      sim += re[t] * s + im[t] * c
    }
    outRe[k] = sre
    outIm[k] = sim
  }
  re.set(outRe)
  im.set(outIm)
}

/** Forward FFT in place. Uses radix-2 when possible, else a direct DFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  if (isPow2(re.length)) fftRadix2(re, im)
  else dft(re, im)
}

function projectComponent(
  re: number,
  im: number,
  mode: SignalSpectrumMode,
): number {
  switch (mode) {
    case 'real':
      return re
    case 'imag':
      return im
    case 'magnitude':
      return Math.hypot(re, im)
    case 'phase':
      return Math.atan2(im, re)
  }
}

// ---------------------------------------------------------------------------
// Spectroscopy
// ---------------------------------------------------------------------------

/**
 * Transform a complex FID to one or more spectra. Mirrors spec2graph.py:
 * optional transient averaging before the FFT, fftshift to centre zero
 * frequency, projection to a real component, and an x-axis in ppm (MR
 * convention, drawn high-to-low) or Hz.
 *
 * Series x-arrays are returned in ascending order; `axis.reversed` carries the
 * MR display convention so the renderer flips ppm without the data needing to
 * be stored backwards.
 */
export function deriveSpectroscopySeries(
  raw: NVSignalSpectroscopyRaw,
  display: NVSignalDisplay,
): SignalPlot {
  const { fid, nPoints, nTransients, dwell, spectrometerFreq, nucleus } = raw
  const useHz = display.useHz || !spectrometerFreq
  const ref = display.ppmRef ?? ppmRefForNucleus(nucleus)
  // Zero-fill non-power-of-two FIDs to the next power of two so the transform
  // always uses the fast radix-2 path (avoids an O(n^2) DFT on real-size data).
  // Zero-filling is a standard MRS step that interpolates the spectrum; the
  // x-axis is computed over the padded length so bins stay correct.
  const nFFT = nextPow2(nPoints)

  // Gather the FIDs to transform (one averaged, or one per transient), each
  // allocated at the padded length (extra samples are zero).
  const inputs: { re: Float64Array; im: Float64Array; label: string }[] = []
  if (display.average && nTransients > 1) {
    const re = new Float64Array(nFFT)
    const im = new Float64Array(nFFT)
    for (let t = 0; t < nTransients; t++) {
      for (let p = 0; p < nPoints; p++) {
        const k = 2 * (t * nPoints + p)
        re[p] += fid[k]
        im[p] += fid[k + 1]
      }
    }
    for (let p = 0; p < nPoints; p++) {
      re[p] /= nTransients
      im[p] /= nTransients
    }
    inputs.push({ re, im, label: 'average' })
  } else {
    for (let t = 0; t < nTransients; t++) {
      const re = new Float64Array(nFFT)
      const im = new Float64Array(nFFT)
      for (let p = 0; p < nPoints; p++) {
        const k = 2 * (t * nPoints + p)
        re[p] = fid[k]
        im[p] = fid[k + 1]
      }
      inputs.push({
        re,
        im,
        label: nTransients > 1 ? `transient ${t}` : 'spectrum',
      })
    }
  }

  // Shared x-axis, computed in fftshift (ascending Hz) order over nFFT bins.
  // `hzShift` keeps the Hz bins regardless of the display axis; phase
  // correction is defined in Hz so it needs them even when ppm is shown.
  const half = Math.floor(nFFT / 2)
  const shift = Math.ceil(nFFT / 2)
  const xShift = new Float32Array(nFFT)
  const hzShift = new Float64Array(nFFT)
  for (let i = 0; i < nFFT; i++) {
    const hz = dwell > 0 ? (i - half) / (nFFT * dwell) : i - half
    hzShift[i] = hz
    xShift[i] = useHz ? hz : -hz / (spectrometerFreq as number) + ref
  }
  const reverse = !useHz // ppm descends with Hz; reverse to keep x ascending
  const x = reverse ? reversedF32(xShift) : xShift

  const p1sec = (display.phase1Ms ?? 0) / 1000
  const p0deg = display.phase0 ?? 0
  const apodizeHz = display.apodizeHz ?? 0
  const series: SignalSeries[] = inputs.map(({ re, im, label }) => {
    // Time-domain processing (FSL-MRS order: apodize, then halve first point).
    apodize(re, im, dwell, apodizeHz)
    if (display.halveFirstPoint) halveFirstPoint(re, im)
    fft(re, im)
    // fftshift into ascending-Hz order so phase correction sees matching bins.
    const sre = new Float64Array(nFFT)
    const sim = new Float64Array(nFFT)
    for (let i = 0; i < nFFT; i++) {
      const src = (i + shift) % nFFT
      sre[i] = re[src]
      sim[i] = im[src]
    }
    phaseCorrection(sre, sim, hzShift, p0deg, p1sec)
    const y = new Float32Array(nFFT)
    for (let i = 0; i < nFFT; i++) {
      y[i] = projectComponent(sre[i], sim[i], display.mode)
    }
    return { label, x, y: reverse ? reversedF32(y) : y }
  })

  const axis: SignalAxis = {
    label: useHz ? 'Frequency (Hz)' : 'Chemical shift (ppm)',
    reversed: !useHz,
    min: !useHz && display.ppmRange ? Math.min(...display.ppmRange) : null,
    max: !useHz && display.ppmRange ? Math.max(...display.ppmRange) : null,
  }
  return { series, axis }
}

function reversedF32(a: Float32Array): Float32Array {
  const n = a.length
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = a[n - 1 - i]
  return out
}

/** Options for {@link integratePpmBandMap}, mirroring the FSL-MRS range tool. */
export type PpmBandOptions = {
  /** integrate `|spectrum|` ('magnitude', default) or `real(spectrum)` ('real') */
  mode?: 'magnitude' | 'real'
  apodizeHz?: number
  /** 0th-order phase, degrees */
  phase0?: number
  /** 1st-order phase, milliseconds */
  phase1Ms?: number
  halveFirstPoint?: boolean
}

/**
 * Integrate a ppm band across every spatial voxel of a complex MRSI FID buffer,
 * producing a 3D scalar metabolite map (one value per voxel, native order).
 * Ports fsleyes-plugin-mrs `range_tool.draw_overlay`: per voxel, average any
 * transients, apodize, halve first point, FFT, fftshift, phase-correct, then
 * sum `|spectrum|` (or `real`) over the bins whose ppm falls in `band`.
 *
 * `complexFID` is interleaved re/im in NIfTI native order, indexed so the
 * complex sample for spatial voxel `v`, spectral point `p`, transient `t` is at
 * `2 * (v + p*nVox3D + t*nVox3D*nPoints)`.
 *
 * When `spectrometerFreq` is null no ppm axis exists, so the map degrades to a
 * first-point magnitude image (a cheap "total signal" proxy).
 */
export function integratePpmBandMap(
  complexFID: Float32Array,
  nVox3D: number,
  nPoints: number,
  nTransients: number,
  dwell: number,
  spectrometerFreq: number | null,
  nucleus: string,
  band: [number, number],
  opts: PpmBandOptions = {},
): Float32Array {
  const useMag = (opts.mode ?? 'magnitude') === 'magnitude'
  const out = new Float32Array(nVox3D)
  if (!spectrometerFreq) {
    for (let v = 0; v < nVox3D; v++) {
      const ci = 2 * v
      out[v] = Math.hypot(complexFID[ci] ?? 0, complexFID[ci + 1] ?? 0)
    }
    return out
  }
  const nFFT = nextPow2(nPoints)
  const half = Math.floor(nFFT / 2)
  const shift = Math.ceil(nFFT / 2)
  const ref = PPM_SHIFT[nucleus] ?? 0
  const lo = Math.min(band[0], band[1])
  const hi = Math.max(band[0], band[1])
  const hzShift = new Float64Array(nFFT)
  const bandIdx: number[] = []
  for (let i = 0; i < nFFT; i++) {
    const hz = dwell > 0 ? (i - half) / (nFFT * dwell) : i - half
    hzShift[i] = hz
    const ppm = -hz / spectrometerFreq + ref
    if (ppm >= lo && ppm <= hi) bandIdx.push(i)
  }
  if (bandIdx.length === 0) return out
  const p1sec = (opts.phase1Ms ?? 0) / 1000
  const p0deg = opts.phase0 ?? 0
  const apoHz = opts.apodizeHz ?? 0
  const halveFP = opts.halveFirstPoint ?? false
  const re = new Float64Array(nFFT)
  const im = new Float64Array(nFFT)
  const sre = new Float64Array(nFFT)
  const sim = new Float64Array(nFFT)
  for (let v = 0; v < nVox3D; v++) {
    re.fill(0)
    im.fill(0)
    for (let t = 0; t < nTransients; t++) {
      const tBase = t * nVox3D * nPoints
      for (let p = 0; p < nPoints; p++) {
        const ci = 2 * (v + p * nVox3D + tBase)
        // `?? 0` guards a truncated/short buffer (no NaN propagation).
        re[p] += complexFID[ci] ?? 0
        im[p] += complexFID[ci + 1] ?? 0
      }
    }
    if (nTransients > 1) {
      for (let p = 0; p < nPoints; p++) {
        re[p] /= nTransients
        im[p] /= nTransients
      }
    }
    apodize(re, im, dwell, apoHz)
    if (halveFP) halveFirstPoint(re, im)
    fft(re, im)
    for (let i = 0; i < nFFT; i++) {
      const src = (i + shift) % nFFT
      sre[i] = re[src]
      sim[i] = im[src]
    }
    phaseCorrection(sre, sim, hzShift, p0deg, p1sec)
    let s = 0
    for (const i of bandIdx) s += useMag ? Math.hypot(sre[i], sim[i]) : sre[i]
    out[v] = s
  }
  return out
}

// ---------------------------------------------------------------------------
// Physio
// ---------------------------------------------------------------------------

/**
 * Build physio traces with a time (s) x-axis derived from the sampling rate and
 * StartTime, falling back to a sample-index axis when the rate is unknown.
 * `display.selectedColumns` filters which columns become series.
 */
export function derivePhysioSeries(
  raw: NVSignalPhysioRaw,
  display: NVSignalDisplay,
): SignalPlot {
  const { columns, columnLabels, samplingFrequency, startTime } = raw
  const n = columns.length > 0 ? columns[0].length : 0
  let x: Float32Array | null = null
  let axisLabel = 'Sample'
  if (samplingFrequency && samplingFrequency > 0) {
    x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = startTime + i / samplingFrequency
    axisLabel = 'Time (s)'
  }
  const labelOf = (i: number): string =>
    typeof columnLabels[i] === 'string'
      ? columnLabels[i].trim().toLowerCase()
      : ''
  // Trigger columns (BIDS / bidsphysio): the plain "trigger" is the SCANNER
  // VOLUME trigger (one pulse per TR — the acquisition grid), and each measure
  // adds its own "<measure>_trigger" event column. Both are markers, not signals.
  const isTriggerLabel = (l: string): boolean =>
    l === 'trigger' || l.endsWith('_trigger')
  // Default (selectedColumns null) plots every NON-trigger column, so a bare
  // loadSignals doesn't draw the binary trigger channels as lines (or let them
  // dominate the y-range). An explicit selection is honoured verbatim — a caller
  // can still plot a trigger column as a normal series if it asks for it.
  const selected =
    display.selectedColumns ??
    columns.map((_, i) => i).filter((i) => !isTriggerLabel(labelOf(i)))
  const series: SignalSeries[] = selected
    .filter((i) => i >= 0 && i < columns.length)
    .map((i) => ({
      label: columnLabels[i] ?? `column ${i}`,
      x,
      y: columns[i],
    }))
  // Per-series trigger rug: for each plotted measure series, attach its
  // "<label>_trigger" events (so a multi-measure file routes cardiac events to
  // the cardiac trace and respiratory events to the respiratory trace). The plain
  // scanner "trigger" column is never shown. Each cell that is BOTH numeric and
  // non-zero is an event (n/a -> NaN and 0 are not); positions go on that series
  // and the graph draws a tick rug along the top.
  for (const s of series) {
    const sLabel = s.label.trim().toLowerCase()
    if (isTriggerLabel(sLabel)) continue // a trigger column plotted explicitly
    const trigIdx = columnLabels.findIndex(
      (l) =>
        typeof l === 'string' && l.trim().toLowerCase() === `${sLabel}_trigger`,
    )
    if (trigIdx < 0) continue
    const col = columns[trigIdx]
    // Bound to the x-domain length `n` (= columns[0].length): the TSV reader pads
    // columns equal, but a programmatic raw could supply a longer trigger column,
    // which would index past the x-array and yield undefined positions.
    const m = Math.min(n, col.length)
    const triggers: number[] = []
    for (let i = 0; i < m; i++) {
      const v = col[i]
      if (Number.isFinite(v) && v !== 0) triggers.push(x ? x[i] : i)
    }
    if (triggers.length > 0) s.triggers = triggers
  }
  const axis: SignalAxis = {
    label: axisLabel,
    reversed: false,
    min: x && n > 0 ? x[0] : null,
    max: x && n > 0 ? x[n - 1] : null,
  }
  return { series, axis }
}

/** Dispatch a raw signal + display state to the appropriate transform. */
export function deriveSeries(
  raw: NVSignalRaw,
  display: NVSignalDisplay,
): SignalPlot {
  return raw.kind === 'spectroscopy'
    ? deriveSpectroscopySeries(raw, display)
    : derivePhysioSeries(raw, display)
}
