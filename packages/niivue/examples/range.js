// Client-side chunk streaming demo for the NiiVue 3D viewer.
//
// Streams a chunked volume into NiiVue over plain HTTP, with no backend or data
// server -- only static file serving (the synthetic source uses HTTP 206 range
// requests on a single shard; the OME-Zarr source reads per-chunk objects via
// zarrita). Add `?backend=webgpu` to the URL to use the WebGPU renderer.
//
// Two static-hosted source types:
//   - synthetic: a bundled shard streamed one chunk at a time over Range
//   - omezarr:   full upstream OME-Zarr stores read with zarrita, in either
//                0.5 (zarr v3) or 0.4 (zarr v2) form -- see fetchStoreRoot

import * as zarr from 'zarrita'
import NiiVue, {
  ByteLruCache,
  chunkVolumeGrid,
  createStreamingNVImage,
  omeZarrChunkedSource,
  openOmeZarr,
  parseOmeZarrAttrs,
  SLICE_TYPE,
} from '../src/index.ts'

const backend =
  new URLSearchParams(location.search).get('backend') === 'webgpu'
    ? 'webgpu'
    : 'webgl2'

// The coarse whole-volume floor is ON by default: a single coarse pyramid level
// rendered behind the octree so regions whose fine bricks have not streamed yet
// (or whose mean-downsampled coarse bricks fall below the transparency threshold)
// show continuous low-res detail instead of blank/see-through gaps. Pass ?nofloor
// to disable (A/B: fine-only vs. coarse backdrop). NOTE: the floor is only as
// good as the level it reads, so it is the first thing to rule out when a store
// looks wrong -- but ruling it out is one URL flag, and it is worth doing before
// blaming the renderer. Z-periodic "venetian" striping that is IDENTICAL with
// and without ?nofloor is coming from the level's own bytes, not from mixing
// levels. See the screening rule above OMEZARR_STORES for the worked example.
const NO_FLOOR = new URLSearchParams(location.search).has('nofloor')
// Bumped each (re)load so a superseded load's late async work (e.g. the coarse
// floor build) is discarded instead of stomping a newer scene.
let reloadToken = 0

// Monotonic id stamped on every loaded source (`source.serial`). In-flight
// fetches from a superseded source resolve after we have reset `stats` and moved
// on, so they must NOT mutate the live counters (which would inflate the new
// source's numbers and light up the wrong chunk-strip cells). Every stats write
// is gated on `isLiveSerial(serial)`: the fetch's originating source must still
// be the active one. A same-source reload (window/colormap) keeps the serial, so
// its stragglers correctly update the current stats; a source switch changes it,
// so the old source's stragglers no-op.
let sourceSerial = 0
// Compare against the newest stamped serial (not activeSource, which is briefly
// null while a source-switch load is in flight — otherwise the array-open
// metadata fetches of the load that's currently newest would be dropped).
const isLiveSerial = (serial) => serial === sourceSerial

// The explode scale currently applied to the resident volume. Explode is gated
// on load-settle (see syncExplode): while chunks are still streaming the volume
// stays un-exploded (1), because the exploded "keep every brick resident" render
// path floods the load pipeline and janks the main thread. Reset to 1 on each
// (re)load; the slider's value is applied once in-flight/pending reach zero.
let appliedExplodeScale = 1

// GPU residency budget for the resident chunk set (RGBA + gradient textures;
// scalar upload textures are transient). niivue caps the per-frame working set
// to the chunks that fit this budget, so resident VRAM is hard-bounded to
// roughly this value. For a whole-volume 3D render the view-centred working set
// never moves off the centre as you rotate, so a too-small budget leaves you
// stuck on one section of the volume. 8 GB lets the bundled scivis levels that
// fit a desktop GPU resolve fully (e.g. all of pawpawsaurus L0 ~8 GB). Levels
// far larger than this still cannot render whole -- richtmyer-meshkov L0 is
// 8.05 Gvoxel, which needs tens of GB once expanded to RGBA plus its gradient
// texture -- so they are region-of-interest only.
//
// WebGL2 gets a much smaller budget. A WebGL2 3D texture is a single immutable
// allocation with no sub-allocation or eviction of its own, and this demo was
// measured holding 1.67 GB across 177 bricks on hoa_heart L0 before the driver
// started dropping the context. Below the plan budget on purpose: with the GPU
// budget above it the LRU never evicts, so a refocus (moving the crosshair to
// the far face of a clipped volume) just piles the new bricks on top of the old
// ones until the context dies and streaming stops for good.
const DEFAULT_RESIDENCY_BYTES =
  backend === 'webgpu' ? 8192 * 1024 * 1024 : 1280 * 1024 * 1024
const SYNTHETIC_DEFAULT_WINDOW = { min: 24, max: 210 }

// OME-Zarr stores resolve against a local copy first and the public Open SciVis
// bucket second -- see resolveStore, which picks whichever base offers the most
// levels. `levels` lists the scale indices that may be present, coarsest-first;
// only those that actually resolve reach the Level control. `stent` is bundled
// locally (scale2 only); the rest stream from the bucket as-is, and
// scripts/fetch-omezarr.ts can mirror any of them to disk.
//
// SCREEN EVERY STORE BEFORE ADDING IT HERE. A published pyramid can be broken in
// ways no renderer can compensate for, and the failure looks like a viewer bug:
// Z-periodic "venetian" striping. Two checks per level, both run against the
// decoded chunks directly (no viewer, no GPU):
//
//   (a) COMPLETENESS -- compare the z range that actually has chunks against the
//       declared shape. An absent chunk is "fill value" per the zarr spec, so a
//       level that covers less than the coarser level above it reads as empty
//       space there and the octree refines into a hole.
//   (b) PERIODICITY -- take a per-z-plane mean over a central window and
//       autocorrelate. A ripple (or hard zero runs) at the chunk period means the
//       level itself is banded on the chunk grid.
//
// A store needs at least one level that passes BOTH; if every level fails one,
// it cannot be rendered faithfully at any detail setting. The Open SciVis
// `pig_heart` store is the worked example and was dropped from this list for
// exactly that reason: its scale0 is clean but covers 25% of its declared z
// extent, while scale1 (the finest complete level) zeroes local z 54..80 of
// every 81-deep chunk, and scale2/scale3 carry that same defect averaged down
// into period-9 and period-2 ripples. Capping the level did not help, and
// ?nofloor was pixel-identical, because the striping is in the published bytes.
// The stores below all pass both checks at every level. Also deliberately
// absent: `3d_neurons_15_sept_2016`, which fails check (a) the same way
// (scale0 populates z 0..191 of a declared 1718, a contiguous 11% prefix, while
// scale1 carries real signal throughout, so it is usable only from scale1 down);
// and `woodbranch`, which passes both checks but is a dull thing to look at.
//
// A store outside the Open SciVis bucket sets `base` (an absolute URL that the
// store id is appended to) instead of resolving through the local mirror.
//
// `defaultWindow` is OPTIONAL. Omit it and core derives a 2%-98% window from the
// coarse floor it builds anyway, which is what a store nobody has characterised
// should get. The five that keep one keep it because the comment beside each
// records a choice percentiles cannot make: putting calMin ABOVE a background
// shoulder (air, resin, embedding medium) so the background clips to black and
// the whole ramp is spent on tissue. A 2nd percentile sits inside those peaks,
// not past them.
const HOA_BASE =
  'https://storage.googleapis.com/ucl-hip-ct-35a68e99feaae8932b1d44da0358940b/'
const OMEZARR_STORES = {
  stent: {
    id: 'stent.ome.zarr',
    name: 'Stent OME-Zarr',
    levels: [2],
  },
  pawpawsaurus: {
    id: 'pawpawsaurus.ome.zarr',
    name: 'Pawpawsaurus OME-Zarr',
    levels: [3, 2, 1, 0],
    // A fossil skull still in its matrix, so the same shoulder problem as the
    // biological microCT below: the derived 2%-98% window is 12075-48463, whose
    // calMin sits inside the matrix rather than past it, and the skull washes
    // out to flat white. calMin above the matrix spends the ramp on bone.
    defaultWindow: { min: 30269, max: 56893 },
  },
  richtmyer_meshkov: {
    id: 'richtmyer_meshkov.ome.zarr',
    name: 'Richtmyer-Meshkov OME-Zarr',
    levels: [4, 3, 2, 1, 0],
  },
  // Biological microCT.
  chameleon: {
    id: 'chameleon.ome.zarr',
    name: 'Chameleon OME-Zarr (uint16)',
    levels: [3, 2, 1, 0],
    // The largest whole-animal store in the bucket (1.13 Gvoxel) and the closest
    // thing it has to a bigger stag beetle. Strongly bimodal: air/soft resin
    // fills 0-7246 (91% of voxels; p50=4522, p90=5788), then a near-empty gap,
    // then skeleton concentrated at 24000-29000 with a bone tail to 57591
    // (p99=30623, p99.9=42408, measured over the coarsest level). calMin above
    // the air shoulder drops the background out and ramps the skeleton across
    // the full gray scale.
    defaultWindow: { min: 7500, max: 36000 },
  },
  kingsnake: {
    id: 'kingsnake.ome.zarr',
    name: 'Kingsnake OME-Zarr (uint8)',
    levels: [3, 2, 1, 0],
    // Air sits at ~3; soft tissue fills 80-90 and bone runs to ~127
    // (p50=3, p90=82, p99=90, max=127 measured over the coarsest level).
    defaultWindow: { min: 30, max: 110 },
  },
  stag_beetle: {
    id: 'stag_beetle.ome.zarr',
    name: 'Stag Beetle OME-Zarr (uint16)',
    levels: [3, 2, 1, 0],
    // Mostly air (p50=0); the chitin exoskeleton is the whole signal, reaching
    // ~800 at p99 and 1906 at peak. calMin clears the air floor.
    //
    // The faint dashed sheet beside the beetle is the specimen mount, a real
    // thin object in the scan -- it sits in one plane outside the animal and
    // stays put at every level. It is NOT chunk-grid banding (check (b) above
    // passes at every level), and no calMin separates it: raising the floor past
    // ~600 washes out the chitin before the mount fades.
    defaultWindow: { min: 200, max: 1500 },
  },
  // Human Organ Atlas (HiP-CT), a whole human heart at 7.013 um, in a public
  // GCS bucket. The demo's only OME-Zarr 0.4 (zarr v2) store, and the reason
  // the v2 read path exists. Seven levels, 91x93x123 up to 5787x5943x7865
  // (270 Gvoxel / 541 GB), so the finest ones exist only as multi-LOD detail
  // near the crosshair -- no level past L2 fits any residency budget whole.
  //
  // Screened clean at every level: all seven are complete on all three axes
  // (L0 stores 134043 of 134044 chunks -- see below -- L1 17112/17112, L2
  // 2304/2304, L3 288/288), and none is banded on the chunk grid (plane-mean
  // sd 0.0-0.5% of the mean, no zero planes, acf at the 128-voxel chunk period
  // between -0.13 and -0.35, i.e. no ripple). The one absent L0 chunk is
  // 0/0/33, a 128-cube at the extreme x/y corner of the volume: it reads as
  // fill value 0 where its neighbours read ~49860, but that corner is embedding
  // medium, which calMin already clips to black, so the gap is not visible.
  hoa_heart: {
    id: 'UCL-ZCR-3341/heart/7.013um_overview_bm18.ome.zarr',
    base: HOA_BASE,
    name: 'HOA Human Heart OME-Zarr (uint16)',
    levels: [6, 5, 4, 3, 2, 1, 0],
    // HiP-CT is low contrast on a high pedestal, unlike every scivis store
    // here: the embedding medium peaks at ~49890 and the myocardium at ~50830
    // (p1=49433, p50=49887, p99=51070, measured over level 4). calMin in the
    // valley between the two peaks drops the medium to black and spends the
    // whole ramp on tissue.
    defaultWindow: { min: 50200, max: 51300 },
  },
}
// Per-axis brick halo (in level voxels). 3D gradient/lighting samples one voxel
// past each brick face; a 3-voxel halo keeps that reach inside resident data so
// brick boundaries don't show grid-aligned gradient/lighting seams. Without it
// loadChunkedVolume falls back to the core default [1,1,1] and the seams return.
// 3 also covers the tricubic filter's 2-voxel reach (see applyInterp).
// `?halo=N` overrides it, which is how the halo-vs-filter question is tested:
// trilinear reaches 1 voxel past a face and cubic reaches 2. `?halo=1` plus
// cubic is the case core now handles for itself: turning cubic on re-plans
// every live streamed volume at halo >= 2, and the renderer refuses cubic on
// any plan that still cannot feed the kernel rather than seaming silently.
const HALO_PARAM = Number(
  new URLSearchParams(location.search).get('halo') ?? Number.NaN,
)
let streamingChunkHalo =
  Number.isFinite(HALO_PARAM) && HALO_PARAM >= 0
    ? [HALO_PARAM, HALO_PARAM, HALO_PARAM]
    : [3, 3, 3]
const ZARR_BYTE_CACHE_BYTES = 512 * 1024 * 1024

// --- multi-LOD (crosshair-focused mixed-resolution) -------------------------
//
// For an OME-Zarr store with a pyramid we hand the pyramid to the core
// `nv.loadChunkedVolume(source, options)` API (a `ChunkedVolumeSource` adapter,
// see ZarrChunkedVolumeSource below), which builds a Neuroglancer-style octree:
// bricks near the crosshair render at the finest level, coarsening outward,
// under a brick/VRAM budget, and follow the crosshair automatically. This keeps
// a huge finest level (e.g. richtmyer-meshkov L0, 8.05 Gvoxel) renderable —
// only the focus region is ever finest — with the fetch dispatch/concurrency/
// retry all in core.
// The Level control becomes a max-detail cap (`minLevel`).
//
// WHERE the detail goes is the BUDGET PLAN — the policy half of the API, chosen
// with the Plan control (`budgetPlan`, core `BUDGET_PLANS`). Do not confuse it
// with the chunk plan, which is the brick list the octree pass produces FROM it:
//
//   focus       finest bricks at the crosshair, coarsening outward
//   uniform     ignores the crosshair; the finest level that fits the WHOLE
//               volume, for a static whole-volume picture (this demo's default,
//               so a source opens showing all of itself rather than a detailed
//               core in a coarse shell)
//   interactive same crosshair focus on a smaller brick budget, for smooth
//               rotate/zoom
//
// The plan supplies the brick cap (< core MAX_CHUNKS_PER_TILE=1024); the budget
// pass coarsens until the plan fits. This demo overrides only the VRAM budget,
// which is a property of the machine rather than of the use case: it keeps
// resident VRAM ~this regardless of the level the user picks. On WebGPU it stays
// below DEFAULT_RESIDENCY_BYTES so no planned brick evicts; on WebGL2 the GPU
// budget is deliberately lower than this, so the LRU keeps the visible bricks
// and evicts the rest.
const MULTILOD_BUDGET_BYTES = 2048 * 1024 * 1024
// Start-up budget plan; ?plan=focus|interactive|uniform preselects one.
const INITIAL_BUDGET_PLAN =
  new URLSearchParams(location.search).get('plan') ?? 'uniform'
// The core NVChunkedVolume handle for the active OME-Zarr source (null for
// synthetic). Owns the focus-follow plan swaps; the demo drives its max-detail
// cap from the Level control and nudges it to re-plan on zoom/layout changes.
let activeCv = null

// --- logical-volume helpers (inlined from the demo glue) --------------------

function niftiDatatype(dtype) {
  switch (dtype) {
    case 'uint8':
      return { code: 2, bits: 8, displayMin: 0, displayMax: 255 }
    case 'int8':
      return { code: 256, bits: 8, displayMin: -128, displayMax: 127 }
    case 'uint16':
      return { code: 512, bits: 16, displayMin: 0, displayMax: 65535 }
    case 'int16':
      return { code: 4, bits: 16, displayMin: -32768, displayMax: 32767 }
    case 'float32':
      return { code: 16, bits: 32, displayMin: 0, displayMax: 1 }
    default:
      return { code: 512, bits: 16, displayMin: 0, displayMax: 65535 }
  }
}

// --- asset URLs -------------------------------------------------------------

function resolveAssetUrl(path, base) {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  return new URL(
    `${normalizedBase}${path.replace(/^\//, '')}`,
    window.location.href,
  ).toString()
}

function demoAssetUrl(path) {
  return resolveAssetUrl(path, import.meta.env.BASE_URL || '/')
}

function omezarrAssetUrl(path) {
  const upstreamBase = import.meta.env.VITE_OMEZARR_ASSET_BASE
  if (upstreamBase) return resolveAssetUrl(path, upstreamBase)
  const streamingBase = import.meta.env.VITE_STREAMING_ASSET_BASE
  if (streamingBase) return resolveAssetUrl(`omezarr/${path}`, streamingBase)
  return demoAssetUrl(`omezarr/${path}`)
}

// Public Open SciVis mirror of every store in OMEZARR_STORES. It serves CORS
// headers and honours Range, so the browser can stream from it directly. This
// is what makes the finest levels reachable at all: richtmyer-meshkov L0 is
// 1.64 GB compressed (8.05 GB of voxels) across 9682 objects and pawpawsaurus
// L0 is 1.55 GB, which is far past what scripts/fetch-omezarr.ts should put on
// disk.
// A local copy always wins when present (no network, lower latency); this is
// only the fallback, so an un-fetched store is still usable rather than dead.
const OMEZARR_UPSTREAM_BASE =
  'https://ome-zarr-scivis.s3.amazonaws.com/v0.5/96x2/'

// OME-Zarr ships in two on-disk shapes and this demo reads both. 0.5 is zarr
// v3: one `zarr.json` per group and per array, chunk keys under `c/`. 0.4 is
// zarr v2: group metadata split across `.zgroup` + `.zattrs`, array metadata in
// `.zarray`, chunk keys as bare indices. The library's openOmeZarr detects the
// version and opens every level pinned to it; the version-specific code left
// HERE is only the base-probing (which metadata object to HEAD-check per
// level).
const ZARR_V2 = 2
const ZARR_V3 = 3

function arrayMetadataPath(zarrVersion) {
  return zarrVersion === ZARR_V2 ? '.zarray' : 'zarr.json'
}

// Read a store root: its zarr version and its parsed OME metadata (the library
// parser handles both attribute layouts). v3 is tried first (every Open SciVis
// store is v3), so a v2 store pays one extra 404 on the root object and
// nothing after that.
async function fetchStoreRoot(storeUrl) {
  try {
    const meta = await fetchJson(`${storeUrl}/zarr.json`)
    return {
      zarrVersion: ZARR_V3,
      info: parseOmeZarrAttrs(meta.attributes ?? meta),
    }
  } catch {
    // Not a v3 store, or no store here at all; let the v2 read decide which.
  }
  const attrs = await fetchJson(`${storeUrl}/.zattrs`)
  return { zarrVersion: ZARR_V2, info: parseOmeZarrAttrs(attrs) }
}

// Resolved `{ url, levels, zarrVersion, info }` per store id. The level
// control and the open path must agree on which base won, and the probe should
// run once per store.
const resolvedStores = new Map()

// Probe one base: which of the store's configured levels actually resolve
// there, coarsest-first. Throws if the base has no store root at all.
//
// GET, not HEAD, even though only the status is wanted: the HOA bucket's CORS
// policy lists GET alone, so a cross-origin HEAD never gets past the preflight
// and rejects rather than 405s -- every level would read as absent. Array
// metadata is a few hundred bytes and the browser caches it for the open that
// follows, so the extra body costs nothing.
async function probeStoreBase(storeDef, storeUrl) {
  const { zarrVersion, info } = await fetchStoreRoot(storeUrl)
  const levels = []
  for (const candidate of storeDef.levels) {
    const ds = info.datasets[candidate]
    if (!ds) continue
    try {
      const res = await fetch(
        `${storeUrl}/${ds.path}/${arrayMetadataPath(zarrVersion)}`,
      )
      if (res.ok) levels.push(candidate)
    } catch {
      // Unreachable level (offline, blocked); the remaining ones may still be.
    }
  }
  return { zarrVersion, info, levels }
}

// Pick the base offering the FINEST detail, not merely the first that answers.
// A local copy is usually a partial mirror -- fetch-omezarr.ts defaults to the
// two coarsest levels -- so preferring "first that resolves" would pin the demo
// to L2 and make L0 unreachable for exactly the stores where it matters most.
// Ties go to the first candidate, so a fully-fetched local store still wins and
// an offline session (upstream probes fail) falls back to whatever is on disk.
async function resolveStore(storeDef) {
  const cached = resolvedStores.get(storeDef.id)
  if (cached) return cached
  // A store with its own `base` lives in exactly one place: fetch-omezarr.ts
  // only mirrors the Open SciVis bucket, so there is no local copy to prefer
  // and no scivis fallback that could hold it.
  const candidates = storeDef.base
    ? [`${storeDef.base}${storeDef.id}`]
    : [omezarrAssetUrl(storeDef.id)]
  // An explicit VITE_OMEZARR_ASSET_BASE is a deliberate override -- honour it
  // alone rather than silently reaching past it to the public bucket.
  if (!storeDef.base && !import.meta.env.VITE_OMEZARR_ASSET_BASE) {
    candidates.push(`${OMEZARR_UPSTREAM_BASE}${storeDef.id}`)
  }
  let best = {
    url: candidates[candidates.length - 1],
    levels: [],
    zarrVersion: ZARR_V3,
    info: null,
  }
  for (const url of candidates) {
    let probe = null
    try {
      probe = await probeStoreBase(storeDef, url)
    } catch {
      continue // no store root here (absent locally, or offline); try the next
    }
    if (probe.levels.length > best.levels.length) best = { url, ...probe }
  }
  resolvedStores.set(storeDef.id, best)
  return best
}

const MANIFEST_URL = demoAssetUrl('range-poc/synthetic-volume.json')

// --- byte cache for zarrita -------------------------------------------------

// The library ByteLruCache (byte-bounded LRU over raw store responses, absences
// remembered as zero-byte entries) with the demo's serial-gated HUD counters
// layered on top.
class TrackedByteCache extends ByteLruCache {
  constructor(maxBytes, serial) {
    super(maxBytes)
    // Source serial this cache belongs to; its stats writes no-op once superseded.
    this.serial = serial
  }

  has(key) {
    const hit = super.has(key)
    if (hit && isLiveSerial(this.serial)) stats.cacheHits++
    return hit
  }

  set(key, value) {
    super.set(key, value)
    if (isLiveSerial(this.serial)) stats.cacheBytes = this.totalBytes
  }
}

// --- DOM elements -----------------------------------------------------------

function el(id) {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node
}

const els = {
  source: el('source'),
  level: el('level'),
  plan: el('plan'),
  layout: el('layout'),
  colormap: el('colormap'),
  window: el('window'),
  zoom: el('zoom'),
  zoomVal: el('zoomVal'),
  explode: el('explode'),
  explodeVal: el('explodeVal'),
  samples: el('samples'),
  samplesVal: el('samplesVal'),
  gamma: el('gamma'),
  gammaVal: el('gammaVal'),
  lodComp: el('lodComp'),
  lodCompVal: el('lodCompVal'),
  lodOpacity: el('lodOpacity'),
  lodOpacityVal: el('lodOpacityVal'),
  interp: el('interp'),
  illum: el('illum'),
  illumVal: el('illumVal'),
  gradOpacity: el('gradOpacity'),
  gradOpacityVal: el('gradOpacityVal'),
  silhouette: el('silhouette'),
  silhouetteVal: el('silhouetteVal'),
  blocks: el('blocks'),
  crosshair: el('crosshair'),
  reload: el('reload'),
  canvas: el('nv-canvas'),
  hud: el('hud'),
  chunkStrip: el('chunkStrip'),
  loading: el('loading'),
  loadingLabel: el('loadingLabel'),
  loadingCount: el('loadingCount'),
  loadingFill: el('loadingFill'),
  fallback: el('fallback'),
}

let nv = null
let activeSource = null
let chunkPlan = null
let stats = freshStats()
let pollHandle = 0
// Streaming badge state (see renderLoading). `since` is when the stream last
// went from settled to busy, `until` is how long a finished badge lingers, and
// `label` is the last text pushed into the aria-live region.
const loadingState = { since: 0, until: 0, label: '', planEpoch: 0 }

function freshStats() {
  return {
    requested: new Set(),
    completed: new Set(),
    wireBytes: 0,
    decodedBytes: 0,
    rangeHits: 0,
    chunkObjectHits: 0,
    metadataHits: 0,
    cacheHits: 0,
    cacheBytes: 0,
    emptyChunks: 0,
    emptySkips: 0,
    fullFileFallbacks: 0,
    failures: 0,
    cancelled: 0,
    lastRequests: [],
  }
}

// A read the view stopped wanting. Core aborts superseded bricks on the wire,
// so this arrives as a DOMException named AbortError from either the fetch or
// the signal itself; the message check covers a store that throws a plain Error.
function isAbort(err) {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || /abort/i.test(err.message)
}

function relativeUrl(baseUrl, relative) {
  return new URL(relative, new URL(baseUrl, window.location.href)).toString()
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function html(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parseWindow(fallback) {
  const parts = els.window.value.split(',').map((part) => Number(part.trim()))
  const min = parts[0]
  const max = parts[1]
  if (
    parts.length !== 2 ||
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min >= max
  ) {
    return fallback
  }
  return { min, max }
}

// The source <select> value is either 'synthetic' or an OME-Zarr store key.
function currentStore() {
  return OMEZARR_STORES[els.source.value] ?? null
}

function showFallback(message) {
  els.fallback.textContent = message
  els.fallback.setAttribute('aria-hidden', 'false')
}

function hideFallback() {
  els.fallback.textContent = ''
  els.fallback.setAttribute('aria-hidden', 'true')
}

// Let the user drag a floating panel (the HUD) out of the way of the volume.
// Switches the element to left/top positioning and clamps it to the viewport.
function makeDraggable(node) {
  let dragging = null
  node.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    const rect = node.getBoundingClientRect()
    dragging = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
    node.setPointerCapture(event.pointerId)
    node.classList.add('dragging')
  })
  node.addEventListener('pointermove', (event) => {
    if (!dragging || dragging.pointerId !== event.pointerId) return
    const width = node.offsetWidth
    const height = node.offsetHeight
    const maxX = Math.max(0, window.innerWidth - width)
    const maxY = Math.max(0, window.innerHeight - height)
    const x = Math.min(maxX, Math.max(0, event.clientX - dragging.offsetX))
    const y = Math.min(maxY, Math.max(0, event.clientY - dragging.offsetY))
    node.style.left = `${x}px`
    node.style.top = `${y}px`
    node.style.right = 'auto'
    node.style.bottom = 'auto'
  })
  const end = (event) => {
    if (!dragging || dragging.pointerId !== event.pointerId) return
    dragging = null
    node.classList.remove('dragging')
  }
  node.addEventListener('pointerup', end)
  node.addEventListener('pointercancel', end)
}

// The store's available levels, coarsest-first, on whichever base won (see
// resolveStore). Used to populate the Level control so the user can only pick
// levels that actually exist.
async function presentLevels(storeDef) {
  return (await resolveStore(storeDef)).levels
}

// Populate the Level <select> for the current source. Synthetic has no
// pyramid, so the control is disabled with a single "n/a" entry. For an
// OME-Zarr store, list the levels present on disk (coarsest-first) and select
// the coarsest by default. Returns the selected level (or null for synthetic).
async function refreshLevelControl() {
  const store = currentStore()
  // The synthetic shard is a single-level grid on the legacy streaming path, so
  // it has no octree for a budget plan to shape.
  els.plan.disabled = !store
  if (!store) {
    els.level.replaceChildren(new Option('n/a', ''))
    els.level.disabled = true
    return null
  }
  let levels = []
  try {
    levels = await presentLevels(store)
  } catch {
    levels = []
  }
  if (levels.length === 0) {
    els.level.replaceChildren(new Option('none', ''))
    els.level.disabled = true
    return null
  }
  els.level.replaceChildren(
    ...levels.map((lvl) => new Option(`L${lvl}`, String(lvl))),
  )
  els.level.disabled = levels.length < 2
  // `levels` is coarsest-first. The Level control is a multi-LOD max-detail cap,
  // so default to the FINEST ("allow full detail at the crosshair") — picking a
  // coarser level caps how fine the octree may go anywhere.
  const finest = levels[levels.length - 1]
  els.level.value = String(finest)
  return finest
}

function selectedLevel() {
  const value = Number(els.level.value)
  return Number.isInteger(value) ? value : null
}

function formatWindow(win) {
  return `${win.min},${win.max}`
}

function setDefaultWindowForSelectedSource() {
  const store = currentStore()
  const win = store ? store.defaultWindow : SYNTHETIC_DEFAULT_WINDOW
  // Empty means "no opinion": the load passes no calMin/calMax, core derives
  // one, and the reload writes what it chose back into the field.
  els.window.value = win ? formatWindow(win) : ''
}

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  }
  return await res.json()
}

async function fetchManifest() {
  return fetchJson(MANIFEST_URL)
}

// `serial` is the originating source's serial; stats writes are gated on it so a
// superseded source's in-flight range fetch cannot mutate the live counters.
async function fetchByteRange(serial, url, start, length) {
  const end = start + length - 1
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
  })
  if (!res.ok) {
    if (isLiveSerial(serial)) stats.failures++
    throw new Error(`GET ${url} range ${start}-${end} -> ${res.status}`)
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  const live = isLiveSerial(serial)
  if (live) stats.wireBytes += bytes.byteLength

  if (res.status === 206) {
    if (live) stats.rangeHits++
    if (bytes.byteLength !== length) {
      if (live) stats.failures++
      throw new Error(
        `range ${start}-${end} returned ${bytes.byteLength}B, expected ${length}B`,
      )
    }
    recordRequest(serial, `206 ${start}-${end}`)
    return bytes
  }

  if (live) stats.fullFileFallbacks++
  if (bytes.byteLength < end + 1) {
    if (live) stats.failures++
    throw new Error(
      `full response had ${bytes.byteLength}B, cannot slice ${start}-${end}`,
    )
  }
  recordRequest(serial, `200 ${start}-${end}`)
  return bytes.slice(start, end + 1)
}

function recordRequest(serial, label) {
  if (!isLiveSerial(serial)) return
  stats.lastRequests.unshift(label)
  if (stats.lastRequests.length > 5) stats.lastRequests.pop()
}

// Zarr's missing-chunk convention: an absent object means "every voxel holds the
// fill value", i.e. empty space. Sparse stores lean on it hard -- 121 of the stag
// beetle's 256 finest-level chunks are simply not there -- and the loader already
// reads a 404 as empty rather than as a failure. What it did NOT do is remember:
// the octree re-plans on every crosshair move and every level change, and one
// brick spans several zarr chunks, so the same absent chunk was asked for again
// and again. A store is immutable for the life of a load, so an absence is
// permanent: remember it and answer locally.
//
// Two caches, because the duplicates arrive both ways. `absent` catches a repeat
// of a chunk already known missing. `probing` catches the commoner case -- a
// burst of concurrent requests for the SAME missing chunk, issued together
// before any of them has come back -- by parking the later ones on the first
// one's result. Only a 404 is shared: a body can be read once, so a waiter on a
// present chunk falls through and fetches its own copy exactly as before.
function emptyChunkResponse() {
  // Body-less, which is what zarrita reads as "chunk not stored".
  return new Response(null, { status: 404, statusText: 'Not Found (cached)' })
}

function createTrackedZarrFetch(serial) {
  const absent = new Set()
  const probing = new Map()

  return async (request) => {
    const absentKey = `${request.method || 'GET'} ${request.url}`
    if (absent.has(absentKey)) {
      if (isLiveSerial(serial)) stats.emptySkips++
      return emptyChunkResponse()
    }
    const probe = probing.get(absentKey)
    if (probe && (await probe)) {
      if (isLiveSerial(serial)) stats.emptySkips++
      return emptyChunkResponse()
    }

    let settleProbe = () => {}
    probing.set(
      absentKey,
      new Promise((resolve) => {
        settleProbe = resolve
      }),
    )
    let response
    try {
      response = await fetch(request)
    } catch (err) {
      // Settle the probe before rethrowing, or every waiter hangs forever.
      probing.delete(absentKey)
      settleProbe(false)
      throw err
    }
    // A 404 on METADATA is not an empty chunk. zarrita's v2 open asks each array
    // for `.zattrs`, which a store need not write, so a v2 store 404s once per
    // level before it has fetched a single voxel -- counting those as absent
    // chunks would report a sparse store that isn't one.
    if (
      response.status === 404 &&
      !isZarrMetadataPath(new URL(request.url).pathname)
    ) {
      absent.add(absentKey)
      if (isLiveSerial(serial)) stats.emptyChunks++
    }
    probing.delete(absentKey)
    settleProbe(response.status === 404)

    const method = request.method || 'GET'
    const url = new URL(response.url || request.url)
    const pathname = url.pathname
    const range = request.headers.get('Range')
    const contentLength = Number(response.headers.get('Content-Length') ?? 0)

    // Discard tracking from a superseded source's in-flight zarr fetches so they
    // don't inflate the current source's HUD counters.
    if (!isLiveSerial(serial)) return response

    if (
      method !== 'HEAD' &&
      Number.isFinite(contentLength) &&
      contentLength > 0
    ) {
      stats.wireBytes += contentLength
    }
    if (response.status === 206) {
      stats.rangeHits++
    } else if (response.status === 200 && method !== 'HEAD') {
      if (isZarrMetadataPath(pathname)) {
        stats.metadataHits++
      } else {
        stats.chunkObjectHits++
      }
    }
    if (!response.ok && response.status !== 404) {
      stats.failures++
    }

    recordRequest(
      serial,
      `${response.status}${range ? ` ${range.replace(/^bytes=/, '')}` : ''} ${shortZarrPath(pathname)}`,
    )
    // A multi-LOD load fires thousands of native zarr fetches; the throttled HUD
    // poll refreshes the panel, so don't rebuild it per fetch.
    return response
  }
}

// Chunk object or metadata? Keying on the chunk path shape does not generalize
// across versions -- v3 puts chunks under `c/`, v2 writes bare indices
// (`3/0/1/2`) that look like any other path. Every metadata object in either
// version is named `zarr.json` or is a dotfile (`.zarray`/`.zattrs`/`.zgroup`),
// so classify on the leaf name and read everything else as a chunk.
function isZarrMetadataPath(pathname) {
  const leaf = pathname.slice(pathname.lastIndexOf('/') + 1)
  return leaf === 'zarr.json' || leaf.startsWith('.')
}

function shortZarrPath(pathname) {
  const marker = '.ome.zarr/'
  const idx = pathname.indexOf(marker)
  if (idx >= 0) return pathname.slice(idx + marker.length)
  return pathname.split('/').filter(Boolean).slice(-5).join('/')
}

// The finest level's native zarr chunk shape in display order, for the HUD's
// grid readout. The library exposes level dims/spacing in display order but
// the raw array's chunk list stays in declared axis order; map it the same way
// the library maps dims (spatial axes by position, absent z = 1).
function displayChunkShape(zsrc) {
  const chunks = zsrc.arrays[0].chunks
  const { indices, order } = zsrc
  const at = (position) =>
    position < 0 ? 1 : chunks[indices.spatial[position]]
  return [at(order.x), at(order.y), at(order.z)]
}

function assertSupportedDtype(dtype) {
  if (dtype === 'uint8' || dtype === 'uint16' || dtype === 'int16') return dtype
  throw new Error(`OME-Zarr dtype '${dtype}' is not supported by this demo`)
}

async function loadSyntheticSource() {
  const manifest = await fetchManifest()
  const dtypeInfo = niftiDatatype(manifest.dtype)
  return {
    kind: 'synthetic',
    id: manifest.id,
    name: manifest.name,
    shape: manifest.shape,
    spacing: manifest.spacing,
    dtype: manifest.dtype,
    datatypeCode: dtypeInfo.code,
    numBitsPerVoxel: dtypeInfo.bits,
    defaultWindow: { ...SYNTHETIC_DEFAULT_WINDOW },
    chunkGrid: manifest.chunkGrid,
    chunkShape: manifest.chunkShape,
    chunkCount: manifest.chunkCount,
    sourceUrl: manifest.dataUrl,
    transportLabel: 'single shard + HTTP Range',
    dataUrl: relativeUrl(MANIFEST_URL, manifest.dataUrl),
    chunkBytes: manifest.chunkBytes,
  }
}

async function loadOmezarrSource(storeDef, serial) {
  // resolveStore already probed which configured levels resolve at the winning
  // base, so the open below touches only present arrays.
  const { url: storeUrl, levels: presentLevels } = await resolveStore(storeDef)
  if (presentLevels.length === 0) {
    // A `base` store is never mirrored locally, so pointing at fetch-omezarr.ts
    // would be a dead end -- it is upstream or offline.
    throw new Error(
      `No OME-Zarr level found for ${storeDef.id}. ` +
        (storeDef.base
          ? `Is ${storeDef.base} reachable?`
          : `Did you run scripts/fetch-omezarr.ts --name=${els.source.value}?`),
    )
  }

  const baseStore = new zarr.FetchStore(storeUrl, {
    fetch: createTrackedZarrFetch(serial),
  })
  const store = zarr.withByteCaching(baseStore, {
    cache: new TrackedByteCache(ZARR_BYTE_CACHE_BYTES, serial),
  })

  // Open every present level through the library: version-pinned opens, axis
  // classification, display-order dims and spacing. ignoreMissingLevels guards
  // the race where a probed level vanishes between probe and open.
  const zsrc = await openOmeZarr(store, {
    levels: [...presentLevels].sort((a, b) => a - b),
    ignoreMissingLevels: true,
  })
  // The library ChunkedVolumeSource over the pyramid. Bricks arrive in display
  // space -- an `x y z` store (the HOA heart) is transposed per brick, so it
  // now presents the same way as a `z y x` store -- with channel/timepoint
  // pinned to the first.
  const chunkSource = omeZarrChunkedSource(zsrc)

  // Primary geometry = the finest present level (the common grid).
  const finest = zsrc.levels[0]
  const dtype = assertSupportedDtype(finest.dtype)
  const dtypeInfo = niftiDatatype(dtype)
  const shape = finest.dims
  const chunkShape = displayChunkShape(zsrc)
  const chunkGrid = [
    Math.ceil(shape[0] / chunkShape[0]),
    Math.ceil(shape[1] / chunkShape[1]),
    Math.ceil(shape[2] / chunkShape[2]),
  ]

  return {
    kind: 'omezarr',
    id: `${storeDef.id}:multilod`,
    name: `${storeDef.name} multi-LOD`,
    shape,
    spacing: finest.spacingUm,
    dtype,
    datatypeCode: dtypeInfo.code,
    numBitsPerVoxel: dtypeInfo.bits,
    defaultWindow: storeDef.defaultWindow
      ? { ...storeDef.defaultWindow }
      : null,
    chunkGrid,
    chunkShape,
    chunkCount: chunkGrid[0] * chunkGrid[1] * chunkGrid[2],
    sourceUrl: `${storeDef.id}/${finest.path}`,
    transportLabel: 'OME-Zarr multi-LOD octree',
    // All present levels, finest-first, as the library described them
    // ({datasetIndex, dims, spacingUm, path, ...}). The chunkSource dispatches
    // each brick to its own level; the coarse floor reads the last entry.
    levels: zsrc.levels,
    chunkSource,
    level: finest.datasetIndex,
    levelPath: finest.path,
    storeDef,
  }
}

async function loadActiveSource() {
  // Stamp this load with a fresh serial so its fetches/cache can tell whether
  // they are still the active source when they resolve (see isLiveSerial).
  const serial = ++sourceSerial
  const store = currentStore()
  const source = store
    ? await loadOmezarrSource(store, serial)
    : await loadSyntheticSource()
  source.serial = serial
  return source
}

// The library's OME-Zarr ChunkedVolumeSource (source.chunkSource) wrapped with
// demo telemetry, so the HUD counts requested/completed/decoded. The core
// `nv.loadChunkedVolume` owns plan-building, per-level dispatch, concurrency,
// retry, dedup, and residency; the library source owns the zarr read.
function createZarrChunkedSource(source) {
  const base = source.chunkSource
  return {
    datatypeCode: base.datatypeCode,
    levels: base.levels,
    async fetchChunk(req) {
      const key = `${req.levelIndex}|${req.texOrigin.join(',')}|${req.texDims.join(',')}`
      // Record every live-serial fetch. The strip keys cells by brickKey and lights a
      // cell when its brick is in `completed`; the set is NOT pruned on a plan swap, so
      // a brick the core keeps resident across a crosshair refocus (reused without a
      // re-fetch) stays lit. The numeric requested/completed HUD counts come from
      // nv.chunkStreamStats() (authoritative residency), not the set size, so an
      // out-of-plan key here can never inflate a displayed count.
      if (isLiveSerial(source.serial)) stats.requested.add(key)
      try {
        const bytes = await base.fetchChunk(req)
        if (isLiveSerial(source.serial)) {
          stats.decodedBytes += bytes.byteLength
          stats.completed.add(key)
        }
        return bytes
      } catch (err) {
        // An abort is the CANCELLATION path working, not a failure: a re-plan
        // supersedes the bricks it no longer wants and core aborts them on the
        // wire. Counting those here made a healthy uniform load read as
        // "failures 16". They get their own counter instead.
        if (isAbort(err)) {
          if (isLiveSerial(source.serial)) {
            stats.cancelled++
            recordRequest(source.serial, `CANCEL ${key}`)
          }
          throw err
        }
        // Surface the failure in the HUD/console (the signal we used to spot the
        // L0 request flood) before rethrowing. Retry now lives in core, so this
        // counts failed ATTEMPTS: a transient blip the core loader later retries
        // successfully still ticks the counter — a growing number means trouble.
        if (isLiveSerial(source.serial)) {
          stats.failures++
          recordRequest(source.serial, `ERR ${key}`)
        }
        console.error(
          `OME-Zarr region ${key} failed:`,
          err instanceof Error ? err.message : err,
        )
        throw err
      }
    },
  }
}

// The finest-first level index of the Level dropdown's picked pyramid level,
// used as the multi-LOD max-detail cap (minLevel). 0 = finest allowed.
function selectedLevelIndex(source) {
  const picked = selectedLevel()
  const idx = source.levels.findIndex((l) => l.datasetIndex === picked)
  return idx < 0 ? 0 : idx
}

// Single-level chunk plan for the SYNTHETIC single-shard source (OME-Zarr goes
// through the core nv.loadChunkedVolume path). Its native grid fits one tile.
// NOTE: halo 0. The shard is a flat array of exactly-sized chunk payloads and
// createRangeChunkSource asserts the request matches one chunk's byte count, so
// there is nowhere to read neighbour voxels from. Brick faces therefore show a
// trilinear seam on this source, and the renderer declines the cubic filter on
// it entirely (planSupportsCubic). The OME-Zarr sources have proper halos.
function createChunkPlan(source) {
  const plan = chunkVolumeGrid(
    source.shape,
    source.chunkGrid,
    Math.max(...source.chunkShape),
    [0, 0, 0],
  )
  if (plan.chunks.length !== source.chunkCount) {
    throw new Error(
      `chunk plan produced ${plan.chunks.length} chunks, source has ${source.chunkCount}`,
    )
  }
  return plan
}

function createRangeChunkSource(source) {
  const cache = new Map()
  return (request) => {
    const cached = cache.get(request.chunkIndex)
    if (cached) return cached

    const desc = request.desc
    const requestedBytes =
      desc.texDims[0] *
      desc.texDims[1] *
      desc.texDims[2] *
      request.bytesPerVoxel
    if (requestedBytes !== source.chunkBytes) {
      throw new Error(
        `chunk ${request.chunkIndex} asks for ${requestedBytes}B, fixture chunks are ${source.chunkBytes}B`,
      )
    }

    if (isLiveSerial(source.serial)) stats.requested.add(request.chunkIndex)
    const start = request.chunkIndex * source.chunkBytes
    const next = fetchByteRange(
      source.serial,
      source.dataUrl,
      start,
      source.chunkBytes,
    ).then((bytes) => {
      if (isLiveSerial(source.serial)) {
        stats.completed.add(request.chunkIndex)
        stats.decodedBytes += bytes.byteLength
      }
      return bytes
    })
    // Only dedup concurrent in-flight requests; drop the entry once settled so
    // resolved chunk buffers are not retained. niivue manages residency and
    // re-requests an evicted chunk through this source when it is visible again,
    // so caching every resolved buffer here would leak the whole volume (OOM on
    // large levels).
    cache.set(request.chunkIndex, next)
    next.finally(() => {
      if (cache.get(request.chunkIndex) === next) {
        cache.delete(request.chunkIndex)
      }
    })
    // Stats bookkeeping only: the throttled HUD poll (~8 Hz) refreshes the panel,
    // matching the zarr path (createTrackedZarrFetch). A synchronous renderHud()
    // per request/settle would re-introduce the per-fetch DOM reflow jank.
    return next
  }
}

// Current uniform explode scale from the slider (1 = no gap between bricks).
function explodeScale() {
  return Math.max(1, Number(els.explode.value) || 1)
}

// Build the streamed NVImage for the SYNTHETIC single-shard source (OME-Zarr
// goes through the core nv.loadChunkedVolume path instead).
function createStreamingVolume(source) {
  const win = parseWindow(source.defaultWindow)
  // Same skeleton the core nv.loadChunkedVolume path builds (createStreamingNVImage
  // + chunkPlan + chunkSource); the synthetic path only differs in its single-level
  // grid plan and Range-based chunkSource. numBitsPerVoxel is derived from
  // datatypeCode by the core helper.
  const vol = createStreamingNVImage({
    id: source.name,
    url:
      `client-chunk://${source.id}` +
      `?source=${source.kind}` +
      `&cm=${encodeURIComponent(els.colormap.value)}` +
      `&w=${win.min}-${win.max}` +
      `&explode=${explodeScale().toFixed(2)}`,
    shape: source.shape,
    spacing: source.spacing,
    datatypeCode: source.datatypeCode,
    calMin: win.min,
    calMax: win.max,
    colormap: els.colormap.value,
  })
  vol.chunkSource = createRangeChunkSource(source)
  vol.chunkPlan = chunkPlan ?? undefined
  // Start un-exploded; syncExplode applies the slider's explode once the stream
  // settles (exploding mid-stream janks the main thread).
  vol.chunkExplode = { enabled: false }
  return vol
}

// --- zoom + 3D block-outline overlay -----------------------------------------

// Outline color per source LOD level (finest = hot, coarser = cool). range.html
// streams a single level, so most blocks share a color; sourceLevel is honored
// when a plan carries it.
const BLOCK_LEVEL_COLORS = [
  [1, 0.2, 0.2, 1],
  [1, 0.6, 0.1, 1],
  [1, 1, 0.25, 1],
  [0.35, 1, 0.35, 1],
  [0.35, 0.7, 1, 1],
]

// mm extents of the active volume. Matches the createStreamingNVImage grid: voxel
// centres sit at (i + 0.5) * spacing, so the box spans [-0.5, dim - 0.5] * spacing
// per axis.
function volumeExtents(source) {
  const [sx, sy, sz] = source.spacing
  const [nx, ny, nz] = source.shape
  return {
    min: [-0.5 * sx, -0.5 * sy, -0.5 * sz],
    max: [(nx - 0.5) * sx, (ny - 0.5) * sy, (nz - 0.5) * sz],
  }
}

// The focused sub-box at the current zoom: the central 1/zoom fraction of the
// volume on each axis (the region the zoomed-in 2D views frame). At zoom 1 this
// is the whole volume, so nothing is restricted.
function focusRoi(source, zoom) {
  const { min, max } = volumeExtents(source)
  const roiMin = [0, 0, 0]
  const roiMax = [0, 0, 0]
  for (let a = 0; a < 3; a++) {
    const centre = (min[a] + max[a]) / 2
    const half = (max[a] - min[a]) / 2 / Math.max(1, zoom)
    roiMin[a] = centre - half
    roiMax[a] = centre + half
  }
  return { min: roiMin, max: roiMax }
}

function boxesIntersect(aMin, aMax, bMin, bMax) {
  for (let a = 0; a < 3; a++) {
    if (aMax[a] < bMin[a] || aMin[a] > bMax[a]) return false
  }
  return true
}

// One outline box per streamed chunk, in mm. When zoomed in, restrict to the
// chunks intersecting the focus ROI so the outlines mark only the region under
// inspection instead of covering the whole 3D render. When exploded, each box is
// shifted by the same per-brick offset the renderer applies (matching
// ChunkExplode.chunkExplodeOffsetFrac) so the outlines track the exploded bricks.
function computeBlockBoxes(source, plan, zoom, explode) {
  if (!source || !plan) return []
  const { min, max } = volumeExtents(source)
  const cs = source.shape
  const roi = zoom > 1.01 ? focusRoi(source, zoom) : null
  const es = explode > 1.001 ? explode : 1
  const toMM = (voxel, axis) =>
    min[axis] + (voxel / cs[axis]) * (max[axis] - min[axis])
  const boxes = []
  for (const c of plan.chunks) {
    // Unshifted (true volume-space) box drives the focus-ROI membership so
    // restriction stays stable regardless of the explode spacing.
    const bMin = [
      toMM(c.voxelOrigin[0], 0),
      toMM(c.voxelOrigin[1], 1),
      toMM(c.voxelOrigin[2], 2),
    ]
    const bMax = [
      toMM(c.voxelOrigin[0] + c.voxelDims[0], 0),
      toMM(c.voxelOrigin[1] + c.voxelDims[1], 1),
      toMM(c.voxelOrigin[2] + c.voxelDims[2], 2),
    ]
    if (roi && !boxesIntersect(bMin, bMax, roi.min, roi.max)) continue
    // Explode shift: offsetFrac = (centreFrac - 0.5) * (scale - 1) per axis.
    if (es > 1) {
      for (let a = 0; a < 3; a++) {
        const centreFrac = (c.voxelOrigin[a] + c.voxelDims[a] / 2) / cs[a]
        const shift = (centreFrac - 0.5) * (es - 1) * (max[a] - min[a])
        bMin[a] += shift
        bMax[a] += shift
      }
    }
    const level = c.sourceLevel ?? 0
    boxes.push({
      min: bMin,
      max: bMax,
      color: BLOCK_LEVEL_COLORS[Math.min(level, BLOCK_LEVEL_COLORS.length - 1)],
      thickness: level === 0 ? 2 : 1,
    })
  }
  return boxes
}

// One octree-nudge path per zoom SOURCE. applyZoom (slider) sets pan2Dxyzmm /
// scaleMultiplier, whose controller setters synchronously emit 'change'; this flag
// tells the 'change' listener that the nudge was already issued here so a slider
// drag does not ALSO refocus through the change path. Set only around applyZoom's
// synchronous setter writes.
let zoomNudgeInApplyZoom = false

// Push the current zoom to the 2D pan/zoom and the 3D render scale, mark the
// focus ROI in 3D, then refresh the (optionally restricted) block outlines.
function applyZoom() {
  if (!nv) return
  const zoom = Number(els.zoom.value) || 1
  els.zoomVal.textContent = `${zoom.toFixed(1)}x`
  // Zoom the 3D render camera only where it is safe. The multi-LOD OME-Zarr plan
  // (activeCv set) is focus-bounded, so magnifying the render keeps the finest
  // bricks around the crosshair in view. The SYNTHETIC source (activeCv null)
  // streams via the legacy frustum-culled single-level grid: magnifying the
  // render camera pushes bricks out of the frustum so they are never requested
  // and the volume renders mostly blank. Force scale 1 in the render view for
  // that path; other layouts keep the zoom for both paths.
  const inRender = Number(els.layout.value) === SLICE_TYPE.RENDER
  // These setters emit 'change'; suppress the listener's refocus so the slider
  // nudge routes only through this function's activeCv.refocus() below. The
  // finally guarantees the flag clears even if a setter's draw throws, else the
  // programmatic-zoom refocus path would be silently stuck off.
  zoomNudgeInApplyZoom = true
  try {
    nv.pan2Dxyzmm = [0, 0, 0, zoom] // 2D multiplanar: zoom about the centre
    nv.scaleMultiplier = inRender && !activeCv ? 1 : zoom
  } finally {
    zoomNudgeInApplyZoom = false
  }
  applyBlocks()
  // Zoom/layout changes the focus radius (radius:'auto' reads nv zoom + sliceType),
  // so nudge the core handle to re-plan and swap.
  activeCv?.refocus()
}

// Purely UI: reflect zoom changes from ANY source (slider drag, mouse wheel,
// programmatic nv.scaleMultiplier / nv.pan2Dxyzmm) back into the slider + label
// WITHOUT re-driving applyZoom (which would feed back) and WITHOUT nudging the
// octree (each zoom source owns exactly one refocus path; see applyZoom, the
// 'change' listener, and the canvas wheel listener in main). Reads the value
// applyZoom pushes for the active layout: scaleMultiplier in the render view,
// pan2Dxyzmm[3] in multiplanar -- EXCEPT the force-pinned synthetic render path.
function syncZoomControl() {
  if (!nv) return
  const inRender = Number(els.layout.value) === SLICE_TYPE.RENDER
  // applyZoom force-pins scaleMultiplier to 1 in the render view for the SYNTHETIC
  // path (activeCv null); reading it there would keep snapping the slider back to
  // 1.0x and fight the user's drag. pan2Dxyzmm[3] carries the real dragged zoom on
  // that path (applyZoom still writes it), so read that instead. Only the multi-LOD
  // OME-Zarr render (activeCv set) actually zooms the render camera, so
  // scaleMultiplier is authoritative there; multiplanar always reads pan2Dxyzmm[3].
  // Do NOT collapse this to always read scaleMultiplier: on the synthetic render path
  // scaleMultiplier is pinned to 1, and reading it reintroduces the snap-to-1.0x bug.
  const zoom = inRender && activeCv ? nv.scaleMultiplier : nv.pan2Dxyzmm[3] || 1
  // Live zoom (wheel/programmatic) can reach beyond the slider's [min,max]; clamp
  // to the slider range (read from the element) before comparing/assigning, else
  // an out-of-range value never equals els.zoom.value and the label keeps churning.
  const sliderMin = Number(els.zoom.min)
  const sliderMax = Number(els.zoom.max)
  const rounded = Math.min(
    sliderMax,
    Math.max(sliderMin, Math.round(zoom * 10) / 10),
  )
  if (Number(els.zoom.value) === rounded) return
  // Assigning input.value does NOT fire 'input'/'change', so no applyZoom loop.
  els.zoom.value = String(rounded)
  els.zoomVal.textContent = `${rounded.toFixed(1)}x`
}

// Show or hide every block visualization together, gated on the "blocks" toggle:
// the per-chunk outline boxes, the zoom focus-region box, and the loaded-chunks
// indicator strip (which sits over a corner tile). All are cleared when the
// toggle is off so nothing overlays the render.
function applySampleRate() {
  const rate = Number(els.samples.value) || 1
  els.samplesVal.textContent = rate.toFixed(1)
  if (!nv) return
  // Pure render-time setting: no re-stream, and the setter already redraws.
  nv.volumeSampleRate = rate
}

// Display gamma for the 3D render. The exponent lands on each sample's
// classified RGB only, never on its alpha, so raising it brightens the image
// without changing how much any sample occludes what is behind it. It also
// closes most of the coarse-vs-fine LOD brightness gap: a mean-downsampled
// brick attenuates the peaks it averaged over, so it classifies darker than the
// fine data at the same place, and the gamma lifts it back.
function applyGamma() {
  const g = Number(els.gamma.value) || 1
  els.gammaVal.textContent = g.toFixed(2)
  if (!nv) return
  // Pure render-time setting: no re-stream, and the setter already redraws.
  nv.gamma = g
}

// Per-level brightness compensation for coarse multi-LOD bricks. Downsampling
// averages voxels, which destroys the correlation between a sample's colour and
// its opacity; front-to-back compositing weights colour by opacity, so a coarse
// brick integrates darker than the fine data it replaces. The shader lifts each
// brick by exponent 1 - c*log2(k) for its linear downsample factor k, on top of
// the display gamma -- one fixed step per pyramid level, since every level
// averages the same 2x2x2 neighbourhood. Slide to 0 to see the uncompensated
// LOD seam.
//
// The size of the deficit depends on how much intensity varies inside a fine
// voxel, so no single coefficient is exact: sparse thin material (hoa_heart)
// needs about 0.11 per level to null its LOD seam, dense structure
// (pawpawsaurus) about 0.05, which is why this is a slider and not a constant.
function applyLodCompensation() {
  const c = Number(els.lodComp.value)
  els.lodCompVal.textContent = c.toFixed(3)
  if (!nv) return
  // Render-time only: it changes one shader exponent per brick, so there is no
  // re-stream and the setter already redraws.
  nv.volumeLodBrightnessCompensation = c
}

// Per-level OPACITY compensation, the other half of the same problem and OFF by
// default. The march already raises a coarse sample's alpha to the number of
// reference steps it stands for, which is exact only for a homogeneous coarse
// voxel; real ones are not, and since log(1-a) is concave the true transmittance
// through the fine voxels is LOWER than that approximation, so a coarse brick is
// too see-through. This scales that exponent by 1 + c*(k-1).
//
// It defaults to 0 because simulating the march over this pyramid says the
// deficit is ~0 wherever structure is dense enough to saturate the ray, and
// inflating alpha there front-loads accumulation onto the nearer, dimmer samples
// and makes the accumulated colour worse. Sparse thin material does have a real
// deficit, but no global scale recovers much of it -- that needs the per-voxel
// variance mean-downsampling discarded. Slide it up if coarse bricks read as too
// transparent rather than too dark on YOUR data.
function applyLodOpacity() {
  const c = Number(els.lodOpacity.value)
  els.lodOpacityVal.textContent = c.toFixed(2)
  if (!nv) return
  nv.volumeLodOpacityCompensation = c
}

// Texture reconstruction in the 3D fine march: hardware trilinear (default) or
// tricubic B-spline. Trilinear is only C0, so band edges carry a blocky texel
// staircase; the cubic filter is C2 and removes it (it does NOT remove the
// concentric ringing, which survives a C2 reconstruction unchanged). 8 fetches
// per sample instead of 1, so pair it with a lower sample rate if fill rate
// matters. The toggle stays here because a chunked stream is where halo
// correctness matters; the side-by-side A/B comparison, the benchmark and the
// figure export live on vox.interp.html.
//
// Halo: the OME-Zarr sources stream through nv.loadChunkedVolume, which raises
// the brick halo to 2 and re-plans when cubic is turned on, so cubic is always
// fed real neighbour data there. The SYNTHETIC shard source cannot: its plan is
// halo 0 (createChunkPlan) because the shard server serves exactly one chunk's
// bytes per request and has no way to stitch neighbours. On that source the
// renderer declines cubic and logs why, rather than reconstructing from
// clamp-to-edge data at every brick face.
function applyInterp() {
  if (!nv) return
  // Pure render-time setting: no re-stream, and the setter already redraws.
  nv.volumeIsCubicInterpolation = els.interp.value === 'cubic'
}

// The three settings that consume the PRECOMPUTED gradient texture: matcap
// illumination, gradient opacity and silhouette. They share one gate in core
// (`_needsGradient()` = any of the three above 0), and on a chunked volume that
// gate decides whether each brick pays a gradient pass on upload.
//
// All three act on the 3D RAY-MARCH ONLY, and the page opens on multiplanar, so
// set the Layout control to `render` before expecting them to do anything.
//
// This is why they sit on the streaming demo and not only on vox.gradopacity.
// All three default to 0 here, so the page streams UNLIT: no per-brick gradient
// pass at all, which is what lets a fully exploded volume (every brick requested
// every frame) stream without flooding the upload pump -- see syncExplode.
//
// Raising any of them off 0 flips the gate, and core's
// `_refreshUnlitChunksForLighting` reacts by remapping the residency manager to
// an empty set: every resident brick is evicted and re-streamed, this time with
// its gradient built. That is a whole working set of re-uploads on one slider
// step, and it is deliberately visible -- the loading badge fires and the HUD's
// requested/completed, cache and decoded rows show where the bytes came from
// (usually the decoded-chunk tier rather than the network, which is the tier
// doing its job). Once lit, moving any of the three within the non-zero range
// costs nothing extra: the gate is already true, so nothing re-streams.
//
// Dropping all three back to 0 does NOT free the gradients or re-stream. The
// bricks stay as they are and the shader simply stops sampling them.
//
// Budget note: the residency accounting (`chunkResidentBytes`) charges every
// brick 8 bytes/voxel -- RGBA plus gradient -- whether or not a gradient was
// built, so an unlit stream is charged for memory it is not holding and the
// resident brick count does not change when you turn lighting on. The VRAM is
// genuinely saved; the budget just does not credit it yet.
function applyIllumination() {
  const v = Number(els.illum.value) || 0
  els.illumVal.textContent = v.toFixed(2)
  if (!nv) return
  // The default matcap is applied by the controller, so there is nothing to
  // load here; the setter already redraws.
  nv.volumeIllumination = v
}

// Alpha suppression by gradient magnitude. The most expensive setting on this
// page, and not because of the gradient: emptying out homogeneous interior
// stops rays saturating and terminating early, so each one marches the full
// depth. Pair it with a lower sample rate on the big stores.
function applyGradientOpacity() {
  const v = Number(els.gradOpacity.value) || 0
  els.gradOpacityVal.textContent = v.toFixed(2)
  if (!nv) return
  nv.volumeGradientOpacity = v
}

// Fresnel rim term: fade material whose normal faces the camera. On this page
// it doubles as the halo check. A brick's gradient is estimated with a central
// difference that reaches one voxel past each face, so with nothing to read
// there every cut face reports a hard edge and rims brightly -- turn explode up
// and slide silhouette in, and the rims either follow the specimen (halo) or
// outline the brick boxes (no halo). The default synthetic shard source is the
// negative control: halo 0 by construction (see createChunkPlan), so its bricks
// DO outline. Pick an OME-Zarr source, which streams at `streamingChunkHalo`
// (3 by default, `?halo=N` to override), for the positive case.
function applySilhouette() {
  const v = Number(els.silhouette.value) || 0
  els.silhouetteVal.textContent = v.toFixed(2)
  if (!nv) return
  nv.volumeSilhouette = v
}

function applyBlocks() {
  if (!nv) return
  const show = els.blocks.checked
  const zoom = Number(els.zoom.value) || 1
  nv.lodBoxes =
    show && activeSource && chunkPlan
      ? computeBlockBoxes(activeSource, chunkPlan, zoom, appliedExplodeScale)
      : null
  nv.focusBox =
    show && activeSource && zoom > 1.01
      ? {
          ...focusRoi(activeSource, zoom),
          color: [1, 0.6, 0.1, 1],
          thickness: 2,
        }
      : null
  els.chunkStrip.style.display = show ? 'grid' : 'none'
  nv.drawScene()
}

// Show or hide the 3D crosshair, and size its centre gap to whatever is loaded.
//
// The gap is an absolute MM inset on the six cylinders core builds between
// extentsMin and extentsMax, and its 10 mm default assumes a human-scale volume.
// This demo's stores span four orders of magnitude: the synthetic shard is
// ~250 mm across, while the HOA heart's 7.013 um spacing is read as mm and gives
// a ~46 m scene, where a 10 mm gap is far below one pixel and the crosshair
// closes up. Deriving it from the mean scene span keeps it the same apparent
// size everywhere; the fraction reproduces the stock look at human scale.
// crosshairWidth needs no such treatment -- it is canvas pixels, so it already
// draws the same weight at any scale.
const CROSSHAIR_GAP_FRACTION = 0.05

function applyCrosshair() {
  if (!nv) return
  nv.is3DCrosshairVisible = els.crosshair.checked
  const { extentsMin: lo, extentsMax: hi } = nv.model
  // Guarded: extents are only populated once something is loaded, and a degenerate
  // (zero-span) scene would collapse the crosshair to nothing. Leave the current
  // size alone in both cases.
  const span =
    lo && hi ? (hi[0] - lo[0] + (hi[1] - lo[1]) + (hi[2] - lo[2])) / 3 : 0
  if (Number.isFinite(span) && span > 0) {
    nv.crosshairGap = span * CROSSHAIR_GAP_FRACTION
  }
  nv.drawScene()
}

// Reconcile the resident volume's explode with the slider. The renderer reads
// vol.chunkExplode every frame, so this is a live update (no re-stream). Applied
// while streaming too: the exploded render requests every brick each frame, which
// used to flood the load, but skipping the per-chunk gradient pass when unlit
// (see the core gradient gate) removed that cost, so bricks can stream in already
// exploded. Called on slider input and every HUD-poll frame (so it re-applies
// after a reload resets appliedExplodeScale); a no-op when already in the target
// state, so per-frame calls are cheap.
function syncExplode() {
  if (!nv) return
  const vol = nv.volumes?.[0]
  if (!vol) return
  const desired = explodeScale()
  if (desired === appliedExplodeScale) return
  appliedExplodeScale = desired
  vol.chunkExplode =
    desired > 1.001
      ? { enabled: true, scale: [desired, desired, desired] }
      : { enabled: false }
  applyBlocks()
}

// Slider handler: reflect the target value in the label immediately and try to
// apply it (only takes effect once the stream has settled).
function applyExplode() {
  if (!nv) return
  els.explodeVal.textContent = `${explodeScale().toFixed(2)}x`
  syncExplode()
}

// Built strip cells, reused across updates. Recreating every cell each poll (and
// formerly every render frame) forced a DOM reflow that janked rotation; instead
// build once when the chunk layout changes, then just toggle the 'hit' class.
let stripSpans = []
let stripCellKeys = []
let stripKey = ''

// The key a viewer BRICK records into `stats.completed` (and its strip cell is
// keyed by). The synthetic legacy path records integer chunk indices (positional);
// the OME-Zarr multi-LOD path records `level|texOrigin|texDims` content keys,
// matching the core chunk loader. Shared by the strip cells and the plan-swap
// telemetry intersection so the two never diverge.
function brickKey(source, chunk, index) {
  if (source.kind === 'omezarr') {
    return `${chunk.sourceLevel ?? 0}|${chunk.texOrigin.join(',')}|${chunk.texDims.join(',')}`
  }
  return index
}

// One strip cell per viewer brick, keyed by brickKey so a cell lights when its
// brick completes. Hard-capped at 4096: for a thin-Z finest OME-Zarr level the
// native chunk count can be 100k+, and spreading that many <span>s into
// replaceChildren blows the call stack.
function chunkStripKeys(source, plan) {
  const chunks = plan?.chunks ?? []
  const capped = chunks.slice(0, 4096)
  return capped.map((c, i) => brickKey(source, c, i))
}

// Reference of the plan/source the strip cells were last built for. The plan
// reference is stable between crosshair-driven swaps (the core hands back a NEW
// plan object on a swap), so it is a cheap change signal: rebuild the key array and
// re-diff the cell set only when it changes, not on every 120 ms poll.
let lastStripPlan = null
let lastStripSource = null

function renderChunkStrip() {
  const source = activeSource
  if (!source) return
  const plan = chunkPlan
  if (plan !== lastStripPlan || source !== lastStripSource) {
    lastStripPlan = plan
    lastStripSource = source
    const gridDims = plan?.gridDims ?? source.chunkGrid
    const cellKeys = chunkStripKeys(source, plan)
    const columns = Math.min(16, Math.max(4, gridDims[0] * gridDims[1]))
    // Rebuild the DOM only when the cell set changes. For OME-Zarr the plan swaps
    // as the crosshair moves, so the brick keys (not just the count) can change;
    // compare the key list, not just its length, so the strip tracks the live plan.
    const key = `${cellKeys.length}:${columns}`
    const changed =
      key !== stripKey || cellKeys.some((k, i) => k !== stripCellKeys[i])
    if (changed) {
      els.chunkStrip.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`
      stripSpans = Array.from({ length: cellKeys.length }, () =>
        document.createElement('span'),
      )
      els.chunkStrip.replaceChildren(...stripSpans)
      stripCellKeys = cellKeys
      stripKey = key
    }
  }
  // Runs every poll regardless of the memoized rebuild: bricks complete over time,
  // so the per-cell hit class must keep tracking the growing `stats.completed`.
  for (let i = 0; i < stripSpans.length; i++) {
    const hit = stats.completed.has(stripCellKeys[i])
    const cls = hit ? 'hit' : ''
    if (stripSpans[i].className !== cls) stripSpans[i].className = cls
  }
}

function httpSummary() {
  if (stats.rangeHits > 0) {
    return `<span class="ok">${stats.rangeHits} range 206</span>`
  }
  if (stats.chunkObjectHits > 0) {
    return `<span class="ok">${stats.chunkObjectHits} chunk objects</span>`
  }
  if (stats.fullFileFallbacks > 0) {
    return `<span class="warn">${stats.fullFileFallbacks} full-file 200</span>`
  }
  if (stats.metadataHits > 0) {
    return `<span class="warn">${stats.metadataHits} metadata</span>`
  }
  return '<span class="warn">pending</span>'
}

function renderHud() {
  const source = activeSource
  if (!source) return
  const plan = chunkPlan
  const gridDims = plan?.gridDims ?? source.chunkGrid
  const planChunkShape = plan ? chunkShapeFromPlan(plan) : source.chunkShape
  // Viewer BRICK count (not the OME-Zarr native chunk count); 0 until the plan
  // is built. Synthetic always has a plan, so the fallback only affects the
  // brief OME-Zarr load window.
  const chunkCount = plan?.chunks.length ?? source.chunkCount ?? 0
  const nativeRow =
    source.kind === 'omezarr'
      ? `<div class="row"><span class="key">zarr chunks</span><span>${source.chunkGrid.join(' x ')} @ ${source.chunkShape.join(' x ')}</span></div>`
      : ''
  const stream = nv?.chunkStreamStats()
  // Authoritative brick counts from the renderer's residency. The core keeps some
  // bricks resident across a plan swap without re-fetching them, which the demo's
  // own fetch tally cannot observe, so drive the numeric counts from chunkStreamStats.
  // `completed` = bricks resident; `requested` = resident + in-flight + queued (all
  // disjoint subsets of the plan, so completed <= requested <= total always holds and
  // neither can exceed the plan or invert). chunkStreamStats reads null before a view
  // attaches and all-zero for the sub-frame before the first streamed frame registers
  // the chunk manager, so the denominator falls back to the plan count until total is
  // populated (avoids a transient '0 / 0').
  const streamTotal = stream && stream.total > 0 ? stream.total : chunkCount
  const completedCount = stream ? stream.resident : stats.completed.size
  const requestedCount = stream
    ? stream.resident + stream.inFlight + stream.pending
    : stats.requested.size
  const failures =
    stats.failures > 0
      ? `<span class="bad">${stats.failures}</span>`
      : '<span class="ok">0</span>'
  // Cancellations ride on the failures row rather than one of their own: they
  // are the same event class (a read that produced no bytes) and the reader
  // needs to see at a glance which kind it was.
  const cancelled =
    stats.cancelled > 0 ? ` (+${stats.cancelled} cancelled)` : ''
  els.hud.innerHTML = `
    <div class="title">${html(source.name)}</div>
    <div class="row"><span class="key">backend</span><span>${backend === 'webgpu' ? 'WebGPU' : 'WebGL2'}</span></div>
    <div class="row"><span class="key">source</span><span>${html(source.sourceUrl)}</span></div>
    <div class="row"><span class="key">shape</span><span>${source.shape.join(' x ')} ${source.dtype}</span></div>
    <div class="row"><span class="key">viewer chunks</span><span>${gridDims.join(' x ')} @ ${planChunkShape.join(' x ')}</span></div>
    ${nativeRow}
    <div class="row"><span class="key">transport</span><span>${html(source.transportLabel)}</span></div>
    <div class="row"><span class="key">HTTP</span><span>${httpSummary()}</span></div>
    <div class="row"><span class="key">requested</span><span>${requestedCount} / ${streamTotal}</span></div>
    <div class="row"><span class="key">completed</span><span>${completedCount} / ${streamTotal}</span></div>
    <div class="row"><span class="key">wire</span><span>${formatBytes(stats.wireBytes)}</span></div>
    <div class="row"><span class="key">decoded</span><span>${formatBytes(stats.decodedBytes)}</span></div>
    <div class="row"><span class="key">cache</span><span>${stats.cacheHits} hits, ${formatBytes(stats.cacheBytes)}</span></div>
    <div class="row"><span class="key">empty chunks</span><span>${stats.emptyChunks} absent, ${stats.emptySkips} refetches avoided</span></div>
    <div class="row"><span class="key">resident</span><span>${stream ? `${stream.resident} resident, ${stream.pending} pending, ${stream.inFlight} in flight` : 'pending'}</span></div>
    <div class="row"><span class="key">LOD comp</span><span>${html(lodCompensationSummary())}</span></div>
    <div class="row"><span class="key">failures</span><span>${failures}${cancelled}</span></div>
    <div class="row"><span class="key">last requests</span><span>${html(stats.lastRequests.join(' | ') || 'none')}</span></div>
  `
  renderChunkStrip()
}

// How long the stream must stay busy before the badge appears, and how long it
// lingers after settling. Dragging the crosshair replans continuously, and each
// replan finishes some bricks in a frame or two; without both margins the badge
// strobes on every twitch, which is worse than not having one.
const LOADING_SHOW_AFTER_MS = 180
const LOADING_LINGER_MS = 450
// A plan swap counts as "refocusing" for this long after it lands. The swap
// itself is instant; what follows is the fetch of whatever the new plan needs.
const REFOCUS_WINDOW_MS = 600

// Tell the user the view is BUSY, not broken. At high zoom a refocus can want
// bricks that take seconds to arrive, and the honest signal for that is a
// progress badge rather than a viewport that appears to have stalled. Driven
// off chunkStreamStats (authoritative residency) at the HUD's ~8 Hz poll.
function renderLoading() {
  const stream = nv?.chunkStreamStats()
  const total = stream?.total ?? 0
  const outstanding = stream ? stream.inFlight + stream.pending : 0
  const now = performance.now()

  if (outstanding > 0 && total > 0) {
    if (loadingState.since === 0) loadingState.since = now
    loadingState.until = now + LOADING_LINGER_MS
  } else {
    loadingState.since = 0
  }

  // Debounced on the way in, lingering on the way out.
  const settling = loadingState.until > now
  const busy =
    loadingState.since !== 0 &&
    now - loadingState.since >= LOADING_SHOW_AFTER_MS
  const show = busy || (settling && loadingState.label !== '')
  els.loading.classList.toggle('busy', show)
  if (!show) {
    loadingState.label = ''
    return
  }

  // A replan is the demo's own signal that the RELEVANT set just changed, which
  // is the part a user reads as "why did my zoomed view go soft".
  const label =
    now - loadingState.planEpoch < REFOCUS_WINDOW_MS
      ? 'Refocusing'
      : 'Loading blocks'
  // Only touch the live region when the wording actually changes: rewriting it
  // at 8 Hz would make a screen reader unusable.
  if (label !== loadingState.label) {
    loadingState.label = label
    els.loadingLabel.textContent = label
  }
  // Count against what the stream actually asked for, not plan.total: absent
  // and empty chunks are never fetched and the LRU may evict, so a total-based
  // bar stalls short of full even once everything relevant is in.
  const resident = stream ? stream.resident : 0
  const requested = resident + outstanding
  els.loadingCount.textContent = `${resident} / ${requested} blocks`
  els.loadingFill.style.width = `${
    requested > 0 ? Math.round((resident / requested) * 100) : 0
  }%`
}

// One line of nv.lodCompensation(). Both LOD compensation settings are exact
// no-ops on anything that is not a multi-LOD chunked volume, so the report is
// the only way to tell "the knob is doing nothing" from "the knob is doing
// nothing VISIBLE"; the HUD shows the exact exponent/scale each drawn level is
// handing the shader.
function lodCompensationSummary() {
  const report = nv?.lodCompensation()
  if (!report) return 'pending'
  if (!report.isActive) return `off (${report.inactiveReason})`
  const parts = report.levels
    .filter((l) => l.brickCount > 0 && l.downsample > 1)
    .map(
      (l) =>
        `L${l.level} k${l.downsample.toFixed(1)} x${l.brickCount} g${l.brightnessExponent.toFixed(3)} a${l.opacityScale.toFixed(2)}`,
    )
  if (report.floor && report.floor.downsample > 1) {
    parts.push(
      `floor k${report.floor.downsample.toFixed(1)} g${report.floor.brightnessExponent.toFixed(3)} a${report.floor.opacityScale.toFixed(2)}`,
    )
  }
  return parts.join(' | ') || 'active, no coarse brick drawn'
}

function chunkShapeFromPlan(plan) {
  return plan.chunks.reduce(
    (max, chunk) => [
      Math.max(max[0], chunk.texDims[0]),
      Math.max(max[1], chunk.texDims[1]),
      Math.max(max[2], chunk.texDims[2]),
    ],
    [0, 0, 0],
  )
}

function startHudPolling() {
  if (pollHandle !== 0) clearInterval(pollHandle)
  // Throttled off the render frame (~8 Hz): the stats panel and chunk strip only
  // need a periodic refresh, and rebuilding the HUD every animation frame forced
  // a reflow that competed with the WebGL render and janked rotation. syncExplode
  // still engages a deferred explode within ~120 ms of the stream settling.
  pollHandle = setInterval(() => {
    // The core NVChunkedVolume swaps the plan as the crosshair moves; mirror the
    // current plan so the HUD/block outlines and chunk strip track it. The stats
    // sets are NOT pruned on a swap: swapVolumeChunkPlan reuses resident GPU
    // textures for carried-over bricks without re-invoking fetchChunk, so pruning
    // would drop a still-resident brick that never re-records, leaving its strip
    // cell dark. Accumulating (reset only on a source switch in runReload) keeps
    // resident bricks lit; the numeric counts come from chunkStreamStats, so stale
    // out-of-plan keys never inflate a displayed count.
    if (activeCv) {
      const p = activeCv.currentPlan
      if (p !== chunkPlan) {
        chunkPlan = p
        // Stamped for the badge: what follows a swap is the fetch of whatever
        // the new plan asked for, which is the wait worth naming.
        loadingState.planEpoch = performance.now()
      }
    }
    // Reconcile the slider/label with the live zoom from any source (wheel moves
    // it with no 'change' event). syncZoomControl is UI-only and never nudges the
    // octree, so the poll cannot perpetually re-fire refocus; the wheel's own
    // replan is issued by the canvas wheel listener in main.
    syncZoomControl()
    renderHud()
    renderLoading()
    syncExplode()
  }, 120)
}

// Switch budget plan in place. The pyramid is already open and the plan is pure
// policy, so core re-folds it (the demo's pinned VRAM budget still wins), swaps
// the crosshair subscription if the focus changed, and re-plans -- no reload.
// 'uniform' stops following the crosshair, so the Zoom control no longer
// retargets the detail; that is the point of the plan, not a bug.
function applyBudgetPlan() {
  activeCv?.setBudgetPlan(els.plan.value)
}

function applyLayout() {
  if (!nv) return
  nv.sliceType = Number(els.layout.value)
  // The render-camera zoom is layout-dependent (see applyZoom): switching to or
  // from the render view must update scaleMultiplier and re-frame so the newly
  // in-frustum blocks are requested (applyZoom -> applyBlocks -> drawScene).
  applyZoom()
  renderHud()
}

// Reloads are SERIALIZED through this single promise chain: each reload awaits
// the previous one so their async scene mutations (add/remove the streamed
// volume) never interleave. `nv.loadChunkedVolume` is ADDITIVE (it adds the
// streamed NVImage rather than replacing the scene), so the demo owns removing
// the volume it displaced — see runReload.
let reloadChain = Promise.resolve()

function reloadVolume(options = {}) {
  if (!nv) return reloadChain
  // Bump the token BEFORE queueing so an already-queued (not-yet-run) reload
  // sees itself superseded and bails without mutating the scene. Every UI control
  // fires reloadVolume unawaited; without both the chain AND the token, rapid
  // source/level/window/colormap switching could leave the OLD source displayed
  // with its handle disposed, or accumulate stale streamed volumes.
  const token = ++reloadToken
  // A .catch keeps a single reload's failure from poisoning the chain for the
  // reloads queued behind it (runReload already surfaces its own errors).
  reloadChain = reloadChain
    .then(() => runReload(token, options))
    .catch((err) => console.error('reload failed:', err))
  return reloadChain
}

// Remove specific streamed NVImages from the scene. loadChunkedVolume is additive
// and there is no public single-volume controller removal, so drop them through
// the model + one GL refresh. Walk high-to-low so earlier removals don't shift
// the indices still pending.
async function removeSceneVolumes(targets) {
  if (!nv || targets.length === 0) return
  const drop = new Set(targets)
  const vols = nv.volumes
  let removed = false
  for (let i = vols.length - 1; i >= 0; i--) {
    if (drop.has(vols[i])) {
      nv.model.removeVolume(i)
      removed = true
    }
  }
  if (removed) await nv.updateGLVolume()
}

async function runReload(token, options) {
  if (!nv) return
  // Superseded while queued in the chain: a newer reload owns the scene, so do
  // nothing (do not touch activeSource/activeCv/the volume list).
  if (token !== reloadToken) return
  hideFallback()
  stats = freshStats()
  // Hard-reset the badge: the outgoing source's linger must not carry a stale
  // "N / M blocks" over the new one's first frames.
  loadingState.since = 0
  loadingState.until = 0
  loadingState.label = ''
  loadingState.planEpoch = 0
  els.loading.classList.remove('busy')
  // The fresh volume starts un-exploded; syncExplode re-applies the slider's
  // explode once this load settles.
  appliedExplodeScale = 1
  try {
    if (options.reloadSource || !activeSource) {
      activeCv?.dispose()
      activeCv = null
      activeSource = null
      chunkPlan = null
      const source = await loadActiveSource()
      if (token !== reloadToken) return
      activeSource = source
    }
    if (!activeSource) {
      throw new Error('No active source selected')
    }

    if (activeSource.kind === 'omezarr') {
      // OME-Zarr: hand the pyramid to the core crosshair-focused multi-LOD API.
      // It builds the streamed NVImage, the octree plan, the concurrency-bounded
      // per-level fetch dispatch, and follows the crosshair — all in core.
      const win = parseWindow(activeSource.defaultWindow)
      // Stop crosshair-follow on the outgoing handle; its NVImage stays in the
      // scene (captured as `stale`) until the new one is resident, so the render
      // never blanks between reloads.
      activeCv?.dispose()
      activeCv = null
      const stale = nv.volumes.slice()
      // The Level cap used for THIS load; re-read after the load to catch a
      // dropdown change made while the load was in flight (see below).
      const loadLevel = selectedLevelIndex(activeSource)
      const cv = await nv.loadChunkedVolume(
        createZarrChunkedSource(activeSource),
        {
          // Unique per load: an additive reload adds the new streamed volume while
          // the outgoing one is still resident, so a shared id/name would let
          // swapVolumeChunkPlan route a refocus to the doomed volume. The reload
          // token is monotonic, so `${name}#${token}` is unique; the human-readable
          // `name` (what the HUD/labels show) stays activeSource.name.
          id: `${activeSource.name}#${token}`,
          name: activeSource.name,
          // No window means core places one from the coarse floor; supplying
          // one suppresses that, which is what the characterised stores want.
          ...(win ? { calMin: win.min, calMax: win.max } : {}),
          colormap: els.colormap.value,
          // Policy (where the detail goes, how many bricks it may cost) comes
          // from the named plan; only the VRAM ceiling is pinned by the demo,
          // and an individual option wins over the plan by design.
          budgetPlan: els.plan.value,
          budgetBytes: MULTILOD_BUDGET_BYTES,
          // deviceLimit is omitted: core now defaults it from the host's
          // maxTextureDimension3D, which this demo sets to 256 (see the NiiVue
          // construction) -- the same value the explicit option used to pass.
          halo: streamingChunkHalo,
          minLevel: loadLevel,
          // Back the octree with a coarse whole-volume floor (core builds it from
          // the coarsest present pyramid level) so not-yet-streamed or
          // under-opaque coarse far-field regions show continuous coarse detail
          // instead of blank/see-through gaps; ?nofloor disables it for A/B.
          coarseFloor: !NO_FLOOR,
        },
      )
      if (token !== reloadToken) {
        // Superseded mid-load: tear down the volume WE added so the scene never
        // accumulates stale streamed volumes. `stale` is left for the newer
        // reload (next in the chain) to reconcile.
        cv.dispose()
        await removeSceneVolumes([cv.volume])
        return
      }
      activeCv = cv
      if (!win) {
        // Percentiles land on long floats; the field is an editable control, so
        // show a readable number rather than 15 significant digits.
        const tidy = (value) => Number(value.toPrecision(6))
        els.window.value = formatWindow({
          min: tidy(cv.volume.calMin),
          max: tidy(cv.volume.calMax),
        })
      }
      // New streamed volume is resident; drop the one(s) it displaced.
      await removeSceneVolumes(stale)
      chunkPlan = activeCv.currentPlan
      // A Level change during the load could not reach the octree (the change
      // handler no-ops while activeCv is null). Re-read the dropdown and apply
      // the cap now so the octree can't diverge from what the control shows.
      const nowLevel = selectedLevelIndex(activeSource)
      if (nowLevel !== loadLevel) activeCv.setMaxDetail(nowLevel)
    } else {
      // Synthetic: single-shard streamed volume on the legacy grid path.
      // loadVolumes REPLACES the scene, so it also clears any prior streamed
      // volume (including an outgoing OME-Zarr one); dispose its handle first.
      activeCv?.dispose()
      activeCv = null
      chunkPlan = createChunkPlan(activeSource)
      await nv.loadVolumes([createStreamingVolume(activeSource)])
      if (token !== reloadToken) return
    }

    applyLayout()
    // loadVolumes resets the camera/zoom and drops any prior boxes; reapply the
    // current zoom, focus ROI, and block outlines for the freshly loaded plan.
    applyZoom()
    // The scene extents are only known now, and each source has its own scale, so
    // re-derive the crosshair size for the volume that just landed.
    applyCrosshair()
    // loadChunkedVolume already installed the floor, but it ran while the
    // outgoing volume was still the base (this reload is additive); re-apply now
    // that the scene holds only the new one. The built floor is cached, so this
    // costs no extra fetch. The synthetic path has no pyramid, so it clears.
    if (activeSource.kind === 'omezarr' && activeCv) {
      await activeCv.applyCoarseFloor()
    } else {
      await nv.setBaseCoarseFloor(null)
    }
  } catch (err) {
    if (token !== reloadToken) return
    showFallback(err instanceof Error ? err.message : String(err))
  }
}

async function main() {
  makeDraggable(els.hud)
  // A ?plan= naming something the control does not offer leaves the markup's
  // default selected, which matches how core degrades an unknown plan name.
  els.plan.value = INITIAL_BUDGET_PLAN
  if (!els.plan.value) els.plan.value = 'uniform'
  setDefaultWindowForSelectedSource()
  await refreshLevelControl()

  nv = new NiiVue({
    backend,
    backgroundColor: [0.02, 0.03, 0.03, 1],
    isColorbarVisible: true,
    sliceType: SLICE_TYPE.MULTIPLANAR,
    maxTextureDimension3D: 256,
    maxChunkResidencyBytes: DEFAULT_RESIDENCY_BYTES,
  })
  await nv.attachToCanvas(els.canvas)
  // Browsers restore a range input's value across a reload, so push the slider's
  // current position into the fresh instance rather than assuming the default.
  applySampleRate()
  applyGamma()
  applyLodCompensation()
  applyLodOpacity()
  applyInterp()
  applyIllumination()
  applyGradientOpacity()
  applySilhouette()

  els.source.addEventListener('change', async () => {
    setDefaultWindowForSelectedSource()
    await refreshLevelControl()
    void reloadVolume({ reloadSource: true })
  })
  els.level.addEventListener('change', () => {
    // The Level control is the multi-LOD max-detail cap; the pyramid is already
    // open, so just move the cap and let core re-plan + swap in place.
    if (activeCv && activeSource) {
      activeCv.setMaxDetail(selectedLevelIndex(activeSource))
    }
  })
  els.plan.addEventListener('change', applyBudgetPlan)
  els.layout.addEventListener('change', applyLayout)
  els.colormap.addEventListener('change', () => {
    void reloadVolume()
  })
  els.window.addEventListener('change', () => {
    void reloadVolume()
  })
  // Explode is a render-time per-brick offset, not a data change, so update it
  // live on the resident volume instead of re-streaming.
  els.explode.addEventListener('input', applyExplode)
  els.zoom.addEventListener('input', applyZoom)
  els.samples.addEventListener('input', applySampleRate)
  els.gamma.addEventListener('input', applyGamma)
  els.lodComp.addEventListener('input', applyLodCompensation)
  els.lodOpacity.addEventListener('input', applyLodOpacity)
  els.interp.addEventListener('change', applyInterp)
  // Render-time settings, but the first step off 0 re-streams the working set
  // (see applyIllumination). 'input' is still right: the re-stream happens once
  // on the crossing, not per slider tick.
  els.illum.addEventListener('input', applyIllumination)
  els.gradOpacity.addEventListener('input', applyGradientOpacity)
  els.silhouette.addEventListener('input', applySilhouette)
  els.blocks.addEventListener('change', applyBlocks)
  els.crosshair.addEventListener('change', applyCrosshair)
  els.reload.addEventListener('click', () => {
    void reloadVolume({ reloadSource: true })
  })

  // Crosshair-follow (finest bricks track the crosshair) is owned by the core
  // NVChunkedVolume — no demo-side locationChange wiring needed.

  // PROGRAMMATIC zoom path: nv.scaleMultiplier / nv.pan2Dxyzmm setters emit
  // 'change'. Sync the slider UI and nudge the octree to re-plan -- unless the
  // change came from applyZoom (slider drag), which already issued its own single
  // refocus and sets zoomNudgeInApplyZoom to suppress a duplicate here.
  nv.addEventListener('change', (e) => {
    const prop = e.detail?.property
    if (prop !== 'scaleMultiplier' && prop !== 'pan2Dxyzmm') return
    syncZoomControl()
    if (!zoomNudgeInApplyZoom) activeCv?.refocus()
  })

  // WHEEL zoom path: the wheel handler mutates the zoom on the model directly, so
  // it emits no 'change' event -- the poll only syncs the slider UI from it. Issue
  // the octree re-plan here (event-driven, so no perpetual re-fire); core debounces
  // refocus, and a wheel that only steps the crosshair re-plans an unchanged zoom
  // (cheap no-op). The poll reconciles the slider/label afterward.
  els.canvas.addEventListener(
    'wheel',
    () => {
      activeCv?.refocus()
    },
    { passive: true },
  )

  await reloadVolume({ reloadSource: true })
  startHudPolling()

  // Debug hook (?debug): expose live state so the multi-LOD plan can be
  // inspected without depending on the RAF-gated render (e.g. a per-level brick
  // tally). Read-only getters over the core NVChunkedVolume handle.
  if (new URLSearchParams(location.search).has('debug')) {
    window.__r = {
      get nv() {
        return nv
      },
      get source() {
        return activeSource
      },
      get cv() {
        return activeCv
      },
      get plan() {
        return activeCv?.currentPlan ?? chunkPlan
      },
      get focus() {
        return activeCv?.focus ?? null
      },
      levelTally() {
        const t = {}
        for (const c of (activeCv?.currentPlan ?? chunkPlan)?.chunks ?? []) {
          const l = c.sourceLevel ?? 0
          t[l] = (t[l] ?? 0) + 1
        }
        return t
      },
      // Drive the focus directly (the programmatic crosshairPos setter doesn't
      // emit locationChange, so this exercises the core setFocus path).
      driveFocus(frac) {
        activeCv?.setFocus(frac)
      },
      // Re-stream the same store with a different brick halo. This is the
      // halo-vs-filter experiment: trilinear reaches 1 voxel past a brick face
      // and the tricubic filter reaches 2, so a halo of 1 lets a cubic tap land
      // on clamp-to-edge data at an internal face. Both halos can be captured
      // in one page load, on one camera, so the two frames differ ONLY in halo.
      async setHalo(n) {
        streamingChunkHalo = [n, n, n]
        await reloadVolume({ reloadSource: true })
        return streamingChunkHalo
      },
    }
  }
}

main().catch((err) => {
  showFallback(err instanceof Error ? err.message : String(err))
})
