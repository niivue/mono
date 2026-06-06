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

/** Standard ppm reference (receiver-centre chemical shift) per nucleus. */
const PPM_REF: Record<string, number> = {
  '1H': 4.65,
  '2H': 4.65,
  '31P': 0,
  '13C': 0,
}

export function ppmRefForNucleus(nucleus: string): number {
  return PPM_REF[nucleus] ?? 0
}

/** Default display state for a freshly loaded signal. */
export function defaultSignalDisplay(): NVSignalDisplay {
  return {
    average: true,
    mode: 'real',
    ppmRange: null,
    ppmRef: null,
    useHz: false,
    selectedColumns: null,
    showLegend: true,
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
        const tre = cre * re[b] - cim * im[b]
        const tim = cre * im[b] + cim * re[b]
        re[b] = re[a] - tre
        im[b] = im[a] - tim
        re[a] += tre
        im[a] += tim
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
  const ore = new Float64Array(n)
  const oim = new Float64Array(n)
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
    ore[k] = sre
    oim[k] = sim
  }
  re.set(ore)
  im.set(oim)
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
  const half = Math.floor(nFFT / 2)
  const shift = Math.ceil(nFFT / 2)
  const xShift = new Float32Array(nFFT)
  for (let i = 0; i < nFFT; i++) {
    const hz = dwell > 0 ? (i - half) / (nFFT * dwell) : i - half
    xShift[i] = useHz ? hz : -hz / (spectrometerFreq as number) + ref
  }
  const reverse = !useHz // ppm descends with Hz; reverse to keep x ascending
  const x = reverse ? reversedF32(xShift) : xShift

  const series: SignalSeries[] = inputs.map(({ re, im, label }) => {
    fft(re, im)
    const y = new Float32Array(nFFT)
    for (let i = 0; i < nFFT; i++) {
      const src = (i + shift) % nFFT
      y[i] = projectComponent(re[src], im[src], display.mode)
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
  const selected = display.selectedColumns ?? columns.map((_, i) => i)
  const series: SignalSeries[] = selected
    .filter((i) => i >= 0 && i < columns.length)
    .map((i) => ({
      label: columnLabels[i] ?? `column ${i}`,
      x,
      y: columns[i],
    }))
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
