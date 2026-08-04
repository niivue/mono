// Microscopy hub — every microscopy source the volumetric server exposes,
// in one page.
//
// The server registers ONE entry per channel of a multi-channel source, all
// sharing a `dataset` key (see registry.ts). That keeps the server's volume
// handles 3D/single-channel, and lets this page rebuild a dataset by grouping
// on `dataset` — string-munging the ids would not work, because a channel name
// may itself contain the separator.
//
// Sources too large to load whole (the FIB-SEM OME-Zarr, the WSI slide) are
// listed with a link to the page that streams them, so this page is still the
// index of the microscopy demos rather than a subset of them.

import NiiVue, {
  type TypedVoxelArray,
  VOLUME_RENDER_MODE,
} from '@niivue/niivue'
import { getBackendFromUrl } from './backend'
import { installNav } from './nav'

installNav()

const BACKEND = getBackendFromUrl()

// 16 is the tagged-structure count of an Allen IMSC dataset, and the reference
// viewer at imsc.allencell.org shows all of them at once — so the cap is set to
// display a whole dataset, not a sample of it. It is a cost ceiling, not a
// legibility one: niivue blends stacked overlays additively (premultiplied
// color, max alpha), which is the right merge for sparse fluorescence channels
// and stays readable well past a handful. What does scale with channel count is
// one fetch and one oriented RGBA volume each. WebGPU combines them in a compute
// pass; WebGL2 still reads each one back and blends on the CPU, so a full
// 16-channel stack is noticeably slower there.
const MAX_CHANNELS = 16
const DEFAULT_CHANNELS = 2

/**
 * How much of a raw channel survives the window, as a fraction of its voxels.
 *
 * Windowing a fluorescence channel floor-to-peak keeps everything above the
 * background floor, and in this data that is the entire cell body: a broad, dim
 * cytoplasmic haze that carries no structure. One channel of it is a faint fog;
 * sixteen summed is a solid opaque brick with only its outer surface visible.
 * The reference viewer's cell is airy because it shows only the bright tagged
 * structure, so cut at a percentile instead — keep the top few percent as
 * signal, and let the saturation point sit just below the very brightest
 * voxels so the structure reaches full colour rather than staying dim.
 */
const RAW_SIGNAL_FRACTION = 0.015
const RAW_SATURATION_FRACTION = 0.001

// A segmentation mask is a filled solid where a fluorescence channel is sparse,
// so the same overlay opacity that reads well for `_raw` buries everything
// under `_seg`. Fade masks further than raw channels.
const SEG_OPACITY_SCALE = 0.5

// Whole-volume load budget. Bigger sources belong on the streaming pages, which
// fetch a level/region at a time instead of the entire array.
const MAX_WHOLE_VOLUME_VOXELS = 64_000_000

// Distinct hues so stacked channels stay separable, one per channel of a full
// 16-structure Allen dataset before the list repeats. Ordered so the common
// two- and three-channel picks land on the most separable pairs first.
const CHANNEL_COLORMAPS = [
  'green',
  'red',
  'blue',
  'violet',
  'gold',
  'electric_blue',
  'warm',
  'cool',
  'gray',
  'bluegrn',
  'copper',
  'green2cyan',
  'winter',
  'blue2magenta',
  'redyell',
  'bronze',
]

/**
 * The Allen IMSC reference viewer's own palette and structure names, sampled
 * from its legend at imsc.allencell.org.
 *
 * Two things make that viewer legible with all 16 structures on at once, and
 * both are copied here. Each structure gets ONE flat hue, so a structure reads
 * as a colour rather than as a gradient — the stock niivue ramps that sweep hue
 * with intensity (`warm`, `bronze`, `redyell`) actively fight that. And the
 * gene symbol is shown next to what it labels, since `SEC61B` means nothing
 * without "endoplasmic reticulum" beside it.
 *
 * Keyed by gene symbol, which is the leading token of the channel name
 * (`TUBA1B_71126_raw` -> `TUBA1B`).
 */
const ALLEN_STRUCTURES: Record<
  string,
  { label: string; rgb: [number, number, number] }
> = {
  DNA: { label: 'DNA', rgb: [174, 174, 174] },
  FBL: { label: 'nucleolus (DF)', rgb: [0, 153, 255] },
  LMNB1: { label: 'nuclear envelope', rgb: [51, 255, 255] },
  SEC61B: { label: 'endoplasmic reticulum', rgb: [83, 126, 255] },
  ST6GAL1: { label: 'Golgi', rgb: [97, 217, 0] },
  CENT2: { label: 'centrosome', rgb: [240, 124, 76] },
  LAMP1: { label: 'lysosome', rgb: [255, 195, 92] },
  TUBA1B: { label: 'microtubules', rgb: [255, 153, 0] },
  TOMM20: { label: 'mitochondria', rgb: [255, 77, 77] },
  ACTB: { label: 'actin filaments', rgb: [255, 238, 30] },
  ACTN1: { label: 'actin bundles', rgb: [187, 205, 34] },
  MYH10: { label: 'actomyosin bundles', rgb: [255, 102, 51] },
  CTNNB1: { label: 'adherens junctions', rgb: [253, 146, 182] },
  DSP: { label: 'desmosomes', rgb: [240, 72, 110] },
  GJA1: { label: 'gap junction', rgb: [194, 108, 255] },
  TJP1: { label: 'tight junctions', rgb: [253, 97, 214] },
}

// The registry reports spacing in the source's own units and does not carry a
// unit field, so the unit is per format: the Allen sidecar is microns, NIfTI is
// millimetres by definition, OME-Zarr axes are usually metres.
const SPACING_UNIT: Record<string, string> = {
  'allen-atlas': 'um',
  nifti: 'mm',
  'ome-zarr': 'm',
}

// Where a source that can't be loaded whole is actually viewable.
const STREAMING_PAGES: Record<string, { href: string; label: string }> = {
  'ome-zarr': { href: '/omezarr.html', label: 'omezarr' },
  'dicom-wsi': { href: '/wsi.html', label: 'wsi' },
}

type Shape3 = [number, number, number]

interface ApiVolume {
  id: string
  format: string
  shape: Shape3
  dtype: string
  spacing: Shape3
  channel: number | null
  channelName: string | null
  dataset: string
  levels?: unknown[]
}

interface Dataset {
  key: string
  format: string
  shape: Shape3
  spacing: Shape3
  channels: ApiVolume[]
}

// Which family of channels the sidebar lists.
type Family = 'all' | 'raw' | 'seg'

// Allen ships each tagged structure twice: the raw fluorescence image and the
// segmentation derived from it, distinguished only by a `_raw` / `_seg` suffix
// on the channel name. Nothing in the volume metadata separates them (both are
// uint8 at the same shape), so the suffix is the only signal available — and
// the two need opposite display treatment, since a mask has no internal
// texture to window against.
function isSegChannel(entry: ApiVolume): boolean {
  return /_seg$/i.test(entry.channelName ?? '')
}

function matchesFamily(entry: ApiVolume, family: Family): boolean {
  if (family === 'all') return true
  return isSegChannel(entry) === (family === 'seg')
}

// `TUBA1B_71126_raw` -> `TUBA1B`. The middle token is the cell line and varies
// between datasets, so only the leading symbol is stable enough to key on.
// Returns null for anything that isn't an Allen channel.
function allenGene(entry: ApiVolume): string | null {
  const gene = (entry.channelName ?? '').split('_')[0]?.toUpperCase()
  return gene && gene in ALLEN_STRUCTURES ? gene : null
}

// Already capitalized, so niivue's canonicalization (upper-case first letter)
// leaves it alone and the name the select stores is the name the LUT index has.
function allenColormapName(gene: string): string {
  return `Allen_${gene}`
}

/**
 * Register one flat-hue colormap per Allen structure.
 *
 * Colour is constant across the ramp and *alpha* carries the intensity, which
 * is the transfer function the reference viewer uses: a structure is always its
 * own hue, and density shows as how much of that hue accumulates along the ray.
 * Ramping colour instead (black to hue, as most niivue maps do) makes faint
 * voxels grey, and grey from 16 channels sums to a white fog.
 *
 * The alpha stops are deliberately convex — 0, 24, 255 over an even index
 * spread — so the broad low-intensity halo just above the background floor
 * stays nearly transparent while the structure itself comes through. A linear
 * alpha ramp lets that halo dominate, because there is far more of it.
 */
function registerAllenColormaps(v: NiiVue): void {
  for (const [gene, s] of Object.entries(ALLEN_STRUCTURES)) {
    const [r, g, b] = s.rgb
    v.addColormap(allenColormapName(gene), {
      R: [r, r, r],
      G: [g, g, g],
      B: [b, b, b],
      A: [0, 24, 255],
      I: [0, 128, 255],
    })
  }
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  dataset: el<HTMLSelectElement>('dataset'),
  layout: el<HTMLSelectElement>('layout'),
  opacity: el<HTMLInputElement>('opacity'),
  hollow: el<HTMLInputElement>('hollow'),
  shading: el<HTMLInputElement>('shading'),
  maxProject: el<HTMLInputElement>('maxproject'),
  alpha2d: el<HTMLInputElement>('alpha2d'),
  load: el<HTMLButtonElement>('load'),
  clear: el<HTMLButtonElement>('clear'),
  turntable: el<HTMLButtonElement>('turntable'),
  reset: el<HTMLButtonElement>('reset'),
  status: el<HTMLSpanElement>('status'),
  channels: el<HTMLDivElement>('channels'),
  channelNote: el<HTMLParagraphElement>('channel-note'),
  family: el<HTMLSelectElement>('family'),
  pickAll: el<HTMLButtonElement>('pick-all'),
  pickNone: el<HTMLButtonElement>('pick-none'),
  streaming: el<HTMLDivElement>('streaming'),
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  hud: el<HTMLDivElement>('hud'),
  fallback: el<HTMLDivElement>('fallback'),
}

let nv: NiiVue | null = null
let datasets: Dataset[] = []
let current: Dataset | null = null
// Bumped per load so a superseded load (rapid dataset switching) drops its
// result instead of windowing the volumes of the newer one.
let loadToken = 0
let loaded: ApiVolume[] = []
// Per-channel display window, keyed by registry id. See computeWindows().
const windows = new Map<string, { calMin: number; calMax: number }>()
// Set once the user drags the opacity slider, after which the channel-count
// default stops overriding their choice.
let opacityTouched = false
// The camera the reset button returns to, captured before anything moves it.
let home: { azimuth: number; elevation: number } | null = null
let spinFrame = 0

function showFallback(msg: string): void {
  els.fallback.textContent = msg
  els.fallback.style.display = 'flex'
}

function voxels(shape: Shape3): number {
  return shape[0] * shape[1] * shape[2]
}

function unitFor(format: string): string {
  return SPACING_UNIT[format] ?? 'units'
}

function formatSpacing(d: Dataset): string {
  return `${d.spacing.map((s) => s.toPrecision(3)).join(' x ')} ${unitFor(d.format)}/voxel`
}

// One dataset per `dataset` key, channels in channel order.
function groupDatasets(volumes: ApiVolume[]): Dataset[] {
  const byKey = new Map<string, ApiVolume[]>()
  for (const v of volumes) {
    const list = byKey.get(v.dataset)
    if (list) list.push(v)
    else byKey.set(v.dataset, [v])
  }
  const out: Dataset[] = []
  for (const [key, entries] of byKey) {
    entries.sort((a, b) => (a.channel ?? 0) - (b.channel ?? 0))
    const first = entries[0]
    out.push({
      key,
      format: first.format,
      shape: first.shape,
      spacing: first.spacing,
      channels: entries,
    })
  }
  out.sort((a, b) => a.key.localeCompare(b.key))
  return out
}

// A multi-channel source is microscopy by construction here; a single-channel
// one qualifies only if it is small enough to fetch whole.
function isLoadableHere(d: Dataset): boolean {
  if (d.format === 'nifti') return false
  if (d.channels.length > 1) return true
  return voxels(d.shape) <= MAX_WHOLE_VOLUME_VOXELS
}

function channelBoxes(): HTMLInputElement[] {
  return [...els.channels.querySelectorAll<HTMLInputElement>('input')]
}

function selectedBoxes(): HTMLInputElement[] {
  return channelBoxes().filter((b) => b.checked)
}

// At the cap, block further selection rather than silently ignoring the extras
// at load time.
function refreshChannelLimit(): void {
  const n = selectedBoxes().length
  const atCap = n >= MAX_CHANNELS
  for (const box of channelBoxes()) {
    box.disabled = atCap && !box.checked
    box.parentElement?.classList.toggle('disabled', box.disabled)
  }
  els.channelNote.textContent = atCap
    ? `${n} of max ${MAX_CHANNELS} channels selected`
    : `${n} selected (max ${MAX_CHANNELS})`
}

// "all" fills up to the cap in list order, and the list is whatever the family
// filter is showing — so on a 32-entry Allen source it selects one whole
// 16-structure family rather than the first 16 ids of the two interleaved.
function setAllChannels(checked: boolean): void {
  channelBoxes().forEach((box, index) => {
    box.checked = checked && index < MAX_CHANNELS
  })
  refreshChannelLimit()
}

function visibleChannels(d: Dataset, family: Family): ApiVolume[] {
  return d.channels.filter((entry) => matchesFamily(entry, family))
}

function buildChannelList(
  d: Dataset,
  family: Family,
  checkedIds: Set<string>,
): void {
  els.channels.replaceChildren()
  // Colormaps are assigned per family, not per row, so a structure keeps its
  // hue whichever family is listed and both families get the full distinct set
  // instead of the second one wrapping around to repeats.
  const familyIndex = new Map<string, number>()
  let nRaw = 0
  let nSeg = 0
  for (const entry of d.channels) {
    const seg = isSegChannel(entry)
    familyIndex.set(entry.id, seg ? nSeg++ : nRaw++)
  }
  for (const entry of visibleChannels(d, family)) {
    const gene = allenGene(entry)
    const structure = gene ? ALLEN_STRUCTURES[gene] : null
    const row = document.createElement('label')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.value = entry.id
    box.checked = checkedIds.has(entry.id)
    box.addEventListener('change', refreshChannelLimit)
    const name = document.createElement('span')
    name.className = 'name'
    // Gene symbol plus what it labels, as the reference viewer lists it. The
    // full registry id stays on the tooltip so the `_raw` / `_seg` suffix and
    // the cell line are still reachable.
    name.textContent = structure
      ? `${gene} · ${structure.label}`
      : (entry.channelName ?? entry.id)
    name.title = entry.id
    const cmap = document.createElement('select')
    cmap.dataset.for = entry.id
    if (structure) {
      const opt = document.createElement('option')
      opt.value = allenColormapName(gene ?? '')
      opt.textContent = 'allen'
      cmap.appendChild(opt)
    }
    for (const c of CHANNEL_COLORMAPS) {
      const opt = document.createElement('option')
      opt.value = c
      opt.textContent = c
      cmap.appendChild(opt)
    }
    const swatch = document.createElement('span')
    swatch.className = 'swatch'
    if (structure) {
      cmap.value = allenColormapName(gene ?? '')
      swatch.style.background = `rgb(${structure.rgb.join(',')})`
    } else {
      const hue = familyIndex.get(entry.id) ?? 0
      cmap.value = CHANNEL_COLORMAPS[hue % CHANNEL_COLORMAPS.length]
      swatch.style.visibility = 'hidden'
    }
    cmap.addEventListener('change', () => {
      applyColormap(entry.id, cmap.value)
    })
    // Once the row is titled by structure rather than by channel name, the raw
    // and seg entries for a structure read identically. Tag the seg one; the
    // untagged row is the image, which is the one to reach for by default.
    const tag = document.createElement('span')
    tag.className = 'tag'
    if (structure && isSegChannel(entry)) tag.textContent = 'seg'
    row.append(box, swatch, name, tag, cmap)
    els.channels.appendChild(row)
  }
  refreshChannelLimit()
}

function colormapFor(id: string): string {
  const sel = els.channels.querySelector<HTMLSelectElement>(
    `select[data-for="${CSS.escape(id)}"]`,
  )
  return sel?.value ?? 'gray'
}

function applyColormap(id: string, colormap: string): void {
  const index = loaded.findIndex((e) => e.id === id)
  if (!nv || index < 0) return
  nv.setVolume(index, { colormap })
  renderHud()
}

/**
 * Replace a label mask with its surface shell, in place.
 *
 * A mask is a filled solid, and a filled solid is opaque along any ray that
 * crosses it — so in the 3D render the largest structure (the nucleus of
 * `DNA_seg`) hides everything inside it no matter how far its alpha is turned
 * down. Alpha only controls how fast a ray saturates, not whether it does.
 *
 * Keeping only the labelled voxels that touch an unlabelled 6-neighbour turns
 * each mask into an outline in the 2D slices and a hollow shell in the 3D
 * render, which is what makes a whole segmentation stack legible at once.
 *
 * `floor` is the background level (`globalMin`), which the interior is reset to
 * rather than to zero: the display windows above the floor, so the emptied
 * interior has to land on it to read as background. `globalMin` / `globalMax`
 * are unchanged by this, since the shell keeps both extremes.
 *
 * Returns a NEW array rather than editing in place. Both backends cache the
 * uploaded source texture against `img.buffer` identity
 * (`prepareOrientTextureCache`), so an in-place edit is invisible to the GPU —
 * the cache reuses the texture it already has and nothing on screen changes.
 */
function hollowMask(
  img: TypedVoxelArray,
  dims: [number, number, number],
  floor: number,
): TypedVoxelArray {
  const [nx, ny, nz] = dims
  const rowStride = nx
  const sliceStride = nx * ny
  const src = img
  const out = img.slice()
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = x + y * rowStride + z * sliceStride
        if (src[i] <= floor) continue
        // A voxel on a volume face has no neighbour beyond it. Treat the
        // outside as unlabelled so a structure clipped by the field of view
        // still closes instead of opening into a hole.
        const interior =
          x > 0 &&
          x < nx - 1 &&
          y > 0 &&
          y < ny - 1 &&
          z > 0 &&
          z < nz - 1 &&
          src[i - 1] > floor &&
          src[i + 1] > floor &&
          src[i - rowStride] > floor &&
          src[i + rowStride] > floor &&
          src[i - sliceStride] > floor &&
          src[i + sliceStride] > floor
        if (interior) out[i] = floor
      }
    }
  }
  return out
}

// Swap every loaded segmentation for its shell, then re-upload. Destructive to
// the loaded copy, so the toggle re-runs the load (served from the HTTP cache)
// rather than trying to undo it.
async function hollowLoadedMasks(): Promise<void> {
  if (!nv) return
  let changed = false
  nv.volumes.forEach((volume, index) => {
    const entry = loaded[index]
    if (!entry || !isSegChannel(entry) || !volume.img) return
    const dims = volume.dims
    volume.img = hollowMask(
      volume.img,
      [dims[1], dims[2], dims[3]],
      Math.floor(volume.globalMin),
    )
    changed = true
  })
  if (changed) await nv.updateGLVolume()
}

/**
 * Opacity for a loaded channel at its stack position.
 *
 * Volume 0 is niivue's base layer and is normally drawn opaque, which is right
 * for a raw fluorescence channel. It is wrong for a mask: a segmentation is a
 * filled solid, so an opaque one hides every channel stacked on it — that is
 * what made a seg-only selection render as a single flat blob, with the whole
 * nucleus of `DNA_seg` swallowing the structures inside it. When the base layer
 * is a mask, fade it like the rest.
 *
 * A hollowed mask is the opposite case and takes the plain overlay opacity: a
 * one-voxel shell occludes almost nothing and barely overlaps its neighbours,
 * so it does not need the extra fade a filled one does — and at the fade a
 * filled stack wants, a shell is too thin to see at all.
 */
function opacityFor(
  entry: ApiVolume | undefined,
  index: number,
  overlayOpacity: number,
  hollow: boolean,
): number {
  const seg = entry ? isSegChannel(entry) : false
  if (!seg) return index === 0 ? 1 : overlayOpacity
  return hollow ? overlayOpacity : overlayOpacity * SEG_OPACITY_SCALE
}

/**
 * Intensities bracketing the top `lowFrac` / `highFrac` of a channel's voxels.
 *
 * A 256-bin histogram over the channel's own range, walked from the bright end.
 * Bin resolution is plenty here: the source is uint8, so the bins land on the
 * actual sample values rather than approximating them.
 *
 * Both fractions are of the whole volume, not of the above-floor voxels, which
 * is what makes one constant work across channels: a sparse structure and a
 * dense one differ mostly in how many voxels sit above the floor, and taking a
 * fixed share of the total lets the sparse one keep proportionally more of its
 * own signal.
 */
function percentileWindow(
  img: TypedVoxelArray,
  min: number,
  max: number,
  lowFrac: number,
  highFrac: number,
): { calMin: number; calMax: number } {
  const range = max - min
  if (!(range > 0)) return { calMin: min, calMax: max }
  const bins = new Uint32Array(256)
  const scale = 255 / range
  for (let i = 0; i < img.length; i++) {
    const b = Math.round((img[i] - min) * scale)
    bins[b < 0 ? 0 : b > 255 ? 255 : b]++
  }
  const lowTarget = img.length * lowFrac
  const highTarget = img.length * highFrac
  const value = (bin: number): number => min + (bin * range) / 255
  let seen = 0
  let calMax = max
  let calMin = min
  for (let b = 255; b >= 0; b--) {
    seen += bins[b]
    if (seen >= highTarget && calMax === max) calMax = value(b)
    if (seen >= lowTarget) {
      calMin = value(b)
      break
    }
  }
  // A channel flat enough that one bin crosses both targets would collapse to a
  // zero-width window, which paints every voxel at the top of the colormap.
  if (calMax <= calMin) calMax = max
  return { calMin, calMax }
}

/**
 * Window each channel for what it actually holds, and fade the overlays.
 *
 * Raw microscopy channels sit on a large per-channel background offset (the
 * Allen IMSC data floors at 126/82/72 rather than 0) and the whole cell body is
 * above that floor, so the robust auto-window saturates and each channel paints
 * over the one below it. Windowing floor-to-peak keeps the structure visible.
 *
 * A `_seg` channel is a label mask, not an image: it has no internal texture to
 * window against, and floor-to-peak puts its background floor *at* the
 * threshold rather than below it, so the mask's whole bounding region survives
 * as opaque colour. Threshold just above the floor instead — background falls
 * below calMin and turns transparent, and every labelled voxel lands at the top
 * of the colormap as one flat label colour.
 *
 * The opacity is what lets stacked channels show through: niivue blends
 * overlays additively (premultiplied colour, max alpha) into one texture.
 *
 * Windows are computed once per load and cached, because the percentile scan is
 * a full pass over every voxel of every channel and this runs on each drag of
 * the opacity slider.
 */
function computeWindows(): void {
  if (!nv) return
  windows.clear()
  nv.volumes.forEach((volume, index) => {
    const entry = loaded[index]
    if (!entry) return
    const range = volume.globalMax - volume.globalMin
    if (isSegChannel(entry) || !volume.img) {
      windows.set(entry.id, {
        calMin: volume.globalMin + range * 0.01,
        calMax: volume.globalMax,
      })
      return
    }
    windows.set(
      entry.id,
      percentileWindow(
        volume.img,
        volume.globalMin,
        volume.globalMax,
        RAW_SIGNAL_FRACTION,
        RAW_SATURATION_FRACTION,
      ),
    )
  })
}

function applyDisplay(): void {
  if (!nv) return
  const overlayOpacity = Number(els.opacity.value)
  nv.volumes.forEach((volume, index) => {
    const entry = loaded[index]
    const window = entry ? windows.get(entry.id) : undefined
    nv?.setVolume(index, {
      calMin: window?.calMin ?? volume.globalMin,
      calMax: window?.calMax ?? volume.globalMax,
      opacity: opacityFor(entry, index, overlayOpacity, els.hollow.checked),
    })
  })
}

function renderHud(): void {
  if (!current) {
    els.hud.textContent = 'no dataset'
    return
  }
  const lines = [
    `dataset: ${current.key}`,
    `${current.channels.length} channel(s) · ${current.shape.join(' x ')} voxels`,
    formatSpacing(current),
  ]
  if (loaded.length === 0) {
    lines.push('no channels loaded')
  } else {
    const overlayOpacity = Number(els.opacity.value)
    lines.push('loaded:')
    for (const [i, entry] of loaded.entries()) {
      const alpha = opacityFor(entry, i, overlayOpacity, els.hollow.checked)
      const gene = allenGene(entry)
      const name = gene
        ? `${gene} ${ALLEN_STRUCTURES[gene].label}`
        : (entry.channelName ?? entry.id)
      const cmap = colormapFor(entry.id).replace(/^Allen_/, 'allen ')
      lines.push(
        `  ${name} — ${cmap}${alpha < 1 ? ` @ ${alpha.toFixed(2)}` : ''}`,
      )
    }
  }
  els.hud.textContent = lines.join('\n')
}

// Overlay opacity is a per-channel gain in an additive blend, so N channels at
// a fixed opacity sum toward white: at the 0.6 that suits a two-channel view, a
// full 16-channel stack blows out its dense core. Scale the default with the
// count (verified: 16 raw Allen channels are legible near 0.12, unreadable at
// 0.6). Anchored so the common 2-channel case still lands on 0.6. Once the user
// moves the slider it is theirs, and this stops overriding it.
//
// Hollowed masks are exempt: shells cover a small fraction of the voxels and
// hardly overlap, so the sum stays far from saturation however many are
// stacked, and scaling them down just makes them invisible.
function suggestedOpacity(entries: ApiVolume[], hollow: boolean): number {
  if (entries.length < 2) return 0.6
  if (hollow && entries.every(isSegChannel)) return 0.6
  return Math.min(0.6, Math.max(0.12, 1.2 / entries.length))
}

async function loadSelected(): Promise<void> {
  if (!nv || !current) return
  const ids = selectedBoxes().map((b) => b.value)
  const entries = current.channels.filter((e) => ids.includes(e.id))
  if (!opacityTouched) {
    els.opacity.value = String(suggestedOpacity(entries, els.hollow.checked))
  }
  const myToken = ++loadToken
  els.load.disabled = true
  els.status.textContent = entries.length
    ? `loading ${entries.length} channel(s)…`
    : 'clearing…'
  try {
    await nv.loadVolumes(
      entries.map((entry, index) => ({
        // Absolute: niivue's volume-load worker resolves the URL against the
        // worker scope, where a root-relative path fails to parse and forces a
        // main-thread fallback.
        url: new URL(
          `/volumes/${encodeURIComponent(entry.id)}/raw.nii.gz`,
          window.location.origin,
        ).href,
        colormap: colormapFor(entry.id),
        opacity: opacityFor(
          entry,
          index,
          Number(els.opacity.value),
          els.hollow.checked,
        ),
      })),
    )
  } catch (err) {
    if (myToken !== loadToken) return
    els.status.textContent = `load failed: ${err instanceof Error ? err.message : err}`
    return
  } finally {
    if (myToken === loadToken) els.load.disabled = false
  }
  // A newer load superseded this one while these channels streamed.
  if (myToken !== loadToken) return
  loaded = entries
  computeWindows()
  applyDisplay()
  if (els.hollow.checked) await hollowLoadedMasks()
  if (myToken !== loadToken) return
  nv.sliceType = Number(els.layout.value)
  nv.drawScene()
  els.status.textContent = ''
  renderHud()
}

// A slow yaw, which is how the reference viewer presents a cell: a static
// projection of overlapping translucent structures is genuinely ambiguous, and
// rotation is what separates them.
function setSpinning(on: boolean): void {
  if (spinFrame) {
    cancelAnimationFrame(spinFrame)
    spinFrame = 0
  }
  els.turntable.classList.toggle('on', on)
  if (!on || !nv) return
  const step = (): void => {
    if (!nv) return
    nv.azimuth = (nv.azimuth + 0.4) % 360
    spinFrame = requestAnimationFrame(step)
  }
  spinFrame = requestAnimationFrame(step)
}

function resetCamera(): void {
  if (!nv || !home) return
  setSpinning(false)
  nv.azimuth = home.azimuth
  nv.elevation = home.elevation
  nv.drawScene()
}

function currentFamily(): Family {
  return els.family.value as Family
}

// Split from the load so the sidebar can be built before the (slow) GPU init.
function showDataset(key: string): void {
  const next = datasets.find((d) => d.key === key)
  if (!next) return
  current = next
  loaded = []
  const family = currentFamily()
  const preselect = visibleChannels(next, family).slice(0, DEFAULT_CHANNELS)
  buildChannelList(next, family, new Set(preselect.map((e) => e.id)))
  renderHud()
}

// Switching family re-lists the sidebar and keeps whatever of the selection is
// still on screen. It deliberately does not select the new family for you: the
// point of the filter is to aim the "all" button, which is one click away.
function showFamily(): void {
  if (!current) return
  const keep = new Set(selectedBoxes().map((b) => b.value))
  buildChannelList(current, currentFamily(), keep)
}

function selectDataset(key: string): void {
  showDataset(key)
  void loadSelected()
}

// Sources this page can't load whole still belong in the microscopy index —
// list them with the page that streams them.
function buildStreamingList(all: Dataset[]): void {
  els.streaming.replaceChildren()
  const streamed = all.filter((d) => !isLoadableHere(d) && d.format !== 'nifti')
  if (streamed.length === 0) {
    const p = document.createElement('p')
    p.className = 'note'
    p.textContent = 'none'
    els.streaming.appendChild(p)
    return
  }
  const backend = getBackendFromUrl()
  for (const d of streamed) {
    const page = STREAMING_PAGES[d.format]
    const a = document.createElement('a')
    a.href = page
      ? backend === 'webgpu'
        ? `${page.href}?backend=webgpu`
        : page.href
      : '#'
    a.textContent = d.key
    const meta = document.createElement('span')
    meta.className = 'meta'
    meta.textContent = `${d.format} · ${d.shape.join(' x ')} · ${page ? `open in ${page.label}` : 'no viewer page'}`
    a.appendChild(meta)
    els.streaming.appendChild(a)
  }
}

async function main(): Promise<void> {
  const res = await fetch('/api')
  if (!res.ok) throw new Error(`/api ${res.status}`)
  const json = (await res.json()) as { volumes?: ApiVolume[] }
  const all = groupDatasets(json.volumes ?? [])
  buildStreamingList(all)
  datasets = all.filter(isLoadableHere)
  if (datasets.length === 0) {
    showFallback(
      'No whole-volume microscopy sources in /api. Fetch one with:\n' +
        'bunx nx run iiif-volumetric-server:fetch-allen',
    )
    return
  }

  els.dataset.replaceChildren()
  for (const d of datasets) {
    const opt = document.createElement('option')
    opt.value = d.key
    opt.textContent = `${d.key} (${d.channels.length}ch, ${d.shape.join('x')})`
    els.dataset.appendChild(opt)
  }
  els.dataset.value = datasets[0].key
  showDataset(datasets[0].key)

  // Pure black, no chrome: the reference viewer is a bare 3D render on black,
  // and fluorescence hues only look right against it — a lifted background
  // greys out the faint end of every channel, which is most of the signal.
  nv = new NiiVue({
    backend: BACKEND,
    backgroundColor: [0, 0, 0, 1],
    isColorbarVisible: false,
    // These palettes are constant-RGB with a ramped alpha, so all the
    // structure is in alpha. Without this the 2D slices show the first
    // channel as a flat wash (the 3D render has always used this alpha).
    volumeIsColormapAlphaOn2D: els.alpha2d.checked,
  })
  await nv.attachToCanvas(els.canvas)
  registerAllenColormaps(nv)
  nv.is3DCrosshairVisible = false
  nv.isOrientCubeVisible = false
  nv.isOrientationTextVisible = false
  home = { azimuth: nv.azimuth, elevation: nv.elevation }

  els.dataset.addEventListener('change', () => {
    selectDataset(els.dataset.value)
  })
  els.layout.addEventListener('change', () => {
    if (!nv) return
    // A turntable only means anything in the 3D render.
    if (Number(els.layout.value) !== 4) setSpinning(false)
    nv.sliceType = Number(els.layout.value)
    nv.drawScene()
  })
  els.turntable.addEventListener('click', () => {
    setSpinning(!spinFrame)
  })
  els.reset.addEventListener('click', resetCamera)
  els.opacity.addEventListener('input', () => {
    opacityTouched = true
    if (nv && nv.volumes.length > 0) applyDisplay()
    renderHud()
  })
  els.shading.addEventListener('input', () => {
    if (!nv) return
    nv.volumeIllumination = Number(els.shading.value)
  })
  els.maxProject.addEventListener('change', () => {
    if (!nv) return
    nv.volumeRenderMode = els.maxProject.checked
      ? VOLUME_RENDER_MODE.MAXIMUM
      : VOLUME_RENDER_MODE.COMPOSITE
  })
  els.alpha2d.addEventListener('change', () => {
    if (!nv) return
    nv.volumeIsColormapAlphaOn2D = els.alpha2d.checked
  })
  els.family.addEventListener('change', showFamily)
  els.hollow.addEventListener('change', () => {
    void loadSelected()
  })
  els.pickAll.addEventListener('click', () => {
    setAllChannels(true)
  })
  els.pickNone.addEventListener('click', () => {
    setAllChannels(false)
  })
  els.load.addEventListener('click', () => {
    void loadSelected()
  })
  els.clear.addEventListener('click', () => {
    for (const box of channelBoxes()) box.checked = false
    refreshChannelLimit()
    void loadSelected()
  })

  selectDataset(datasets[0].key)
}

main().catch((err: unknown) => {
  showFallback(err instanceof Error ? err.message : String(err))
})
