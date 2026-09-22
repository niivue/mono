/**
 * Quick Look preview page.
 *
 * Separate from `bridge.ts` on purpose. The app's bridge is a two-way control
 * surface — drawing, saving, settings, twelve setters. A preview is read-only
 * and single-shot: the host hands over one request, the page reports back once,
 * and nothing else is ever driven from outside. Sharing `bridge.ts` here would
 * mean shipping the drawing and export paths into an extension that must not
 * have them.
 *
 * Voxel and geometry previews. NIfTI, MGH/MGZ, NRRD and MetaImage load through
 * one path — every NiiVue volume reader normalizes into a NIfTI header — into a
 * fixed 2×2 layout. GIFTI, MZ3 and the tract formats take a single fitted 3D
 * render. Both report sanitized metadata in the strip, labelled for VoiceOver.
 */
import {
  type CustomLayoutTile,
  NiiVue,
  type NVImage,
  type NVMesh,
  SHOW_RENDER,
  SLICE_TYPE,
} from '@niivue/niivue'
import {
  describeMesh,
  describeVolume,
  type VolumeSummary,
} from './preview-metadata'

/**
 * The request this page is answering. Echoed back on EVERY message, `ready`
 * included, so the host can drop one belonging to a preview it has moved past.
 *
 * The host injects `window.__qlGeneration` at document start, so this is known
 * before the first line of this module runs. That is what lets `ready` be
 * stamped too: when it could not be, a stale `ready` from the previous preview
 * set the host's `pageIsReady` for the *current* one, which dispatched a render
 * into a still-navigating page and failed a good file. The -1 fallback only
 * applies if the injection is missing, and `post()` leaves such messages
 * unstamped rather than stamping them with a sentinel the host would reject.
 */
let generation =
  (window as unknown as { __qlGeneration?: number }).__qlGeneration ?? -1

/** Native → page. One request per preview; the host never sends a second. */
export interface PreviewRequest {
  /** Opaque same-origin route to the document. Only this page can resolve it. */
  url: string
  displayName: string
  /** Bytes on disk, for the metadata strip. */
  fileSize?: number
  /** Which NiiVue loader the file needs. Classified natively, by extension. */
  family: 'volume' | 'mesh'
  /** Host request generation, echoed back on the terminal message. */
  generation?: number
}

/** Page → native. Exactly one terminal message (`loaded` or `failed`) per request. */
type HostMessage =
  | { stage: 'ready' }
  | { stage: 'loaded'; metadata: Record<string, string> }
  | { stage: 'failed'; code: FailureCode; message: string }

/**
 * Structured so the native side can react without parsing prose. Mirrored by
 * `PreviewFailure` in `PreviewViewController.swift`; the two travel as bare
 * strings, so keep them in sync.
 */
export type FailureCode =
  | 'graphics-unavailable'
  | 'unreadable'
  | 'unsupported'
  | 'timeout'
  | 'cancelled'
  | 'resource-limit'
  | 'internal'

/** One sentence per code. Concise, and never a filesystem path. */
const failureText: Record<FailureCode, string> = {
  'graphics-unavailable':
    'This Mac could not provide the graphics needed to render a preview.',
  unreadable: 'This file could not be read.',
  unsupported: 'This file type cannot be previewed.',
  timeout: 'This file took too long to load.',
  cancelled: 'The preview was cancelled.',
  'resource-limit': 'This file is too large to preview.',
  internal: 'This file could not be previewed.',
}

declare global {
  interface Window {
    niivuePreview?: {
      render(request: PreviewRequest): Promise<void>
      /** Native-detected failures, shown here so the panel is never blank. */
      fail(code: FailureCode, hostGeneration?: number): void
    }
  }
}

/**
 * `window.webkit` is deliberately NOT redeclared here. `bridge.ts` already
 * augments it for the app's own channels, and the two entries share one global
 * namespace — a second declaration is a type conflict, and widening the app's
 * channel union to include a preview-only handler would couple two pages that
 * should stay independent. A local structural cast keeps them apart.
 */
function post(message: HostMessage): void {
  const handler = (
    window as unknown as {
      webkit?: {
        messageHandlers?: { qlPreview?: { postMessage: (m: string) => void } }
      }
    }
  ).webkit?.messageHandlers?.qlPreview
  // Stamped whenever we know our generation — `ready` included, which is the
  // whole point of the host injecting it at document start.
  //
  // Left UNSTAMPED only when the injection is missing (generation still -1).
  // Stamping with the sentinel would be worse than not stamping: the host's
  // generation is never negative, so it would drop the message as stale. That
  // is what used to silently swallow `graphics-unavailable`, which fires from
  // `main()`'s catch before any request — a Mac with no working graphics sat on
  // a spinner for 10s and then got Quick Look's generic panel instead of the
  // specific explanation this page had already drawn. The host treats an absent
  // generation as "not stamped" and accepts it.
  const stamped = generation >= 0
  handler?.postMessage(
    JSON.stringify(stamped ? { ...message, generation } : message),
  )
}

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T
const stage = {
  loading: el<HTMLDivElement>('loading'),
  fallback: el<HTMLDivElement>('fallback'),
  fallbackDetail: el<HTMLDivElement>('fallback-detail'),
  meta: el<HTMLDivElement>('meta'),
}

/**
 * Resolved on every use, never cached.
 *
 * `attachToCanvas` does not keep the element it is given: NiiVue clones it and
 * calls `replaceChild` (`control/viewBoth.ts`), so any reference taken before
 * attaching points at a detached node from then on. The clone keeps the `id`,
 * which is what makes a fresh lookup correct. This is the same trap
 * `App.tsx` documents for the app's React ref — it cost this page a dead
 * `ResizeObserver` and an accessibility label written to nothing.
 */
const canvas = (): HTMLCanvasElement => el<HTMLCanvasElement>('gl')

/** Never leave a blank canvas — the product contract's hard rule. */
function showFallback(detail: string): void {
  stage.loading.hidden = true
  stage.fallback.hidden = false
  stage.fallbackDetail.textContent = detail
}

function showMetadata(name: string, pairs: Record<string, string>): void {
  stage.meta.textContent = ''
  const title = document.createElement('div')
  title.className = 'name'
  title.textContent = name
  stage.meta.append(title)
  for (const [key, value] of Object.entries(pairs)) {
    const pair = document.createElement('span')
    pair.className = 'pair'
    const strong = document.createElement('b')
    strong.textContent = value
    // The visible text abbreviates to fit a narrow panel ("fov 165×225×167 mm").
    // VoiceOver gets the unabbreviated pairing instead, because a screen reader
    // has no width constraint to justify the shorthand.
    pair.setAttribute('aria-label', `${key}: ${value}`)
    pair.append(`${key} `, strong)
    stage.meta.append(pair)
  }
  stage.meta.setAttribute(
    'aria-label',
    `${name}. ${Object.entries(pairs)
      .map(([k, v]) => `${k}: ${v}`)
      .join('. ')}`,
  )
  stage.meta.hidden = false
  // The canvas is the one thing on screen a screen reader cannot describe, so
  // it borrows the same summary rather than announcing an unlabelled graphic.
  canvas().setAttribute('aria-label', `Preview of ${name}`)
}

/**
 * The metadata strip stays visible while an overlay covers the canvas. That is
 * the product contract's "metadata fallback": the file is intact and its header
 * is worth showing, there is simply no ordinary voxel view to draw — a complex
 * or single-slice volume, say. Distinct from `fail`, which is an error.
 */
function showMetadataOnly(
  name: string,
  pairs: Record<string, string>,
  reason: string,
): void {
  showMetadata(name, pairs)
  showFallback(`No image preview for this file — ${reason}.`)
}

/**
 * Let the selection happen, then immediately unmake it.
 *
 * The distinction is the whole trick, and it is not cosmetic. Preventing a
 * selection from STARTING — `user-select: none`, or `preventDefault` on
 * `pointerdown` — also removes what absorbs the drag, and the gesture falls
 * through to the host as a window move. Clearing a selection that has already
 * started leaves WebKit in its drag-tracking mode with the pointer captured, so
 * the host still never sees the drag; there is simply no range left to paint.
 *
 * `::selection { background: transparent }` in the stylesheet handles this for
 * text and, in Playwright's WebKit, for the canvas too — but not in the real
 * Quick Look panel, where a long drag still tinted the whole page. This does
 * not depend on how any engine chooses to paint a selected replaced element,
 * because there is nothing selected by the time it would paint.
 */
function hideSelection(): void {
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection()
    // `removeAllRanges` re-fires this event; the guard makes the second pass a
    // no-op rather than a loop.
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      selection.removeAllRanges()
    }
  })
}

/*
 * There is deliberately NO `preventDefault` on `pointerdown` here.
 *
 * It looks like the right thing — NiiVue never calls it, so the gesture is
 * "unclaimed" — but suppressing the default action also suppresses the document
 * selection WebKit would otherwise start, and that selection is what keeps the
 * drag away from the host window. Adding it is what introduced the
 * window-dragging behaviour in the first place. The blue tint it was fixing is
 * handled in the stylesheet instead, by making the selection invisible rather
 * than preventing it.
 */

/*
 * There is no ResizeObserver here, deliberately. Milestone 2 added one to keep
 * the drawing buffer matched as Finder resizes the panel; it observed the
 * pre-attach canvas, so it never fired once — and the resize behaviour was
 * correct anyway, because NiiVue installs its own observer
 * (`control/interactions.ts`) and owns `devicePixelRatio`. Reinstating one here
 * would fight NiiVue for the canvas dimensions rather than help.
 */

/**
 * Exactly one terminal message per preview, from whichever of the three racing
 * sources gets there first: the load finishing, the page failing, or the host
 * calling `fail` on a timeout. The native side gates its Quick Look completion
 * too; this gate is what stops a *second* message being posted at all.
 */
let settled = false
let nv: NiiVue | undefined

/**
 * There is deliberately no abort of an in-flight load here. NiiVue owns the
 * fetch and exposes no signal, and the real cancellation path is native: Quick
 * Look tears the web view down, WebKit stops the scheme task, and
 * `PreviewSchemeHandler` returns out of its read loop. An `AbortController` on
 * this side would only look like cancellation.
 */
function fail(
  code: FailureCode,
  detail?: string,
  hostGeneration?: number,
): void {
  if (hostGeneration !== undefined) generation = hostGeneration
  if (settled) return
  settled = true
  showFallback(failureText[code])
  post({ stage: 'failed', code, message: detail ?? code })
}

/**
 * The fixed four-quadrant layout from the product contract, in reading order:
 * Axial, Coronal, Sagittal, Render. `customLayout` overrides every built-in
 * layout mode, so a preview cannot drift with NiiVue's multiplanar heuristics
 * the way `multiplanarType` would.
 */
const QUADRANTS: CustomLayoutTile[] = [
  { sliceType: SLICE_TYPE.AXIAL, position: [0, 0, 0.5, 0.5] },
  { sliceType: SLICE_TYPE.CORONAL, position: [0.5, 0, 0.5, 0.5] },
  { sliceType: SLICE_TYPE.SAGITTAL, position: [0, 0.5, 0.5, 0.5] },
  { sliceType: SLICE_TYPE.RENDER, position: [0.5, 0.5, 0.5, 0.5] },
]

/**
 * Meshes and tract bundles: one fitted 3D render filling the panel.
 *
 * No camera fitting is done here on purpose. NiiVue derives its orthographic
 * frustum from the object's own extents (`baseScale = 0.8 * furthestFromPivot`
 * in `math/NVTransforms.ts`), so `scaleMultiplier` at its default of 1 already
 * *is* the fitted view, so the preview opens framed correctly whether or not
 * the user ever drags it.
 */
async function renderMesh(
  instance: NiiVue,
  request: PreviewRequest,
): Promise<void> {
  let mesh: NVMesh
  try {
    await instance.loadMeshes([{ url: request.url, name: request.displayName }])
    if (settled) return
    if (instance.meshes.length === 0) {
      fail('unsupported', 'no mesh produced')
      return
    }
    mesh = instance.meshes[0]
  } catch (error) {
    if (settled) return
    fail('unreadable', error instanceof Error ? error.message : String(error))
    return
  }

  present(
    request,
    describeMesh(mesh, request.displayName, request.fileSize),
    () => {
      // Render-only: no slice tiles, so no custom layout either.
      instance.customLayout = null
      instance.sliceType = SLICE_TYPE.RENDER
      // Both of these earn their place on a *volume* preview and are clutter on a
      // geometry one. The crosshair marks a slice position that does not exist
      // here, and shows up as red stubs poking out of the surface; `meshXRay` gates
      // a depth-disabled pass that, with a mesh loaded, redraws the mesh over
      // itself and washes it out. Turning them off is safe in this branch
      // precisely because there are no 2D tiles — `is3DCrosshairVisible` gates
      // every crosshair, not only the 3D one.
      instance.is3DCrosshairVisible = false
      instance.meshXRay = 0
    },
  )
}

async function render(request: PreviewRequest): Promise<void> {
  if (request.generation !== undefined) generation = request.generation
  if (!nv) {
    fail('graphics-unavailable')
    return
  }
  if (request.family === 'mesh') {
    await renderMesh(nv, request)
    return
  }
  let volume: NVImage
  try {
    await nv.loadVolumes([
      {
        url: request.url,
        // Load-bearing: NiiVue infers the reader from the name, and the opaque
        // document route carries no extension of its own.
        name: request.displayName,
        // 4D files keep frame zero only. The total is still reported — see
        // `nTotalFrame4D` in the summary — so the strip stays honest about what
        // the file contains versus what is on screen.
        limitFrames4D: 1,
      },
    ])
    if (settled) return
    if (nv.volumes.length === 0) {
      fail('unsupported', 'no volume produced')
      return
    }
    volume = nv.volumes[0]
  } catch (error) {
    if (settled) return
    const message = error instanceof Error ? error.message : String(error)
    // NiiVue refuses some valid files outright — complex and 128-bit NIfTI
    // among them — and "could not be read" would blame the file for being
    // damaged when it is merely unsupported. Matching the message is coarse,
    // but it degrades to `unreadable`, which is what it would have said anyway.
    fail(
      /unsupported datatype/i.test(message) ? 'unsupported' : 'unreadable',
      message,
    )
    return
  }

  const instance = nv
  present(
    request,
    describeVolume(volume, request.displayName, request.fileSize),
    () => {
      instance.customLayout = QUADRANTS
      // Draw all three orientations at one physical scale rather than zooming
      // each to fill its quadrant, so the panels are comparable.
      instance.isEqualSize = true
      instance.isOrientationTextVisible = true
    },
  )
}

/**
 * Show a summary and post EXACTLY ONE terminal message, whatever `configure`
 * does.
 *
 * `settled` used to be latched before the drawing work, so a throw in between —
 * a lost WebGL context under memory pressure being the realistic trigger — left
 * the host with no terminal message at all, `fail()` permanently disarmed, and
 * a metadata strip over an empty canvas reported to Quick Look as a success.
 * The post now happens in a `finally`, so the only question is which message,
 * never whether there is one.
 */
function present(
  request: PreviewRequest,
  summary: VolumeSummary,
  configure: () => void,
): void {
  if (settled) return
  settled = true
  let posted = false
  try {
    stage.loading.hidden = true
    if (summary.displayable) {
      configure()
      showMetadata(request.displayName, summary.pairs)
      nv?.drawScene()
    } else {
      // A successful request that has nothing to draw. Reported as `loaded`,
      // not `failed`: the native side would replace our panel — and its
      // metadata — with Quick Look's generic one.
      showMetadataOnly(
        request.displayName,
        summary.pairs,
        summary.reason ?? 'unsupported data',
      )
    }
    // Inside the `try`, so a throw above skips it and the catch owns the
    // outcome. It cannot be in a `finally`: a `return` from the catch still
    // runs one, which posted `loaded` on top of `failed` whenever the throw
    // happened in the non-displayable branch.
    post({
      stage: 'loaded',
      metadata: { ...summary.pairs, displayable: String(summary.displayable) },
    })
    posted = true
  } catch (error) {
    showFallback(failureText.internal)
    if (!posted) {
      post({
        stage: 'failed',
        code: 'internal',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

// Installed before NiiVue is constructed so the host can always reach `fail`,
// including when the graphics context is what failed.
//
// `fail` is wrapped rather than exposed directly: the host calls it as
// `fail(code, generation)`, while the internal form takes an optional detail
// string second. Exposing the internal one would silently bind the generation
// to `detail` — the type checker caught exactly that.
window.niivuePreview = {
  render,
  fail: (code: FailureCode, hostGeneration?: number) =>
    fail(code, undefined, hostGeneration),
}

async function main(): Promise<void> {
  try {
    nv = new NiiVue({
      logLevel: 'warn',
      backgroundColor: [0, 0, 0, 1],
      // WKWebView does not expose navigator.gpu, so request WebGL2 directly
      // instead of relying on NiiVue's WebGPU-to-WebGL2 downgrade.
      backend: 'webgl2',
      isOrientCubeVisible: false,
      isRadiological: false, // "neurological orientation" from the product contract
      showRender: SHOW_RENDER.ALWAYS,
      // Centred crosshair. This is also NiiVue's default, but the contract
      // names it, and a default is not a guarantee across versions.
      crosshairPos: [0.5, 0.5, 0.5],
      // Enables the depth-disabled pass that draws the crosshair through a
      // volume render. Named for meshes; not mesh-only. See the app's bridge.ts.
      meshXRay: 0.05,
    })
    await nv.attachToCanvas(canvas())
    hideSelection()
  } catch (error) {
    // Both graphics backends are gone. The native side turns this into its own
    // fallback view; without the message it would see a black rectangle.
    nv = undefined
    fail(
      'graphics-unavailable',
      error instanceof Error ? error.message : String(error),
    )
    return
  }

  post({ stage: 'ready' })
}

void main()
