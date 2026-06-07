/**
 * @niivue/nv-ext-mrs
 *
 * MR spectroscopic imaging (MRSI / CSI) visualization for NiiVue, faithfully
 * reproducing the FSLeyes MRS plugin workflow: overlay a low-resolution MRSI
 * grid on a high-resolution anatomy, move the crosshair to inspect a voxel's
 * spectrum, and integrate a ppm band across all voxels into a metabolite map.
 *
 * The spectral math (halve-first-point, exponential apodization, 0/1-order
 * phase, nucleus constants, ppm referencing, ppm-band integration) lives in
 * NiiVue core (`@niivue/niivue`, `signal/processing.ts`), ported verbatim from
 * fsleyes-plugin-mrs. This package wires that core capability to a scene and
 * adds the range-to-map tool plus FSL-MRS display defaults.
 *
 * See PORTING.md for the function-by-function provenance map and
 * LICENSE.fsleyes-plugin-mrs for the upstream BSD-3 license.
 *
 * Usage:
 * ```ts
 * import NiiVue from '@niivue/niivue'
 * import { MrsScene } from '@niivue/nv-ext-mrs'
 *
 * const nv = new NiiVue()
 * await nv.attachTo('gl1')
 * const scene = new MrsScene(nv)
 * await scene.load({
 *   anatomyUrl: '/signals/mrsi_T1.nii.gz',
 *   mrsiUrl: '/signals/mrsi.nii.gz',
 *   maskUrl: '/signals/mrsi_mask.nii.gz',
 * })
 * // move the crosshair -> the spectrum graph updates automatically
 * scene.setComponent('real')
 * await scene.makeMap([1.9, 2.1]) // NAA map
 * ```
 */

import NiiVue, {
  GYRO_MAG_RATIO,
  getImageDataRAS,
  integratePpmBandMap,
  type MrsVolumeAccess,
  type NVExtensionContext,
  type NVImage,
  type NVSignalDisplay,
  PPM_RANGE,
  PPM_SHIFT,
  type SignalAnnotation,
} from '@niivue/niivue'

export type { MrsVolumeAccess }
// Re-export the core spectral constants/helpers so consumers have a single
// import surface for MRS work.
export { GYRO_MAG_RATIO, integratePpmBandMap, PPM_RANGE, PPM_SHIFT }

/**
 * Default 1H metabolite peak labels (ppm), pinned to the bottom of the plot
 * (`y: -Infinity`) so they pan/zoom with the ppm window and hide when out of
 * range — the same NAA/Cr/Cho assignments used by `examples/svs.html`.
 */
export const PROTON_PEAK_ANNOTATIONS: SignalAnnotation[] = [
  { text: 'NAA', x: 2.0, y: Number.NEGATIVE_INFINITY },
  { text: 'Cr', x: 3.0, y: Number.NEGATIVE_INFINITY },
  { text: 'Cho', x: 3.2, y: Number.NEGATIVE_INFINITY },
]

/**
 * The default ppm display window for a nucleus: `PPM_RANGE[nucleus]` padded by
 * `pad` (fraction) on each side, mirroring the fsleyes MRS view's 10% padding.
 */
export function paddedPpmRange(nucleus: string, pad = 0.1): [number, number] {
  const r = PPM_RANGE[nucleus] ?? PPM_RANGE['1H']
  const lo = Math.min(r[0], r[1])
  const hi = Math.max(r[0], r[1])
  const p = (hi - lo) * pad
  return [lo - p, hi + p]
}

/**
 * FSL-MRS display defaults for a single-voxel crosshair spectrum: real
 * component, halve-first-point on, no transient averaging (one FID per voxel),
 * and the nucleus' padded ppm window.
 */
export function defaultSpectrumDisplay(
  nucleus: string,
): Partial<NVSignalDisplay> {
  return {
    mode: 'real',
    average: false,
    halveFirstPoint: true,
    ppmRange: paddedPpmRange(nucleus),
  }
}

/** Options for {@link makeMetaboliteMap}. */
export interface MetaboliteMapOptions {
  /** ppm band [lo, hi] to integrate */
  band: [number, number]
  /** integrate `|spectrum|` ('magnitude', default) or `real(spectrum)` */
  mode?: 'magnitude' | 'real'
  apodizeHz?: number
  /** 0th-order phase, degrees */
  phase0?: number
  /** 1st-order phase, milliseconds */
  phase1Ms?: number
  /** halve first FID point (default: true, FSL-MRS convention) */
  halveFirstPoint?: boolean
  /** overlay name; defaults to `SpecSum_{lo}_{hi}` (fsleyes range_tool naming) */
  name?: string
}

/**
 * Build a metabolite map overlay by integrating a ppm band across every voxel
 * of an MRSI volume — the port of fsleyes-plugin-mrs `range_tool.draw_overlay`.
 * Returns a derived scalar NVImage sharing the MRSI grid/affine; add it with
 * `nv.addVolume(map)` (or `MrsScene.makeMap`, which also styles it).
 */
export function makeMetaboliteMap(
  mrs: MrsVolumeAccess,
  opts: MetaboliteMapOptions,
): NVImage {
  const { dimX, dimY, dimZ } = mrs.dims
  const nVox3D = dimX * dimY * dimZ
  const m = mrs.meta
  const data = integratePpmBandMap(
    mrs.complexData,
    nVox3D,
    m.nPoints,
    m.nTransients,
    m.dwell,
    m.spectrometerFreq,
    m.nucleus,
    opts.band,
    {
      mode: opts.mode ?? 'magnitude',
      apodizeHz: opts.apodizeHz,
      phase0: opts.phase0,
      phase1Ms: opts.phase1Ms,
      halveFirstPoint: opts.halveFirstPoint ?? true,
    },
  )
  const lo = Math.min(opts.band[0], opts.band[1]).toFixed(1)
  const hi = Math.max(opts.band[0], opts.band[1]).toFixed(1)
  const name = opts.name ?? `SpecSum_${lo}_${hi}`
  return mrs.makeScalarOverlay(data, name)
}

/** Options for {@link MrsScene.load}. */
export interface MrsSceneOptions {
  /** anatomy (e.g. T1) loaded as the background volume; optional */
  anatomyUrl?: string | File
  /** the complex MRSI/CSI NIfTI, loaded as an overlay */
  mrsiUrl: string | File
  /** binary mask restricting the MRSI overlay to in-mask voxels; optional */
  maskUrl?: string | File
  /** colormap for the MRSI grid overlay (default 'warm') */
  mrsiColormap?: string
  /** opacity for the MRSI grid overlay (default 0.7) */
  mrsiOpacity?: number
  /**
   * Peak labels for the spectrum graph (ppm x, `y: -Infinity` pins to the plot
   * bottom). Defaults to {@link PROTON_PEAK_ANNOTATIONS} for a 1H nucleus.
   */
  annotations?: SignalAnnotation[]
  /** snap the crosshair to the MRSI voxel grid (default true). */
  snapToVoxel?: boolean
  /** restrict the MRSI overlay to in-mask voxels at load (default true). */
  mask?: boolean
}

/** Options for {@link MrsScene.makeMap}. */
export interface MakeMapOptions extends Omit<MetaboliteMapOptions, 'band'> {
  colormap?: string
  opacity?: number
}

/**
 * A small controller that wires an MRSI dataset into a NiiVue instance:
 * loads anatomy + MRSI grid (+ optional mask), shows the derived total-signal
 * map, and registers a crosshair-following spectrum on the graph. UI lives in
 * the demo; this object exposes the high-level operations the UI drives.
 */
export class MrsScene {
  readonly nv: NiiVue
  private ctx: NVExtensionContext
  /** id of the loaded MRSI volume, set after {@link load} */
  mrsiId: string | null = null
  /** mask values in RAS voxel order (cached at load) */
  private maskRAS: Float32Array | null = null
  /** the unmasked derived map (native voxel order) so the mask can be toggled */
  private unmaskedMap: Float32Array | null = null
  private snapEnabled = false
  private snapping = false
  private snapListener: ((e: CustomEvent<{ mm?: number[] }>) => void) | null =
    null

  constructor(nv: NiiVue) {
    this.nv = nv
    this.ctx = nv.createExtensionContext()
  }

  /** Live read-only access to THIS scene's MRSI volume's FID + metadata. */
  get mrs(): MrsVolumeAccess | null {
    return this.mrsiId ? this.ctx.mrsById(this.mrsiId) : this.ctx.mrs
  }

  /** The loaded MRSI NVImage, or undefined. */
  private mrsiVol(): NVImage | undefined {
    return this.nv.volumes.find((v) => v.id === this.mrsiId)
  }

  /** True when two volumes share the same RAS voxel grid (dims match). */
  private sameGrid(a: NVImage, b: NVImage | undefined): boolean {
    const da = a.dimsRAS
    const db = b?.dimsRAS
    if (!da || !db) return false
    return da[1] === db[1] && da[2] === db[2] && da[3] === db[3]
  }

  /**
   * Load the scene: anatomy (background), MRSI grid (overlay shown as the
   * derived total-signal map), optional mask, and a crosshair-following
   * spectrum. After this resolves, moving the crosshair updates the spectrum.
   */
  async load(opts: MrsSceneOptions): Promise<void> {
    if (opts.anatomyUrl) {
      // Suppress the anatomy colorbar: only the MRSI overlay's intensity scale
      // is meaningful, so it owns the (toggleable) colorbar.
      await this.nv.loadVolumes([
        { url: opts.anatomyUrl, isColorbarVisible: false },
      ])
    }
    await this.nv.addVolume({
      url: opts.mrsiUrl,
      colormap: opts.mrsiColormap ?? 'warm',
      opacity: opts.mrsiOpacity ?? 0.7,
      isColorbarVisible: true,
    })
    const mrs = this.ctx.mrs
    if (!mrs) {
      throw new Error(
        'MrsScene.load: the loaded MRSI volume is not complex/spectroscopic',
      )
    }
    this.mrsiId = mrs.id
    // Restrict the MRSI overlay to in-mask (brain) voxels. The grid is a
    // colormapped scalar overlay, and NiiVue's volume modulation only affects
    // RGB/RGBA volumes (it is a no-op for scalar overlays — the colormap runs
    // on the GPU), so we bake the mask into the scalar data instead: out-of-mask
    // voxels become a below-threshold sentinel and are drawn transparent. The
    // mask is loaded only to read its data (kept hidden at opacity 0).
    if (opts.maskUrl) {
      try {
        await this.nv.addVolume({
          url: opts.maskUrl,
          opacity: 0,
          isColorbarVisible: false,
        })
        const maskVol = this.nv.volumes[this.nv.volumes.length - 1]
        // Validate the mask shares the MRSI grid before baking — otherwise the
        // RAS-index mapping in setMaskEnabled would corrupt the overlay.
        const mrsiVol = this.mrsiVol()
        if (maskVol && this.sameGrid(maskVol, mrsiVol)) {
          const ras = getImageDataRAS(maskVol)
          this.maskRAS = ras ? Float32Array.from(ras) : null
        } else {
          console.warn(
            'MrsScene: mask grid does not match the MRSI grid; mask ignored',
          )
        }
      } catch (err) {
        // Mask is a nicety; a failure should not break navigation.
        console.warn('MrsScene: mask load failed', err)
      }
    }
    const annotations =
      opts.annotations ??
      (mrs.meta.nucleus === '1H' ? PROTON_PEAK_ANNOTATIONS : undefined)
    this.nv.addMrsiSignal(this.mrsiId, {
      name: 'MRSI spectrum',
      display: defaultSpectrumDisplay(mrs.meta.nucleus),
      annotations,
    })
    // Snap the crosshair onto the MRSI slab so the default view shows the grid
    // overlay AND a populated spectrum. The MRSI is typically a thin single
    // slice, which an arbitrary anatomy slice/crosshair will miss (the spectrum
    // would read the placeholder FID -> a flat line). Center on the
    // peak-signal voxel of the derived map (mirrors svs.html's setCrosshairPos).
    this.centerOnMrsiPeak()
    // Marker: snap the crosshair to the sampled MRSI voxel centre so the cursor
    // sits in the middle of the coarse grid cell being read (default on).
    this.enableVoxelSnap(opts.snapToVoxel ?? true)
    // Cache the unmasked map, then apply the brain mask by default.
    const mrsiVol = this.mrsiVol()
    if (mrsiVol?.img) this.unmaskedMap = Float32Array.from(mrsiVol.img)
    this.setMaskEnabled(opts.mask ?? true)
  }

  /**
   * Toggle the mask restricting the MRSI overlay to in-mask (brain) voxels.
   * Bakes the mask into the scalar overlay (out-of-mask voxels become a
   * below-threshold sentinel, drawn transparent). No-op if no mask was loaded.
   *
   * Volume modulation (`setModulationImage`) only affects RGB/RGBA volumes — it
   * is a no-op for a colormapped scalar overlay (the colormap runs on the GPU),
   * so we edit the scalar data directly. The new data is written to a FRESH
   * Float32Array: both renderers cache the overlay texture keyed on
   * `img.buffer` identity, so reusing the same buffer would not re-upload —
   * swapping the buffer invalidates the cache. Mapping is done in RAS order via
   * the overlay's native index map, so it is correct regardless of orientation.
   */
  setMaskEnabled(on: boolean): void {
    const vol = this.mrsiVol()
    const base = this.unmaskedMap
    if (!vol?.img || !base) return
    const out = new Float32Array(base) // fresh buffer -> cache invalidates
    const d = vol.dimsRAS
    if (
      on &&
      this.maskRAS &&
      d &&
      vol.img2RASstart &&
      vol.img2RASstep &&
      // mask must cover exactly the MRSI RAS grid (guards a mismatched mask)
      this.maskRAS.length === d[1] * d[2] * d[3]
    ) {
      const start = vol.img2RASstart
      const step = vol.img2RASstep
      const mask = this.maskRAS
      const SENTINEL = -1e20 // always below any (>=0) display threshold
      let rasIdx = 0
      for (let rz = 0; rz < d[3]; rz++) {
        for (let ry = 0; ry < d[2]; ry++) {
          for (let rx = 0; rx < d[1]; rx++) {
            const nativeIdx =
              start[0] +
              rx * step[0] +
              start[1] +
              ry * step[1] +
              start[2] +
              rz * step[2]
            if (!(mask[rasIdx] > 0.5)) out[nativeIdx] = SENTINEL
            rasIdx++
          }
        }
      }
    }
    vol.img = out
    void this.nv.updateGLVolume()
  }

  /**
   * Enable/disable crosshair snapping to the MRSI voxel grid. When on, moving
   * the crosshair over the slab quantizes it to the centre of the containing
   * spectroscopy voxel — a low-cost "voxel marker" that, with the coloured grid
   * overlay, shows exactly which coarse cell is being sampled. Outside the grid
   * the crosshair stays free (for precise anatomy navigation).
   */
  enableVoxelSnap(on: boolean): void {
    this.snapEnabled = on
    if (on && !this.snapListener) {
      this.snapListener = (e) => this.snapCrosshairToVoxel(e)
      this.ctx.on('locationChange', this.snapListener)
    } else if (!on && this.snapListener) {
      // Detach when disabled rather than gating in the handler — no retained
      // listener doing per-move work.
      this.ctx.off('locationChange', this.snapListener)
      this.snapListener = null
    }
  }

  private snapCrosshairToVoxel(e: CustomEvent<{ mm?: number[] }>): void {
    if (!this.snapEnabled || this.snapping) return
    const mm = e.detail?.mm
    const mrs = this.mrs
    if (!mm || mm.length < 3 || !mrs) return
    const cur: [number, number, number] = [mm[0], mm[1], mm[2]]
    const center = mrs.voxelCenterMm(cur)
    if (!center) return // crosshair is off the MRSI grid; leave it free
    const d = Math.hypot(
      center[0] - cur[0],
      center[1] - cur[1],
      center[2] - cur[2],
    )
    if (d < 1e-3) return // already centred; avoids a re-entrant snap loop
    // Guard re-entrancy: setCrosshairPos re-emits locationChange.
    this.snapping = true
    try {
      this.nv.setCrosshairPos(center)
    } finally {
      this.snapping = false
    }
  }

  /**
   * Move the crosshair to the MRSI voxel with the largest derived-map signal,
   * so the slab is on the displayed slice and the spectrum is non-trivial.
   */
  private centerOnMrsiPeak(): void {
    const vol = this.mrsiVol()
    if (!vol?.img || !vol.frac2mm) return
    const nx = vol.dims[1]
    const ny = vol.dims[2]
    const nz = vol.dims[3]
    const img = vol.img
    let best = 0
    let bestV = Number.NEGATIVE_INFINITY
    for (let i = 0; i < img.length; i++) {
      if (img[i] > bestV) {
        bestV = img[i]
        best = i
      }
    }
    const x = best % nx
    const y = Math.floor(best / nx) % ny
    const z = Math.floor(best / (nx * ny))
    // Native texture fraction (voxel centers) -> mm via frac2mm (column-major).
    const fx = (x + 0.5) / nx
    const fy = (y + 0.5) / ny
    const fz = (z + 0.5) / nz
    const m = vol.frac2mm
    const mm: [number, number, number] = [
      m[0] * fx + m[4] * fy + m[8] * fz + m[12],
      m[1] * fx + m[5] * fy + m[9] * fz + m[13],
      m[2] * fx + m[6] * fy + m[10] * fz + m[14],
    ]
    this.nv.setCrosshairPos(mm)
  }

  /** Index of the crosshair-following spectrum signal, or -1. */
  private signalIndex(): number {
    return this.nv.signals.findIndex((s) => s.followsCrosshair)
  }

  private updateDisplay(display: Partial<NVSignalDisplay>): void {
    const i = this.signalIndex()
    if (i >= 0) this.nv.setSignal(i, { display })
  }

  /** Index of the MRSI overlay volume, or -1. */
  private mrsiIndex(): number {
    return this.nv.volumes.findIndex((v) => v.id === this.mrsiId)
  }

  /**
   * Set the MRSI grid overlay's colormap. The default `warm` matches FSLeyes;
   * the perceptually-uniform, colorblind-safe options `cividis`, `viridis`,
   * `magma`, and `lipari` ship with NiiVue.
   */
  setColormap(name: string): void {
    const idx = this.mrsiIndex()
    if (idx >= 0) this.nv.setVolume(idx, { colormap: name })
  }

  /**
   * Show/hide the colorbar. The MRSI overlay owns the only meaningful scale
   * (total signal: the ppm-band integral of |spectrum|, arbitrary units), so
   * the anatomy/mask colorbars are suppressed and this toggles the MRSI one.
   */
  showColorbar(visible: boolean): void {
    this.nv.isColorbarVisible = visible
  }

  /**
   * The MRSI overlay's intensity range, for driving a threshold UI.
   * `globalMin`/`globalMax` are the full data extent; `calMin`/`calMax` are the
   * current display window.
   */
  get mrsiCal(): {
    globalMin: number
    globalMax: number
    calMin: number
    calMax: number
  } | null {
    const v = this.mrsiVol()
    if (!v) return null
    return {
      globalMin: v.globalMin,
      globalMax: v.globalMax,
      calMin: v.calMin,
      calMax: v.calMax,
    }
  }

  /**
   * Set the MRSI overlay's lower display threshold (calMin). Because the overlay
   * uses MIN_TO_MAX with transparent-below-calMin, raising this hides
   * low-signal voxels (e.g. residual signal outside the head).
   */
  setThreshold(calMin: number): void {
    const idx = this.mrsiIndex()
    if (idx >= 0) {
      this.nv.setVolume(idx, { calMin, isTransparentBelowCalMin: true })
    }
  }

  /** Set the displayed spectral component. */
  setComponent(mode: NVSignalDisplay['mode']): void {
    this.updateDisplay({ mode })
  }

  /** Set exponential apodization (line-broadening) in Hz (0 = none). */
  setApodization(hz: number): void {
    this.updateDisplay({ apodizeHz: hz })
  }

  /** Set 0th-order (degrees) and 1st-order (milliseconds) phase correction. */
  setPhase(phase0Deg: number, phase1Ms: number): void {
    this.updateDisplay({ phase0: phase0Deg, phase1Ms })
  }

  /** Set the ppm display window [lo, hi]. */
  setPpmWindow(range: [number, number]): void {
    this.updateDisplay({ ppmRange: range })
  }

  /**
   * Integrate a ppm band into a metabolite map overlay and add it to the scene.
   * Mirrors the spectrum's current processing defaults (halve-first-point on).
   * Returns the added NVImage.
   */
  async makeMap(
    band: [number, number],
    opts: MakeMapOptions = {},
  ): Promise<NVImage> {
    const mrs = this.mrs
    if (!mrs) throw new Error('MrsScene.makeMap: no MRSI volume loaded')
    // Uniquify the overlay id so repeating a band doesn't collide with an
    // earlier map (addVolume does not dedupe ids, and find-by-id would then
    // style the OLD map). Suffix " (n)" until the id is free.
    const lo = Math.min(band[0], band[1]).toFixed(1)
    const hi = Math.max(band[0], band[1]).toFixed(1)
    let name = opts.name ?? `SpecSum_${lo}_${hi}`
    if (this.nv.volumes.some((v) => v.id === name)) {
      let n = 2
      while (this.nv.volumes.some((v) => v.id === `${name} (${n})`)) n++
      name = `${name} (${n})`
    }
    const map = makeMetaboliteMap(mrs, {
      band,
      mode: opts.mode,
      apodizeHz: opts.apodizeHz,
      phase0: opts.phase0,
      phase1Ms: opts.phase1Ms,
      halveFirstPoint: opts.halveFirstPoint,
      name,
    })
    await this.nv.addVolume(map)
    const idx = this.nv.volumes.findIndex((v) => v.id === map.id)
    if (idx >= 0) {
      await this.nv.setVolume(idx, {
        colormap: opts.colormap ?? 'redyell',
        opacity: opts.opacity ?? 0.8,
        colormapType: 1, // zero-to-max, transparent below calMin
      })
    }
    return map
  }

  /** Release the extension context's subscriptions. */
  dispose(): void {
    this.ctx.dispose()
  }
}
