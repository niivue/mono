// Strided chunk -> output copy shared by the main thread (indexing/ops.ts) and
// the decode workers. Plain JS so workers can load it unbundled.
//
// Works on raw bytes through integer views (never Float64Array), so NaN
// payloads and -0 are copied bit for bit.

/** Number of indices in [start, stop) with the given positive step. */
function indicesLen(start, stop, step) {
  return start < stop ? Math.floor((stop - start - 1) / step) + 1 : 0
}

/**
 * Turn zarrita projections into a flat copy plan in element units.
 * Returns null when a projection broadcasts a scalar (the `set` path).
 * Dimensions contiguous in both arrays are merged so the inner run is as long
 * as possible.
 *
 * @param {number[]} destStride
 * @param {number[]} srcStride
 * @param {Array<{from: number | number[] | null, to: number | number[] | null}>} projections
 */
export function planCopy(destStride, srcStride, projections) {
  const lens = []
  const dsteps = []
  const ssteps = []
  let doff = 0
  let soff = 0
  let k = 0
  for (let i = 0; i < projections.length; i++) {
    const p = projections[i]
    if (p.from === null) return null
    if (p.to === null) {
      soff += srcStride[i] * p.from
      continue
    }
    const [from, to, step] = p.to
    const [sfrom, , sstep] = p.from
    const len = indicesLen(from, to, step)
    if (len === 0) return { empty: true }
    doff += destStride[k] * from
    soff += srcStride[i] * sfrom
    if (len > 1) {
      lens.push(len)
      dsteps.push(destStride[k] * step)
      ssteps.push(srcStride[i] * sstep)
    }
    k++
  }
  for (let i = lens.length - 2; i >= 0; i--) {
    const j = i + 1
    if (
      dsteps[i] === lens[j] * dsteps[j] &&
      ssteps[i] === lens[j] * ssteps[j]
    ) {
      lens[i] *= lens[j]
      dsteps[i] = dsteps[j]
      ssteps[i] = ssteps[j]
      lens.splice(j, 1)
      dsteps.splice(j, 1)
      ssteps.splice(j, 1)
    }
  }
  return { empty: false, doff, soff, lens, dsteps, ssteps }
}

const VIEWS = { 1: Uint8Array, 2: Uint16Array, 4: Uint32Array }

/**
 * Execute a copy plan between two byte regions.
 *
 * @param {ArrayBufferLike} destBuf  @param {number} destByteOffset
 * @param {ArrayBufferLike} srcBuf   @param {number} srcByteOffset
 * @param {number} srcByteLength
 * @param {number} elemSize bytes per element
 * @param {ReturnType<typeof planCopy>} plan
 */
export function runCopy(
  destBuf,
  destByteOffset,
  srcBuf,
  srcByteOffset,
  srcByteLength,
  elemSize,
  plan,
) {
  if (!plan || plan.empty) return
  // Pick the widest integer word that divides the element and both offsets.
  let word = Math.min(elemSize, 4)
  while (
    word > 1 &&
    (elemSize % word || destByteOffset % word || srcByteOffset % word)
  )
    word >>= 1
  const f = elemSize / word // words per element
  const View = VIEWS[word]
  const d = new View(
    destBuf,
    destByteOffset,
    ((destBuf.byteLength - destByteOffset) / word) | 0,
  )
  const s = new View(srcBuf, srcByteOffset, (srcByteLength / word) | 0)
  const { doff, soff, lens, dsteps, ssteps } = plan
  const n = lens.length
  if (n === 0) {
    for (let w = 0; w < f; w++) d[doff * f + w] = s[soff * f + w]
    return
  }
  const inner = lens[n - 1]
  const di = dsteps[n - 1] * f
  const si = ssteps[n - 1] * f
  const contiguous = di === f && si === f
  const runWords = inner * f
  const useSet = contiguous && runWords >= 32
  let outer = 1
  for (let i = 0; i < n - 1; i++) outer *= lens[i]
  const idx = n > 1 ? new Array(n - 1).fill(0) : []
  let dpos = doff * f
  let spos = soff * f
  for (let r = 0; r < outer; r++) {
    if (useSet) {
      d.set(s.subarray(spos, spos + runWords), dpos)
    } else if (contiguous) {
      for (let t = 0; t < runWords; t++) d[dpos + t] = s[spos + t]
    } else if (f === 1) {
      for (let t = 0, dp = dpos, sp = spos; t < inner; t++, dp += di, sp += si)
        d[dp] = s[sp]
    } else {
      for (
        let t = 0, dp = dpos, sp = spos;
        t < inner;
        t++, dp += di, sp += si
      ) {
        for (let w = 0; w < f; w++) d[dp + w] = s[sp + w]
      }
    }
    for (let dim = n - 2; dim >= 0; dim--) {
      dpos += dsteps[dim] * f
      spos += ssteps[dim] * f
      if (++idx[dim] < lens[dim]) break
      dpos -= dsteps[dim] * lens[dim] * f
      spos -= ssteps[dim] * lens[dim] * f
      idx[dim] = 0
    }
  }
}
