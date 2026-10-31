// Bake an extended NiiVue colormap into 2D (HU x gradient magnitude) tables.
//
// A plain cmap ({ min, max, R, G, B, A, I }) works unchanged: A is the alpha.
// Optional extensions (arrays share the I nodes, 0-255 like A):
//   E  alpha where the gradient is high (edges/surfaces); A then applies to
//      shallow gradients (interior). Defaults to A.
//   S  specular strength at surfaces. Defaults to 0 (matte).
//   gradient: { lo, hi }  HU/mm ramp from interior to surface (default 20, 200)
//   gMax      HU/mm at the top table row (default 1000)
//   shininess Blinn-Phong exponent (default 40)
//   labelBlend 0-1: with a segmentation, this table shapes labelled tissue
//      too and the label colour is mixed in by this fraction (0 = the label
//      material table shapes it)
// The gradient axis is sqrt-spaced (row y holds g = (y/63)^2 * gMax), matching tfY().

export const TF_W = 256
export const TF_H = 64

function interpNodes(I, V, fallback) {
  const out = new Float32Array(TF_W)
  if (!V) return out.fill(fallback)
  for (let x = 0; x < TF_W; x++) {
    let k = 0
    while (k < I.length - 2 && x > I[k + 1]) k++
    const span = I[k + 1] - I[k]
    const f = span > 0 ? Math.min(Math.max((x - I[k]) / span, 0), 1) : 0
    out[x] = V[k] + f * (V[k + 1] - V[k])
  }
  return out
}

function smoothstep(e0, e1, x) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1)
  return t * t * (3 - 2 * t)
}

export function bakeTransferFunction(cmap) {
  const I =
    cmap.I ?? cmap.R.map((_, i) => Math.round((i * 255) / (cmap.R.length - 1)))
  const [R, G, B, A] = [cmap.R, cmap.G, cmap.B, cmap.A].map((v) =>
    interpNodes(I, v, 255),
  )
  const E = cmap.E ? interpNodes(I, cmap.E, 0) : A
  const S = interpNodes(I, cmap.S, 0)
  const gLo = cmap.gradient?.lo ?? 20
  const gHi = cmap.gradient?.hi ?? 200
  const gMax = cmap.gMax ?? 1000
  const color = new Uint8Array(TF_W * TF_H * 4)
  const material = new Uint8Array(TF_W * TF_H * 2) // specular, surfaceness
  const maxAlpha = new Uint8Array(TF_W) // max alpha over gradients, per HU
  for (let y = 0; y < TF_H; y++) {
    const g = (y / (TF_H - 1)) ** 2 * gMax
    const surf = smoothstep(gLo, gHi, g)
    for (let x = 0; x < TF_W; x++) {
      const o = (y * TF_W + x) * 4
      const a = A[x] + surf * (E[x] - A[x])
      color.set([R[x], G[x], B[x], a], o)
      material.set([S[x] * surf, surf * 255], (y * TF_W + x) * 2)
      maxAlpha[x] = Math.max(maxAlpha[x], Math.ceil(a))
    }
  }
  return {
    color,
    material,
    maxAlpha,
    huMin: cmap.min,
    huMax: cmap.max,
    gMax,
    shininess: cmap.shininess ?? 40,
    labelBlend: cmap.labelBlend ?? 0,
  }
}
