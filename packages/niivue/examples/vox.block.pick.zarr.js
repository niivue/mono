import * as zarr from 'zarrita'
import NiiVue, {
  ByteLruCache,
  omeZarrChunkedSource,
  openOmeZarr,
} from '../src/index.ts'

// Pick one brick out of an exploded STREAMED volume and open that brick, on its
// own, beside the whole heart.
//
// This is the OME-Zarr counterpart of vox.block.pick.js, and the difference is
// the whole lesson. There, the parent is an ordinary NIfTI: its voxels are in
// CPU memory, so `extractChunkBlock` can copy the picked brick out into a
// standalone NVImage. Here the parent is streamed -- its voxels only ever exist
// as GPU brick textures -- so there is nothing to copy. `extractSubVolume`
// returns null for it, by design.
//
// So the right pane does the streamed thing instead: it opens a SECOND streamed
// volume over the SAME store, cropped to the picked brick's box, and hands it
// its own multi-LOD budget. Cropping a pyramid is per-level index arithmetic
// (see cropSource), and because the crop's finest level is level 0 of the store,
// the octree in the right pane can pull the brick down to full 7.013 um
// resolution near its crosshair -- resolution the left pane never had.
//
// That matters because a brick is ALREADY one texture's worth at its own level.
// Re-fetching the picked box at the level it was drawn at would gain nothing:
// the only way to see more is to go down the pyramid, which is what a second
// octree over the cropped box does.
//
// ---------------------------------------------------------------------------
// COORDINATES: what OME-Zarr carries, and what NiiVue currently keeps
// ---------------------------------------------------------------------------
//
// A NIfTI carries its anatomical frame in sform/qform, and `extractChunkBlock`
// preserves it by walking the origin forward to the block's first voxel:
//
//     A_child = A_parent . translate(voxelOrigin)
//
// OME-NGFF's equivalent is the per-dataset `coordinateTransformations` list: a
// `scale` and a `translation`, one pair per pyramid level, in the units the
// `axes` declare. NiiVue parses both (see `parseOmeZarrAttrs`), but a STREAMED
// volume is built with `affine = diag(spacing)` -- the scale survives, the
// translation does not, and the origin is pinned at voxel [0,0,0].
//
// For THIS store that loses almost nothing: every level's translation is exactly
// half its own scale (3.5065/7.013, 7.013/14.026, ... = 0.5 at all seven
// levels), which is the voxel-CENTRE convention, not a patient/world origin. All
// seven levels are corner-aligned at world 0, so dropping it costs one global
// half-voxel and no inter-level misregistration. The readout below prints the
// declared pair for the picked brick's level so you can check that yourself.
//
// What the translation would NOT have carried, for any store, is the CROP
// origin: the right pane's volume starts at voxel [0,0,0] of the brick, so its
// mm are brick-local. This demo re-adds the offset itself (offsetMM below) to
// link the two crosshairs -- exactly the bookkeeping that `A_child = A_parent .
// translate(voxelOrigin)` does for free on the NIfTI side. See
// docs/streaming-todos.md, "OME-Zarr world origin never reaches the volume
// affine".

// Human Organ Atlas (HiP-CT) whole human heart at 7.013 um, in a public GCS
// bucket: seven levels, 91x93x123 up to 5787x5943x7865 (270 Gvoxel / 541 GB).
// Nothing past L2 fits any residency budget whole, which is why it is the right
// store for this demo. Same store the range demo streams.
const HOA_BASE =
  'https://storage.googleapis.com/ucl-hip-ct-35a68e99feaae8932b1d44da0358940b/'
const STORE_ID = 'UCL-ZCR-3341/heart/7.013um_overview_bm18.ome.zarr'
const STORE_LEVELS = [0, 1, 2, 3, 4, 5, 6]
// HiP-CT is low contrast on a high pedestal: embedding medium peaks at ~49890,
// myocardium at ~50830. A calMin in the valley drops the medium to black.
const WINDOW = { min: 50200, max: 51300 }
// 3D gradient/lighting samples one voxel past each brick face; a 3-voxel halo
// keeps that reach inside resident data so brick boundaries stay seam-free.
const HALO = [3, 3, 3]
// The lattice pins its block COUNT (see gridForBlocks), so its device limit is
// no longer what decides how many bricks there are -- it is only the ceiling on
// how big one brick's texture may get, and the coarse lattices need the full
// 256: 4 blocks over L5 is a 181x186x123 brick before halo.
const LATTICE_DEVICE_LIMIT = 256
const BLOCK_DEVICE_LIMIT = 256
const BLOCK_BUDGET_BYTES = 1_200_000_000
const ZARR_CACHE_BYTES = 256 * 1024 * 1024
// Below this many voxels on an axis a cropped level is too small to be a useful
// pyramid rung, so the crop's level list stops there (coarse end first).
const MIN_CROP_EDGE = 8

const PICK_SLOP_PX = 4 // a click that travelled further than this was a rotate

let heart = null // { zsrc, base } -- the opened store, shared by both panes
let cv1 = null // NVChunkedVolume handle for the whole-heart lattice
let cv2 = null // NVChunkedVolume handle for the picked brick
let picked = null // the last ExplodedBlockPick (+ crop metadata), or null
let latticeSeq = 0 // serializes overlapping lattice loads: last one wins
let latticeAsked = 0 // blocks requested, so the readout can flag a grown grid
let pickSeq = 0 // serializes overlapping brick loads: last pick wins
let syncing = false // re-entrancy guard for the linked crosshairs
let downX = 0
let downY = 0

const fmt3 = (v) =>
  `(${v[0].toFixed(1).padStart(9)},${v[1].toFixed(1).padStart(9)},${v[2].toFixed(1).padStart(9)})`
const fmtVox = (v) =>
  `[${Math.round(v[0]).toString().padStart(5)},${Math.round(v[1]).toString().padStart(5)},${Math.round(v[2]).toString().padStart(5)}]`
const fmtNums = (v, digits = 4) =>
  `[${v.map((x) => Number(x.toFixed(digits))).join(', ')}]`

/** Apply a flat row-major 4x4 (the matRAS convention) to a voxel coordinate. */
function applyMat(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11],
  ]
}

// `location` is window.location, so the footer is fetched explicitly.
const footer = document.getElementById('location')

// --- Block-loading indicator -------------------------------------------------
// A streamed volume is never "loaded" in one step: the octree keeps asking the
// store for bricks as the plan changes, so the honest signal is a running
// resident/requested count, not a spinner. Each pane polls its OWN instance's
// `chunkStreamStats()` (the authoritative residency), debounced on the way in
// and lingering on the way out so a one-frame fetch does not strobe the badge.
// Same discipline as the range demo's loading badge.
const LOADING_SHOW_AFTER_MS = 150
const LOADING_LINGER_MS = 450
const LOADING_POLL_MS = 120
// How long the resident count may sit still before the badge calls it done.
// `pending` is the GPU upload QUEUE, not a promise of work that finishes: the
// octree re-requests its working set every frame, so once the residency budget
// is full the queue keeps refilling and never reaches zero. A stationary
// resident count is the honest "as loaded as this pane is going to get".
const LOADING_SETTLE_MS = 900

function makeBadge(root, nv) {
  const label = root.querySelector('.label')
  const count = root.querySelector('.count')
  const fill = root.querySelector('.bar i')
  // `phase` is this demo's own pre-stream work (opening the store, cropping it).
  // There are no brick stats to report during it, so it shows as plain text.
  // `target` is the high-water mark of resident + outstanding for the current
  // episode, so the bar only ever moves forward while blocks keep arriving.
  // `armed` gates the counts: an episode reports numbers only once the stream
  // has actually asked for something, so the badge never opens on a full bar
  // left over from whatever was resident before.
  const state = {
    phase: '',
    since: 0,
    until: 0,
    text: '',
    resident: -1,
    rise: 0,
    target: 0,
    armed: false,
  }

  function write(text, resident, requested) {
    // Only touch the live region when the wording changes: rewriting it at the
    // poll rate would make a screen reader unusable.
    if (state.text !== text) {
      state.text = text
      label.textContent = text
    }
    const known = requested > 0
    count.textContent = known ? `${resident} / ${requested} blocks` : ''
    fill.style.width = known
      ? `${Math.round((resident / requested) * 100)}%`
      : '0%'
  }

  function tick() {
    const now = performance.now()
    const stream = nv.chunkStreamStats()
    const resident = stream ? stream.resident : 0
    const outstanding = stream ? stream.inFlight + stream.pending : 0
    // A falling resident count means the pane is no longer looking at what the
    // old denominator counted: the volume was replaced, or the LRU evicted. The
    // high-water mark is meaningless across that, so start it over.
    if (state.resident >= 0 && resident < state.resident) {
      state.target = 0
    }
    if (outstanding > 0) {
      state.armed = true
    }
    // Progress = the resident count moving. Note a BACKGROUNDED tab also parks
    // here: the upload pump rides requestAnimationFrame, which stops when the
    // tab is hidden, so the badge settles rather than spinning forever.
    if (resident !== state.resident) {
      state.resident = resident
      state.rise = now
    }
    const working = outstanding > 0 && now - state.rise < LOADING_SETTLE_MS
    if (working) {
      if (state.since === 0) state.since = now
      state.until = now + LOADING_LINGER_MS
    } else {
      state.since = 0
    }
    const streaming =
      (state.since !== 0 && now - state.since >= LOADING_SHOW_AFTER_MS) ||
      (state.until > now && state.text !== '')
    const show = state.phase !== '' || streaming
    root.classList.toggle('on', show)
    if (!show) {
      state.text = ''
      state.target = 0
      state.armed = false
      return
    }
    if (state.phase !== '') {
      write(state.phase, 0, 0)
      return
    }
    // Count against what the stream actually ASKED for, not the plan total:
    // absent and empty bricks are never fetched and the LRU may evict, so a
    // total-based bar stalls short of full even once everything relevant is in.
    if (!state.armed) {
      write('Loading blocks', 0, 0)
      return
    }
    state.target = Math.max(state.target, resident + outstanding)
    write('Loading blocks', resident, state.target)
  }

  return {
    tick,
    setPhase(text) {
      // Handing off from a phase to real brick counts: carry the badge across
      // the gap. The octree has not asked for anything yet at that instant, so
      // without this the badge would blink off for a frame or two.
      if (state.phase !== '' && text === '') {
        const now = performance.now()
        state.since = now - LOADING_SHOW_AFTER_MS
        state.until = now + LOADING_LINGER_MS
      }
      if (text !== '') {
        // A phase starts a new episode. Whatever the pane was counting before
        // it does not describe what is about to be loaded.
        state.target = 0
        state.armed = false
      }
      state.phase = text
      tick()
    },
  }
}

/** Open the store once; both panes read the same cached zarrita source. */
async function openHeart() {
  if (heart) return heart
  const store = zarr.withByteCaching(new zarr.FetchStore(HOA_BASE + STORE_ID), {
    cache: new ByteLruCache(ZARR_CACHE_BYTES),
  })
  // ignoreMissingLevels guards a level that is absent upstream.
  const zsrc = await openOmeZarr(store, {
    levels: STORE_LEVELS,
    ignoreMissingLevels: true,
  })
  // The library's ChunkedVolumeSource over the pyramid: bricks arrive in display
  // space (this store declares x y z, so each brick is transposed for us) with
  // channel/timepoint pinned to the first.
  heart = { zsrc, base: omeZarrChunkedSource(zsrc) }
  return heart
}

/**
 * A ChunkedVolumeSource over a sub-box of another one.
 *
 * The box is given in COMMON-grid voxels -- the finest level's grid, which is
 * the grid `pickExplodedBlock` reports a brick's `voxelOrigin`/`voxelDims` in.
 * Each level is cropped by its own downsample factor, taken from the DECLARED
 * spacing ratio (exactly 1,2,4,...,64 here) rather than from the shape ratio,
 * which only approximates it once `ceil` has rounded a level's dims.
 *
 * The box is first snapped OUT to a multiple of the coarsest kept factor, so
 * every level's crop starts on an exact voxel of that level and the cropped
 * pyramid stays mutually registered. Fetches are just the parent's with the
 * level's offset added, so a halo that reaches past the crop reads the parent's
 * real neighbouring voxels instead of zero padding.
 */
function cropSource(base, commonOrigin, commonDims) {
  const levels = base.levels
  const common = levels[0].shape
  const factors = []
  for (const lv of levels) {
    const f = [0, 1, 2].map((k) =>
      Math.max(1, Math.round(lv.spacing[k] / levels[0].spacing[k])),
    )
    // The factor has to reproduce the level's declared shape (+-1 for ceil), or
    // this is not a plain power-of-two pyramid and the crop would drift.
    const consistent = [0, 1, 2].every(
      (k) => Math.abs(Math.ceil(common[k] / f[k]) - lv.shape[k]) <= 1,
    )
    if (!consistent) break
    factors.push(f)
  }
  const coarsest = factors[factors.length - 1]
  const origin = []
  const dims = []
  for (let k = 0; k < 3; k++) {
    const lo = Math.max(
      0,
      Math.floor(commonOrigin[k] / coarsest[k]) * coarsest[k],
    )
    const hi = Math.min(
      common[k],
      Math.ceil((commonOrigin[k] + commonDims[k]) / coarsest[k]) * coarsest[k],
    )
    origin.push(lo)
    dims.push(Math.max(coarsest[k], hi - lo))
  }
  const kept = []
  for (let i = 0; i < factors.length; i++) {
    const f = factors[i]
    const off = [0, 1, 2].map((k) => Math.floor(origin[k] / f[k]))
    const shape = [0, 1, 2].map((k) =>
      Math.max(
        1,
        Math.min(Math.ceil(dims[k] / f[k]), levels[i].shape[k] - off[k]),
      ),
    )
    // Keep the finest level unconditionally: it defines the cropped volume.
    if (i > 0 && shape.some((s) => s < MIN_CROP_EDGE)) break
    kept.push({ index: i, off, shape })
  }
  return {
    datatypeCode: base.datatypeCode,
    levels: kept.map((e) => ({
      level: levels[e.index].level,
      shape: e.shape,
      spacing: levels[e.index].spacing,
    })),
    async fetchChunk(req) {
      const e = kept[req.levelIndex]
      return base.fetchChunk({
        ...req,
        levelIndex: e.index,
        texOrigin: [
          req.texOrigin[0] + e.off[0],
          req.texOrigin[1] + e.off[1],
          req.texOrigin[2] + e.off[2],
        ],
      })
    },
    // Demo metadata (not part of the ChunkedVolumeSource contract).
    cropOrigin: origin,
    cropDims: dims,
    cropLevels: kept,
  }
}

const explodeScale = () => parseInt(explode.value, 10) / 100
const isExploded = () => explodeScale() > 1.001

function applyExplode() {
  const vol = nv1.volumes?.[0]
  if (!vol) return
  const scale = explodeScale()
  vol.chunkExplode = isExploded()
    ? { enabled: true, scale: [scale, scale, scale] }
    : { enabled: false }
  explodeVal.textContent = isExploded() ? `${scale.toFixed(2)}x` : 'off'
  // Exploding grows the drawn extent past the volume's own bounds, so pull the
  // camera back by the same factor: the separated bricks stay framed.
  nv1.scaleMultiplier = 1 / scale
  // The outline is drawn in EXPLODED mm, so a changed offset invalidates it.
  if (picked) clearPick()
  nv1.drawScene()
  updateHint()
}

function updateHint() {
  if (!cv1) {
    hint.innerHTML = 'Streaming the heart from the Human Organ Atlas bucket...'
    return
  }
  if (!isExploded()) {
    hint.innerHTML =
      '<span class="warn">Raise <b>Explode</b> above 1.00x</span> to separate the bricks and make them pickable.'
    return
  }
  hint.innerHTML = picked
    ? `Showing brick <b>#${picked.chunkIndex}</b>, re-streamed from level 0 up. Click another brick, or move either crosshair.`
    : '<b>Click a brick</b> in the left render to re-stream just that box at full resolution.'
}

function clearPick() {
  picked = null
  pickSeq++
  cv2?.dispose()
  cv2 = null
  nv1.focusBox = null
  nv2.removeAllVolumes()
  blockOut.textContent = 'No brick picked yet.'
  nv1.drawScene()
  updateHint()
}

/** Finest-first index of a dataset level, which is what `minLevel` takes. */
function levelIndexOf(base, datasetLevel) {
  const i = base.levels.findIndex((l) => l.level === datasetLevel)
  return i < 0 ? 0 : i
}

/**
 * Split `n` blocks into a per-axis grid whose blocks come out as close to cubic
 * as this level's shape allows: of every factorization of `n` into three
 * factors, keep the one whose block edges have the smallest max/min ratio.
 *
 * This is why the planner takes a per-axis `gridDims` rather than a block size.
 * A single edge length cannot produce an arbitrary count on a volume that is not
 * a cube: 9 blocks over L5's 181x186x246 is 1x3x3, and no scalar edge yields
 * that (the counts it can reach here go 1, 2, 8, 12, 27...). Asking for a count
 * only means something if each axis can be divided on its own.
 */
function gridForBlocks(shape, n) {
  let best = null
  for (let gx = 1; gx <= n; gx++) {
    if (n % gx !== 0) continue
    const rest = n / gx
    for (let gy = 1; gy <= rest; gy++) {
      if (rest % gy !== 0) continue
      const grid = [gx, gy, rest / gy]
      const edges = shape.map((d, a) => d / grid[a])
      const score = Math.max(...edges) / Math.min(...edges)
      if (best === null || score < best.score) best = { grid, score }
    }
  }
  return best.grid
}

async function loadLattice() {
  const seq = ++latticeSeq
  clearPick()
  badge1.setPhase('Opening the store')
  updateHint()
  try {
    const { base } = await openHeart()
    if (seq !== latticeSeq) return
    // The store is open; from here the badge reports real brick counts.
    badge1.setPhase('')
    cv1?.dispose()
    cv1 = null
    nv1.removeAllVolumes()
    // `gridDims` pins the lattice: an EXACT grid of equal bricks, every one
    // drawn from the chosen level, so the block count is the one the user picked
    // instead of whatever falls out of the brick size and the pyramid. That is
    // what makes the lattice worth picking out of -- and it is stable, since
    // there is no octree left to re-plan.
    //
    // 'uniform' still matters for its focus: 'none'. A crosshair focus would
    // subscribe `locationChange` and re-plan on every crosshair move, and while
    // the plan would come back identical, the work (and the churn) would not.
    const levelIndex = levelIndexOf(base, parseInt(lattice.value, 10))
    latticeAsked = parseInt(blocks.value, 10)
    cv1 = await nv1.loadChunkedVolume(base, {
      id: `heart-lattice#${seq}`,
      name: 'HOA human heart',
      calMin: WINDOW.min,
      calMax: WINDOW.max,
      colormap: 'gray',
      budgetPlan: 'uniform',
      gridDims: gridForBlocks(base.levels[levelIndex].shape, latticeAsked),
      deviceLimit: LATTICE_DEVICE_LIMIT,
      halo: HALO,
      minLevel: levelIndex,
      coarseFloor: true,
    })
    if (seq !== latticeSeq) {
      cv1.dispose()
      cv1 = null
      return
    }
    applyExplode()
    reportParent()
  } catch (err) {
    parentOut.textContent = `Could not open the store: ${err?.message ?? err}`
  } finally {
    if (seq === latticeSeq) badge1.setPhase('')
  }
  updateHint()
}

async function pickAt(clientX, clientY) {
  const hit = nv1.pickExplodedBlock(clientX, clientY)
  if (!hit) return // empty space, or not over the render tile
  const vol = nv1.volumes[hit.volumeIndex]
  const desc = vol?.chunkPlan?.chunks[hit.chunkIndex]
  if (!desc) return
  const { base } = await openHeart()

  const seq = ++pickSeq
  picked = hit
  // `sourceLevel` is the pyramid level this brick was DRAWN from; the crop below
  // starts again at level 0, which is the whole point of the right pane.
  picked.sourceLevel = desc.sourceLevel ?? 0
  // Outline the picked brick in place, in the same EXPLODED mm the render uses.
  nv1.focusBox = {
    min: hit.explodedMin,
    max: hit.explodedMax,
    color: [1, 0.83, 0.28, 1],
    thickness: 2,
  }
  nv1.drawScene()
  reportParent()
  updateHint()

  badge2.setPhase('Cropping the store')
  try {
    const crop = cropSource(base, hit.voxelOrigin, hit.voxelDims)
    // The crop pyramid exists; the rest of the wait is brick fetches.
    badge2.setPhase('')
    picked.crop = crop
    cv2?.dispose()
    cv2 = null
    nv2.removeAllVolumes()
    // 'focus' follows this pane's own crosshair, so the box gets its finest
    // bricks wherever you look inside it -- down to level 0, i.e. 7.013 um.
    const handle = await nv2.loadChunkedVolume(crop, {
      id: `heart-brick#${seq}`,
      name: `brick ${hit.chunkIndex}`,
      calMin: WINDOW.min,
      calMax: WINDOW.max,
      colormap: 'gray',
      budgetPlan: 'focus',
      budgetBytes: BLOCK_BUDGET_BYTES,
      deviceLimit: BLOCK_DEVICE_LIMIT,
      halo: HALO,
      minLevel: 0,
      coarseFloor: true,
    })
    if (seq !== pickSeq) {
      handle.dispose()
      return
    }
    cv2 = handle
    // Both streamed volumes are axis-aligned at the same finest spacing, so the
    // parent<->crop mapping is a pure translation. Derive it from the two
    // matRAS rather than assuming diag(spacing), so it stays right if core ever
    // starts writing the NGFF translation into the affine.
    const parentMat = nv1.volumes?.[0]?.matRAS
    const cropMat = handle.volume?.matRAS
    picked.offsetMM =
      parentMat && cropMat
        ? applyMat(parentMat, crop.cropOrigin).map(
            (v, k) => v - applyMat(cropMat, [0, 0, 0])[k],
          )
        : [0, 0, 0]
    // Open the brick pane on the voxel that was clicked, expressed in the crop's
    // own mm. When linked, move the parent there too, so both panes start on the
    // same point of the heart.
    syncing = true
    nv2.setCrosshairPos(hit.mm.map((v, k) => v - picked.offsetMM[k]))
    if (linkCheck.checked) nv1.setCrosshairPos(hit.mm)
    syncing = false
    reportBlock()
    reportParent()
    updateHint()
  } catch (err) {
    blockOut.textContent = `Could not stream the brick: ${err?.message ?? err}`
  } finally {
    if (seq === pickSeq) badge2.setPhase('')
  }
}

/**
 * The lattice line: what was built, and -- when an axis had to grow because a
 * block would have overflowed the device texture limit at this level -- what was
 * asked for. Growing is the planner's only honest move there: fewer blocks means
 * bigger ones, and a block over the limit would be clamped and sample squashed.
 */
function latticeLine(plan, drawn) {
  const built = plan?.chunks.length ?? 0
  const grid = plan?.gridDims ?? [1, 1, 1]
  const grown =
    built !== latticeAsked
      ? `  (asked ${latticeAsked}; grown to fit ${LATTICE_DEVICE_LIMIT}-voxel bricks)`
      : ''
  return `${built} bricks ${grid.join('x')} from L${drawn}${grown}`
}

function reportParent() {
  const vol = nv1.volumes?.[0]
  if (!vol) return
  const plan = vol.chunkPlan
  const levels = heart?.base.levels ?? []
  const common = levels[0]?.shape ?? [0, 0, 0]
  const mm = nv1.getCrosshairPos()
  const drawn = plan?.chunks[0]?.sourceLevel ?? 0
  const lines = [
    `<span class="k">crosshair  </span> ${fmt3(mm)} um`,
    `<span class="k">common grid</span> ${common.join(' x ')} vox @ ${(levels[0]?.spacing ?? [0]).map((s) => s.toFixed(3)).join(' x ')} um   (level 0)`,
    `<span class="k">lattice    </span> ${latticeLine(plan, drawn)}   explode ${isExploded() ? `${explodeScale().toFixed(2)}x` : 'off'}`,
  ]
  lines.push(
    picked
      ? `<span class="k">picked     </span> <span class="hi">#${picked.chunkIndex}</span> from L${picked.sourceLevel}  origin ${fmtVox(picked.voxelOrigin)}  dims ${picked.voxelDims.join(' x ')} (common vox)`
      : '<span class="k">picked     </span> none',
  )
  parentOut.innerHTML = lines.join('\n')
}

function reportBlock() {
  const crop = picked?.crop
  const vol = nv2.volumes?.[0]
  if (!crop || !vol) {
    blockOut.textContent = 'No brick picked yet.'
    return
  }
  const mm = nv2.getCrosshairPos()
  const parentMM = mm.map((v, k) => v + picked.offsetMM[k])
  const finest = crop.levels[0]
  const coarsest = crop.levels[crop.levels.length - 1]
  const live = vol.chunkPlan
  const liveLevels = live
    ? [...new Set(live.chunks.map((c) => c.sourceLevel ?? 0))].sort(
        (a, b) => a - b,
      )
    : []
  // The store's own coordinate transform for the level this brick was drawn at:
  // the OME-NGFF answer to "what is the sform/qform of an OME-Zarr?".
  const ds = heart?.zsrc.info.datasets[picked.sourceLevel]
  const axes = (heart?.zsrc.info.axes ?? []).map((a) => a.name).join(',')
  const unit = heart?.zsrc.info.axes?.[0]?.unit ?? '?'
  const ratio =
    ds?.scale && ds?.translation
      ? ds.translation.map((t, i) => t / (ds.scale[i] || 1))
      : null
  blockOut.innerHTML = [
    `<span class="k">crosshair  </span> ${fmt3(mm)} um  <span class="k">crop-local</span>`,
    `<span class="k">  + offset </span> ${fmt3(parentMM)} um  <span class="hi">= the parent's um</span>`,
    `<span class="k">crop box   </span> origin ${fmtVox(crop.cropOrigin)}  dims ${crop.cropDims.join(' x ')} (common vox)`,
    `<span class="k">crop pyramid</span> ${crop.levels.length} levels: L${finest.level} ${finest.shape.join('x')} .. L${coarsest.level} ${coarsest.shape.join('x')}`,
    `<span class="k">drawn from </span> <span class="hi">${liveLevels.length ? liveLevels.map((l) => `L${l}`).join(' + ') : '-'}</span>  (${live?.chunks.length ?? 0} bricks)  vs L${picked.sourceLevel} on the left`,
    `<span class="k">NGFF L${picked.sourceLevel}   </span> axes ${axes} (${unit})  scale ${ds?.scale ? fmtNums(ds.scale) : 'none'}`,
    `<span class="k">           </span> translation ${ds?.translation ? fmtNums(ds.translation) : 'none'}${ratio ? `  = ${fmtNums(ratio, 3)} x scale (voxel centres)` : ''}`,
  ].join('\n')
}

// The two panes hold the same anatomy at the same spacing, but the crop's origin
// is NOT in its affine, so linking needs the offset this demo computed. On the
// NIfTI side (vox.block.pick.js) the same link is a straight mm copy, because
// `extractChunkBlock` writes the origin into the copy's sform/qform.
function linkFromParent(mm) {
  if (!linkCheck.checked || syncing || !picked?.crop) return
  const local = mm.map((v, k) => v - picked.offsetMM[k])
  const vol = nv2.volumes?.[0]
  if (!vol?.dimsRAS) return
  const maxMM = applyMat(vol.matRAS, [
    vol.dimsRAS[1] - 1,
    vol.dimsRAS[2] - 1,
    vol.dimsRAS[3] - 1,
  ])
  for (let k = 0; k < 3; k++) {
    if (local[k] < 0 || local[k] > maxMM[k]) return // outside this brick
  }
  syncing = true
  nv2.setCrosshairPos(local)
  syncing = false
}

function linkFromBlock(mm) {
  if (!linkCheck.checked || syncing || !picked?.offsetMM) return
  syncing = true
  nv1.setCrosshairPos(mm.map((v, k) => v + picked.offsetMM[k]))
  syncing = false
}

lattice.onchange = () => {
  loadLattice()
}

blocks.onchange = () => {
  loadLattice()
}

explode.oninput = () => {
  applyExplode()
  reportParent()
}

blockView.onchange = () => {
  nv2.sliceType = parseInt(blockView.value, 10)
}

linkCheck.onchange = () => {
  if (linkCheck.checked) linkFromParent(nv1.getCrosshairPos())
}

// Texture reconstruction in the 3D fine march: hardware trilinear (default) or
// a C2 tricubic B-spline. Cubic removes the trilinear texel staircase at brick
// scale, which is exactly what a re-streamed block is for -- and this demo's
// bricks carry HALO voxels of real neighbour data on every face, so the cubic
// filter's 2-voxel reach is fed genuine values rather than clamp-to-edge. Pure
// render-time setting on both panes: no re-stream, and the setter redraws.
function applyInterp() {
  const cubic = interp.value === 'cubic'
  nv1.volumeIsCubicInterpolation = cubic
  nv2.volumeIsCubicInterpolation = cubic
}

interp.onchange = applyInterp

clearBtn.onclick = clearPick

backend.onchange = async () => {
  const b = backend.value
  clearPick()
  await nv1.reinitializeView({ backend: b })
  await nv2.reinitializeView({ backend: b })
  applyInterp()
  applyExplode()
  reportParent()
}

// Optional `?backend=webgl2` (or webgpu) to pick the initial backend; the select
// mirrors it and can still switch at runtime.
const initialBackend =
  new URLSearchParams(window.location.search).get('backend') === 'webgl2'
    ? 'webgl2'
    : 'webgpu'
backend.value = initialBackend

const nv1 = new NiiVue({
  backgroundColor: [0.08, 0.09, 0.11, 1],
  backend: initialBackend,
  sliceType: 4, // SLICE_TYPE.RENDER
  isColorbarVisible: false,
  // Brick textures are capped by the host limit; the per-load `deviceLimit`
  // above picks the actual edge, so this only has to be no smaller.
  maxTextureDimension3D: 512,
})
const nv2 = new NiiVue({
  backgroundColor: [0.08, 0.09, 0.11, 1],
  backend: initialBackend,
  sliceType: parseInt(blockView.value, 10),
  isColorbarVisible: false,
  maxTextureDimension3D: 512,
  placeholderText: 'Click a brick on the left',
})

nv1.addEventListener('locationChange', (e) => {
  linkFromParent(e.detail.mm)
  reportParent()
  footer.innerHTML = `&nbsp;&nbsp;heart: ${e.detail.string}`
})
nv2.addEventListener('locationChange', (e) => {
  linkFromBlock(e.detail.mm)
  reportBlock()
  footer.innerHTML = `&nbsp;&nbsp;brick: ${e.detail.string}`
})

// A left-drag on the render tile rotates the scene, so only a click that did not
// travel is treated as a pick.
gl1.addEventListener('mousedown', (e) => {
  downX = e.clientX
  downY = e.clientY
})
gl1.addEventListener('click', (e) => {
  if (Math.abs(e.clientX - downX) > PICK_SLOP_PX) return
  if (Math.abs(e.clientY - downY) > PICK_SLOP_PX) return
  pickAt(e.clientX, e.clientY)
})

await nv1.attachToCanvas(gl1)
await nv2.attachToCanvas(gl2)
applyInterp()
const badge1 = makeBadge(busy1, nv1)
const badge2 = makeBadge(busy2, nv2)
setInterval(() => {
  badge1.tick()
  badge2.tick()
}, LOADING_POLL_MS)
updateHint()
await loadLattice()
