/**
 * Shared constants for the precomputed gradient volume.
 *
 * Both backends build the same RGBA8 3D texture from the colormapped volume
 * texture: RGB holds a unit normal encoded to [0, 1], alpha holds a
 * log-encoded gradient magnitude. Three features read it -- matcap
 * illumination, gradientOpacity, and silhouettePower -- and all three must
 * look identical on WebGL2 and WebGPU.
 *
 * `gl/gradient.ts` interpolates these into its GLSL; `wgpu/sobel.wgsl`
 * declares them as pipeline-overridable constants and `wgpu/wgpu.ts` supplies
 * them at pipeline creation. Neither backend redefines them locally, so the
 * two encodings cannot drift apart.
 *
 * THE ESTIMATOR IS DEFINED BY WHAT WEBGL2 CAN DO: no compute shaders, so each
 * pass is a fragment shader over one z-slice through an FBO. WebGPU mirrors it
 * rather than doing better -- a "better" gradient on one backend is a rendering
 * difference the user sees when they switch.
 *
 * It is the old niivue's: an 8-corner box blur of the alpha, then an 8-corner
 * Sobel of the blur, both tapping at SOBEL_RADIUS through a LINEAR sampler.
 * Against a sigma=1 Gaussian derivative on mni152 it is as smooth (20.7 vs 22.1
 * degrees neighbour-normal angle) and holds the magnitude median (0.208 vs
 * 0.215), so gradientOpacity kept its tuning. Two apparent shortcuts are not:
 * six ON-AXIS taps get no smoothing at any r <= 1 (the centre cancels and what
 * remains is r times a plain central difference -- 37.3 degrees, the "orange
 * peel"), and a blur AFTER encoding averages unit normals and log magnitudes,
 * biasing the magnitude field gradientOpacity reads.
 */

/**
 * Offset, in voxels, of each corner tap, for both passes. Fractional so the
 * LINEAR sampler makes each tap a trilinear blend; at 0.7 the Sobel's cross
 * kernel is a near-box (.35, .3, .35) and its ramp gain (after the 0.25 in the
 * shader) equals a central difference at the same radius.
 */
export const SOBEL_RADIUS = 0.7

/**
 * The magnitude written to alpha is LOGARITHMIC in the SQUARED gradient, and
 * that is not cosmetic. `gradientOpacity` raises the stored value to the power
 * `gradientOpacity * 8`, and a linear magnitude sits near zero through most of
 * a volume, so any useful slider position drives the whole render to black
 * (measured: mean luminance 29 to under 1 at 0.7). The log spreads "one 8-bit
 * level of contrast" to "full contrast" over [0, 1], which is the range those
 * exponents were tuned against.
 *
 * Each axis is a difference of two averages of [0, 1] samples, so the squared
 * gradient spans [0, 3].
 */
/** Squared gradient of a single 8-bit intensity level: the noise floor. */
export const GRAD_EPS = 1 / 255 ** 2
/** Moves that floor to 0. */
export const GRAD_SHIFT = -Math.log2(GRAD_EPS)
/** Moves full scale (a squared gradient of 3) to 1. */
export const GRAD_SCALE = 1 / (Math.log2(3) + GRAD_SHIFT)

/**
 * Both passes tap the colormapped texture's ALPHA channel.
 *
 * This is a correctness choice, not a coin flip. A colormap LUT's alpha ramp
 * is monotonic in intensity by construction; its colour channels are not. On
 * `hot` (R: 3, 255, 255, 255 over I: 0, 95, 191, 255) red saturates at 37% of
 * the intensity range and is flat above it, so differentiating red returns
 * zero gradient across the top 63% of the data -- no lighting, no silhouette,
 * no gradient opacity, on exactly the voxels that matter. Alpha keeps rising
 * across the whole range for every LUT.
 *
 * WebGPU's sobel.wgsl read `.r` of the colormapped texture until this was
 * fixed, which is why the two backends disagreed by a factor of 2 on `gray`
 * (R ramps to 255, A to 128) and disagreed completely on any coloured colormap.
 */
export const GRADIENT_SOURCE_CHANNEL = 'a'
