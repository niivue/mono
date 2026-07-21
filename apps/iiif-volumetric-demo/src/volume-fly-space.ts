// Volume Fly Space: WASD-fly through a constellation of NIfTI volumes rendered
// in a single shared 3D scene via niivue `space: 'global3d'` instances.
// Streams source volumes from /api, prefetches low-resolution variants and
// exploded subvolume cells to keep the next bricks warm as the camera moves.

import type {
  ImageFromUrlOptions,
  NVGlobalCamera,
  NVInstance,
} from '@niivue/niivue'
import NiiVue from '@niivue/niivue'

import { getBackendFromUrl } from './backend'
import { installNav } from './nav'

installNav()

const BACKEND = getBackendFromUrl()

const ACTIVE_VOLUME_COUNT = 14
const ACTIVE_MOVING_VOLUME_COUNT = 8
const ACTIVE_MIN_VOLUME_COUNT = 6
const NODE_COUNT = 120
const LOAD_TIMEOUT_MS = 60000
const ACTIVE_RELOAD_MS = 1250
const ACTIVE_MOVING_RETRY_MS = 240
const ACTIVE_TRIM_COOLDOWN_MS = 650
const ACTIVE_CANDIDATE_MULTIPLIER = 2.4
const ACTIVE_STICKY_MS = 2800
const FRAME_BUDGET_MS = 26
const FRAME_RECOVERY_MS = 2600
const RAYTRACE_ENTER_DISTANCE = 68
const RAYTRACE_MOVING_ENTER_DISTANCE = 48
const RAYTRACE_EXIT_MARGIN = 30
const LOD_UPGRADE_BATCH_SIZE = 3
const PREFETCH_VOLUME_COUNT = 36
const PREFETCH_CONCURRENCY = 3
const PREFETCH_QUEUE_LIMIT = 64
const PREFETCH_BUFFER_LIMIT = 48
const PREFETCH_RETRY_MS = 18000
const SUBVOLUME_GRID = { nx: 3, ny: 3, nz: 3, ex: 1, ey: 1, ez: 1 }
const SUBVOLUME_PREFETCH_VOLUME_COUNT = 10
const SUBVOLUME_PREFETCH_CELLS_PER_NODE = 5
const SUBVOLUME_PREFETCH_LIMIT = 220
const SUBVOLUME_FRONT_BIAS = 18
const OCCUPANCY_BLOCK_SIZE = 16
const FAR_DEPTH = 360
const FOCAL_LENGTH = 640
const CAMERA_POSITION_SMOOTHING = 14
const CAMERA_ROTATION_SMOOTHING = 18
const CAMERA_ACCELERATION = 10
const CAMERA_IDLE_DRIFT = 0.1
const MOTION_SPEED_THRESHOLD = 2.2
const MOTION_ANGULAR_THRESHOLD = 0.004
const MOTION_UPGRADE_DELAY_MS = 650
const LABEL_MOVING_THROTTLE_MS = 100
const LABEL_SETTLED_THROTTLE_MS = 140
const LABEL_MOVING_MARKER_LIMIT = 14
const LABEL_SETTLED_MARKER_LIMIT = 26
const LABEL_SETTLED_TEXT_LIMIT = 14
const RADAR_RANGE = 92
const TWO_PI = Math.PI * 2
const VOLUMETRIC_NS = 'https://example.org/iiif/volumetric#'

interface ApiVolumeLevel {
  level: number
  ready?: boolean
}

interface ApiVolume {
  id: string
  format: string
  shape?: number[]
  levels?: ApiVolumeLevel[]
}

interface ApiCatalog {
  volumes?: ApiVolume[]
  niivue?: { mounted?: boolean }
}

interface SceneNode {
  id: string
  index: number
  volume: ApiVolume
  x: number
  y: number
  z: number
  scale: number
  orientation: [number, number, number]
  targetLevel: number
  volumeKey: string
  distance: number
  visibleRank: number
  lastVisibleAt: number
  projected: { x: number; y: number; scale: number; depth: number } | null
}

interface CameraState {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  speed: number
  fov: number
}

interface MotionState {
  vx: number
  vy: number
  vz: number
  speed: number
  angularSpeed: number
  lastMeaningfulMotionAt: number
}

interface PerfState {
  frameMs: number
  activeLimit: number
  lastOverBudgetAt: number
  lastLimitChangeAt: number
  lastTrimAt: number
}

interface RenderSlot {
  node: SceneNode
  level: number
  volumeKey: string
}

interface PrefetchJob {
  kind: 'volume' | 'subvolume'
  key: string
  level: number
  volume: ApiVolume
  distance: number
  priority: number
  url: string
}

interface SubvolumeModel {
  url: string
  level: number
  bbox: number[]
  meta: SubvolumeMeta
}

interface SubvolumeMeta {
  gridIndex?: number[] | null
  sourceBbox?: number[]
  [key: string]: unknown
}

interface SubvolumeCell {
  id: string
  center: [number, number, number]
  gridIndex: number[] | null
  sourceBbox: number[]
  models: SubvolumeModel[]
}

interface SubvolumePlan {
  status: 'loading' | 'ready' | 'failed'
  cells: SubvolumeCell[]
  promise: Promise<SubvolumePlan> | null
  failedAt: number
  volumeId?: string
  sceneSize?: [number, number, number]
  sceneCenter?: [number, number, number]
}

interface OccupancyGrid {
  status: 'loading' | 'ready' | 'failed'
  data: Uint8Array | null
  dims: [number, number, number] | null
  blockSize: number
  failedAt: number
}

interface PointerState {
  id: number
  lastX: number
  lastY: number
}

interface DrawState {
  width: number
  height: number
  dpr: number
}

interface LabelLayer {
  canvas: HTMLCanvasElement
  lastUpdate: number
  signature: string
}

interface WarmIndex {
  volumeLevels: Map<string, number>
  subvolumeReady: Set<string>
  warming: Set<string>
}

interface VolumeWindow {
  calMin: number
  calMax: number
}

interface VolumeExtents {
  min: [number, number, number]
  max: [number, number, number]
}

interface AppState {
  api: ApiCatalog | null
  nv: NiiVueLike | null
  volumes: ApiVolume[]
  nodes: SceneNode[]
  visible: SceneNode[]
  activeNodes: SceneNode[]
  nearest: SceneNode | null
  running: boolean
  keys: Set<string>
  pointer: PointerState | null
  loadingSignature: string
  loadedSignature: string
  loadedSourceKeys: Set<string>
  volumeWindow: Map<string, VolumeWindow>
  volumeExtents: Map<string, VolumeExtents>
  instanceSignature: string
  cameraSignature: string
  renderLevels: Map<string, number>
  activeReloadTimer: number
  loadRequestId: number
  prefetchQueue: PrefetchJob[]
  prefetching: Set<string>
  prefetched: Set<string>
  prefetchFiles: Map<string, File>
  prefetchOrder: string[]
  prefetchedSubvolumes: Set<string>
  prefetchSubvolumeOrder: string[]
  prefetchFailedAt: Map<string, number>
  subvolumePlans: Map<string, SubvolumePlan>
  subvolumeOccupancy: Map<string, OccupancyGrid>
  lastFrame: number
  draw: DrawState
  labels: LabelLayer
  camera: CameraState
  renderCamera: CameraState
  motion: MotionState
  performance: PerfState
}

// Structural view of the NiiVue methods we touch. Avoids leaking the giant
// niivue class shape into demo code while keeping access type-checked.
interface NiiVueLike {
  opts: {
    isInteractionEnabled: boolean
    isDragDropEnabled: boolean
    globalCamera?: NVGlobalCamera
  }
  sliceType: number
  model: {
    addVolume(volume: ImageFromUrlOptions): Promise<void>
    removeVolume(index: number): void
    getVolumes(): {
      name?: string
      calMin?: number
      calMax?: number
      extentsMin?: ArrayLike<number>
      extentsMax?: ArrayLike<number>
    }[]
  }
  attachToCanvas(canvas: HTMLCanvasElement): Promise<unknown>
  setInstances(instances: NVInstance[]): void
  setGlobalCamera(camera: NVGlobalCamera): void
  updateGLVolume(): Promise<void>
  drawScene(): void
  resize?: () => void
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  space: el<HTMLElement>('space'),
  canvas: el<HTMLCanvasElement>('global-volume-canvas'),
  backdrop: el<HTMLCanvasElement>('space-backdrop'),
  subtitle: el<HTMLParagraphElement>('scene-subtitle'),
  statusVisible: el<HTMLSpanElement>('status-visible'),
  statusLoaded: el<HTMLSpanElement>('status-loaded'),
  statusQueue: el<HTMLSpanElement>('status-queue'),
  statusSpeed: el<HTMLSpanElement>('status-speed'),
  quality: el<HTMLSelectElement>('quality'),
  speed: el<HTMLInputElement>('speed'),
  pause: el<HTMLButtonElement>('pause'),
  recenter: el<HTMLButtonElement>('recenter'),
  nearNative: el<HTMLInputElement>('near-native'),
  showTitles: el<HTMLInputElement>('show-titles'),
  nearestTitle: el<HTMLHeadingElement>('nearest-title'),
  nearestDistance: el<HTMLElement>('nearest-distance'),
  nearestLod: el<HTMLElement>('nearest-lod'),
  nearestShape: el<HTMLElement>('nearest-shape'),
  nearestFormat: el<HTMLElement>('nearest-format'),
  radar: el<HTMLCanvasElement>('radar'),
}

const state: AppState = {
  api: null,
  nv: null,
  volumes: [],
  nodes: [],
  visible: [],
  activeNodes: [],
  nearest: null,
  running: true,
  keys: new Set(),
  pointer: null,
  loadingSignature: '',
  loadedSignature: '',
  loadedSourceKeys: new Set(),
  volumeWindow: new Map(),
  volumeExtents: new Map(),
  instanceSignature: '',
  cameraSignature: '',
  renderLevels: new Map(),
  activeReloadTimer: 0,
  loadRequestId: 0,
  prefetchQueue: [],
  prefetching: new Set(),
  prefetched: new Set(),
  prefetchFiles: new Map(),
  prefetchOrder: [],
  prefetchedSubvolumes: new Set(),
  prefetchSubvolumeOrder: [],
  prefetchFailedAt: new Map(),
  subvolumePlans: new Map(),
  subvolumeOccupancy: new Map(),
  lastFrame: 0,
  draw: { width: 1, height: 1, dpr: 1 },
  labels: {
    canvas: document.createElement('canvas'),
    lastUpdate: 0,
    signature: '',
  },
  camera: { x: 0, y: 0, z: 34, yaw: 0, pitch: -0.05, speed: 14, fov: 55 },
  renderCamera: { x: 0, y: 0, z: 34, yaw: 0, pitch: -0.05, speed: 14, fov: 55 },
  motion: {
    vx: 0,
    vy: 0,
    vz: 0,
    speed: 0,
    angularSpeed: 0,
    lastMeaningfulMotionAt: 0,
  },
  performance: {
    frameMs: 16.7,
    activeLimit: ACTIVE_VOLUME_COUNT,
    lastOverBudgetAt: 0,
    lastLimitChangeAt: 0,
    lastTrimAt: 0,
  },
}

;(window as unknown as { __flyState: AppState }).__flyState = state

main().catch((err: unknown) => {
  showFatal(err)
})

async function main(): Promise<void> {
  setupEvents()
  resizeCanvases()
  els.subtitle.textContent = 'Loading API catalog'
  state.api = (await fetchJson('/api')) as ApiCatalog
  state.volumes = (state.api.volumes ?? []).filter(
    (volume) => volume.format === 'nifti',
  )
  if (state.volumes.length === 0)
    throw new Error('No NIfTI volumes are registered in /api.')

  els.subtitle.textContent = 'Starting global niivue renderer'
  // mono's @niivue/niivue is the in-tree replacement for the POC's
  // /vendor/niivue/niivue.webgl2.js entry. enableInteraction /
  // disableInteraction no longer exist; we set opts.isInteractionEnabled to
  // false in the constructor and skip any runtime toggles. Backend is
  // chosen at runtime from ?backend=webgl2|webgpu (default webgl2).
  const nv = new NiiVue({
    backend: BACKEND,
    backgroundColor: [0, 0, 0, 1],
    isColorbarVisible: false,
    isDragDropEnabled: false,
    isInteractionEnabled: false,
    is3DCrosshairVisible: false,
    showBoundsBorder: false,
    sliceType: 4,
    volumeIllumination: 0.72,
    volumeTransmittanceCutoff: 0.99,
    volumeIsNearestInterpolation: false,
    globalCamera: cameraPayload(),
  }) as unknown as NiiVueLike

  nv.opts.isInteractionEnabled = false
  nv.opts.isDragDropEnabled = false
  await nv.attachToCanvas(els.canvas)
  nv.sliceType = 4
  state.nv = nv
  state.nodes = createVolumeNodes(state.volumes)
  els.subtitle.textContent = `${state.nodes.length} positioned volumes in one niivue scene`
  requestAnimationFrame(tick)
}

function setupEvents(): void {
  window.addEventListener('resize', resizeCanvases)
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (isTypingTarget(event.target)) return
    if (event.repeat) return
    if (event.code === 'Space') {
      event.preventDefault()
      togglePause()
      return
    }
    state.keys.add(event.code)
  })
  window.addEventListener('keyup', (event: KeyboardEvent) => {
    state.keys.delete(event.code)
  })

  els.space.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    els.space.setPointerCapture(event.pointerId)
    els.canvas.focus()
    state.pointer = {
      id: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
    }
  })
  els.space.addEventListener('pointermove', (event: PointerEvent) => {
    if (!state.pointer || state.pointer.id !== event.pointerId) return
    event.preventDefault()
    const dx = event.clientX - state.pointer.lastX
    const dy = event.clientY - state.pointer.lastY
    state.pointer.lastX = event.clientX
    state.pointer.lastY = event.clientY
    state.camera.yaw += dx * 0.004
    state.camera.pitch = clamp(state.camera.pitch - dy * 0.003, -1.18, 1.18)
  })
  for (const type of ['pointerup', 'pointercancel'] as const) {
    els.space.addEventListener(type, (event: PointerEvent) => {
      if (!state.pointer || state.pointer.id !== event.pointerId) return
      try {
        els.space.releasePointerCapture(event.pointerId)
      } catch (_err) {
        // The browser may already have released capture.
      }
      state.pointer = null
    })
  }
  els.space.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      event.preventDefault()
      const next = Number(els.speed.value) * Math.exp(-event.deltaY * 0.001)
      els.speed.value = String(Math.round(clamp(next, 2, 36)))
      updateSpeed()
    },
    { passive: false },
  )

  els.speed.addEventListener('input', updateSpeed)
  els.quality.addEventListener('change', requestActiveReload)
  els.nearNative.addEventListener('change', requestActiveReload)
  els.showTitles.addEventListener('change', resetLabelLayer)
  els.pause.addEventListener('click', togglePause)
  els.recenter.addEventListener('click', recenterCamera)
  updateSpeed()
}

function createVolumeNodes(volumes: ApiVolume[]): SceneNode[] {
  const nodes: SceneNode[] = []
  const sorted = volumes.slice().sort((a, b) => a.id.localeCompare(b.id))
  for (let i = 0; i < NODE_COUNT; i++) {
    const volume = sorted[i % sorted.length]
    if (!volume) continue
    const ring = Math.floor(i / 14)
    const lane = i % 14
    const angle = lane * (TWO_PI / 14) + ring * 0.34
    const radius = 11 + ring * 3.7 + (i % 5) * 0.85
    const z = -18 - ring * 21 - lane * 1.4
    const y = (((i * 7) % 13) - 6) * 1.85 + Math.sin(i * 0.53) * 1.3
    nodes.push({
      id: `node-${i}`,
      index: i,
      volume,
      x: Math.cos(angle) * radius,
      y,
      z,
      scale: 7.2 + (i % 4) * 0.72,
      orientation: [
        Math.sin(i * 0.29) * 0.08,
        angle + Math.PI + Math.sin(i * 0.31) * 0.2,
        Math.cos(i * 0.23) * 0.1,
      ],
      targetLevel: 0,
      volumeKey: '',
      distance: 0,
      visibleRank: Number.POSITIVE_INFINITY,
      lastVisibleAt: 0,
      projected: null,
    })
  }
  return nodes
}

function tick(now: number): void {
  const dt = Math.min(0.05, ((now || 0) - state.lastFrame) / 1000 || 0)
  state.lastFrame = now || 0
  updateFrameBudget(dt, now || 0)
  if (state.running) updateCamera(dt, now || 0)
  updateRenderCamera(dt, now || 0)
  projectScene()
  maintainRenderBudget(now || 0)
  updateGlobalCamera()
  scheduleActiveReload()
  scheduleLowResPrefetch()
  drawOverlay()
  drawRadar()
  updateHud()
  requestAnimationFrame(tick)
}

function updateCamera(dt: number, now: number = performance.now()): void {
  const cam = state.camera
  const boost =
    state.keys.has('ShiftLeft') || state.keys.has('ShiftRight') ? 2.4 : 1
  const forward = cameraForward()
  const right = { x: Math.cos(cam.yaw), y: 0, z: Math.sin(cam.yaw) }
  let mx = 0
  let my = 0
  let mz = 0

  if (state.keys.has('KeyW') || state.keys.has('ArrowUp')) {
    mx += forward.x
    my += forward.y
    mz += forward.z
  }
  if (state.keys.has('KeyS') || state.keys.has('ArrowDown')) {
    mx -= forward.x
    my -= forward.y
    mz -= forward.z
  }
  if (state.keys.has('KeyD') || state.keys.has('ArrowRight')) {
    mx += right.x
    mz += right.z
  }
  if (state.keys.has('KeyA') || state.keys.has('ArrowLeft')) {
    mx -= right.x
    mz -= right.z
  }
  if (state.keys.has('KeyE') || state.keys.has('PageUp')) my += 1
  if (state.keys.has('KeyQ') || state.keys.has('PageDown')) my -= 1

  const len = Math.hypot(mx, my, mz)
  let targetVx = 0
  let targetVy = 0
  let targetVz = 0
  if (len > 0) {
    const targetSpeed = cam.speed * boost
    targetVx = (mx / len) * targetSpeed
    targetVy = (my / len) * targetSpeed
    targetVz = (mz / len) * targetSpeed
  } else {
    targetVx = forward.x * cam.speed * CAMERA_IDLE_DRIFT
    targetVy = forward.y * cam.speed * CAMERA_IDLE_DRIFT
    targetVz = forward.z * cam.speed * CAMERA_IDLE_DRIFT
  }

  const blend = smoothingFactor(CAMERA_ACCELERATION, dt)
  state.motion.vx = lerp(state.motion.vx, targetVx, blend)
  state.motion.vy = lerp(state.motion.vy, targetVy, blend)
  state.motion.vz = lerp(state.motion.vz, targetVz, blend)
  state.motion.speed = Math.hypot(
    state.motion.vx,
    state.motion.vy,
    state.motion.vz,
  )

  cam.x += state.motion.vx * dt
  cam.y += state.motion.vy * dt
  cam.z += state.motion.vz * dt
  markMeaningfulMotion(now)

  if (cam.z < -255) recenterCamera()
}

function updateRenderCamera(dt: number, now: number = performance.now()): void {
  const target = state.camera
  const render = state.renderCamera
  const positionBlend = smoothingFactor(CAMERA_POSITION_SMOOTHING, dt)
  const rotationBlend = smoothingFactor(CAMERA_ROTATION_SMOOTHING, dt)
  const previousYaw = render.yaw
  const previousPitch = render.pitch

  render.x = lerp(render.x, target.x, positionBlend)
  render.y = lerp(render.y, target.y, positionBlend)
  render.z = lerp(render.z, target.z, positionBlend)
  render.yaw = lerpAngle(render.yaw, target.yaw, rotationBlend)
  render.pitch = lerp(render.pitch, target.pitch, rotationBlend)
  render.speed = target.speed
  render.fov = target.fov

  const angularDelta = Math.hypot(
    angleDelta(render.yaw, previousYaw),
    render.pitch - previousPitch,
  )
  state.motion.angularSpeed = dt > 0 ? angularDelta / dt : 0
  markMeaningfulMotion(now)
}

function markMeaningfulMotion(now: number = performance.now()): void {
  if (
    state.motion.speed > MOTION_SPEED_THRESHOLD ||
    state.motion.angularSpeed > MOTION_ANGULAR_THRESHOLD ||
    state.pointer
  ) {
    state.motion.lastMeaningfulMotionAt = now
  }
}

function projectScene(): void {
  const visible: SceneNode[] = []
  let nearest: SceneNode | null = null
  const now = performance.now()
  for (const node of state.nodes) {
    node.visibleRank = Number.POSITIVE_INFINITY
    const cameraPoint = worldToCamera(node)
    const distance = distanceToCamera(node)
    node.distance = distance
    node.targetLevel = chooseLevel(node, distance)
    node.volumeKey = `${node.volume.id}:L${node.targetLevel}`
    node.projected = null

    if (cameraPoint.depth > 2 && cameraPoint.depth < FAR_DEPTH) {
      const screenX =
        state.draw.width / 2 +
        (cameraPoint.x / cameraPoint.depth) * FOCAL_LENGTH
      const screenY =
        state.draw.height / 2 -
        (cameraPoint.y / cameraPoint.depth) * FOCAL_LENGTH
      const scale = clamp(
        (node.scale * FOCAL_LENGTH) / (cameraPoint.depth * 22),
        0.18,
        2.8,
      )
      const edge = 120 * scale
      const onScreen =
        screenX > -edge &&
        screenX < state.draw.width + edge &&
        screenY > -edge &&
        screenY < state.draw.height + edge
      node.projected = {
        x: screenX,
        y: screenY,
        scale,
        depth: cameraPoint.depth,
      }
      if (onScreen) visible.push(node)
    }
    if (!nearest || distance < nearest.distance) nearest = node
  }
  visible.sort((a, b) => visibleScore(a) - visibleScore(b))
  visible.forEach((node, index) => {
    node.visibleRank = index
    node.lastVisibleAt = now
  })
  state.visible = visible
  state.nearest = nearest
}

function scheduleActiveReload(delay: number = ACTIVE_RELOAD_MS): void {
  if (!state.nv || state.loadingSignature || state.activeReloadTimer) return
  state.activeReloadTimer = window.setTimeout(() => {
    state.activeReloadTimer = 0
    void loadActiveVolumes()
  }, delay)
}

function requestActiveReload(): void {
  state.loadedSignature = ''
  if (state.activeReloadTimer) {
    window.clearTimeout(state.activeReloadTimer)
    state.activeReloadTimer = 0
  }
  scheduleActiveReload()
}

async function loadActiveVolumes(): Promise<void> {
  const nv = state.nv
  if (!nv) return
  if (shouldDeferActiveReload()) {
    scheduleActiveReload(ACTIVE_MOVING_RETRY_MS)
    return
  }
  const selected = chooseActiveNodes().sort((a, b) => b.distance - a.distance)
  const upgradeIds = chooseLodUpgradeNodes(selected)
  const slots = selected.map((node) => createRenderSlot(node, upgradeIds))
  const volumeSlots = uniqueVolumeSlots(slots)
  const sourceSignature = sourceSlotSignature(volumeSlots)
  const instanceSignature = renderSlotSignature(slots)
  if (!sourceSignature) {
    if (state.activeNodes.length > 0 || state.instanceSignature) {
      applyRenderSlots([], [], '')
      await removeUnusedVolumes(new Set())
      state.loadedSignature = ''
      els.subtitle.textContent = 'No close volumes in the ray-traced set'
    }
    return
  }
  if (sourceSignature === state.loadingSignature) return
  if (
    sourceSignature === state.loadedSignature ||
    sourceSlotsLoaded(volumeSlots)
  ) {
    if (instanceSignature !== state.instanceSignature) {
      applyRenderSlots(slots, selected, instanceSignature)
    }
    return
  }

  const requestId = ++state.loadRequestId
  state.loadingSignature = sourceSignature
  els.subtitle.textContent = `Streaming ${volumeSlots.length} sources for ${selected.length} volumes`

  const desiredKeys = new Set(volumeSlots.map((slot) => slot.volumeKey))
  const toAdd = volumeSlots.filter(
    (slot) => !state.loadedSourceKeys.has(slot.volumeKey),
  )

  try {
    if (toAdd.length > 0) {
      await withTimeout(
        Promise.all(
          toAdd.map(async (slot) => {
            const source = volumeSourceForSlot(slot)
            const volumeId = slot.node.volume.id
            const cached = state.volumeWindow.get(volumeId)
            const baseOptions = {
              name: slot.volumeKey,
              colormap: colormapForVolume(slot.node.volume),
              isColorbarVisible: false,
              ...(cached
                ? { calMin: cached.calMin, calMax: cached.calMax }
                : {}),
            }
            const options: ImageFromUrlOptions =
              source instanceof File
                ? ({
                    url: source,
                    ...baseOptions,
                  } as unknown as ImageFromUrlOptions)
                : { url: source, ...baseOptions }
            await nv.model.addVolume(options)
            state.loadedSourceKeys.add(slot.volumeKey)
            if (!cached) cacheVolumeWindow(volumeId, slot.volumeKey)
            stabilizeVolumeExtents(volumeId, slot.volumeKey)
          }),
        ),
        LOAD_TIMEOUT_MS,
        'Timed out streaming global volumes',
      )
      if (requestId !== state.loadRequestId) return
      await nv.updateGLVolume()
      if (requestId !== state.loadRequestId) return
    }

    applyRenderSlots(slots, selected, instanceSignature)
    await removeUnusedVolumes(desiredKeys)

    state.loadedSignature = sourceSignature
    els.subtitle.textContent = `${selected.length} close volumes ray traced in shared 3D space`
  } catch (err) {
    console.error(err)
    const message =
      err instanceof Error ? err.message : 'Global volume stream failed'
    els.subtitle.textContent = message
  } finally {
    if (state.loadingSignature === sourceSignature) state.loadingSignature = ''
  }
}

async function removeUnusedVolumes(desiredKeys: Set<string>): Promise<void> {
  const nv = state.nv
  if (!nv?.model) return
  const vols = nv.model.getVolumes()
  let removedAny = false
  for (let i = vols.length - 1; i >= 0; i--) {
    const key = vols[i]?.name
    if (key && !desiredKeys.has(key)) {
      nv.model.removeVolume(i)
      state.loadedSourceKeys.delete(key)
      removedAny = true
    }
  }
  if (removedAny) await nv.updateGLVolume()
}

function applyRenderSlots(
  slots: RenderSlot[],
  selected: SceneNode[],
  instanceSignature: string = renderSlotSignature(slots),
): void {
  const nv = state.nv
  if (!nv) return
  state.activeNodes = selected
  state.renderLevels = new Map(slots.map((slot) => [slot.node.id, slot.level]))
  state.instanceSignature = instanceSignature
  const camera = cameraPayload()
  state.cameraSignature = cameraSignature(camera)
  nv.opts.globalCamera = camera
  nv.setInstances(buildGlobalInstances(slots))
}

function buildGlobalInstances(items: RenderSlot[]): NVInstance[] {
  return items
    .slice()
    .sort((a, b) => a.node.index - b.node.index)
    .map((item) => {
      const node = item.node
      const volumeKey =
        item.volumeKey ||
        volumeLevelKey(node.volume, renderedLevelForNode(node))
      return {
        id: node.id,
        space: 'global3d',
        volumeId: volumeKey,
        position: [node.x, node.y, node.z],
        scale: node.scale,
        orientation: node.orientation,
      }
    })
}

function createRenderSlot(
  node: SceneNode,
  upgradeIds: Set<string> = new Set(),
): RenderSlot {
  const level = renderLevelForLoad(node, upgradeIds)
  return {
    node,
    level,
    volumeKey: volumeLevelKey(node.volume, level),
  }
}

function renderLevelForLoad(
  node: SceneNode,
  upgradeIds: Set<string> = new Set(),
): number {
  const target = node.targetLevel
  const rendered = state.renderLevels.get(node.id)
  const alreadyRendered = rendered !== undefined
  const lowest = lowestReadyLevel(node.volume)
  if (!alreadyRendered && lowest !== null && lowest > target) return lowest
  if (
    alreadyRendered &&
    rendered !== undefined &&
    target < rendered &&
    !upgradeIds.has(node.id)
  ) {
    return rendered
  }
  return target
}

function chooseLodUpgradeNodes(nodes: SceneNode[]): Set<string> {
  if (shouldDeferLodUpgrades()) return new Set()
  return new Set(
    nodes
      .filter((node) => {
        const rendered = state.renderLevels.get(node.id)
        return rendered !== undefined && node.targetLevel < rendered
      })
      .sort((a, b) => lodUpgradePriority(a) - lodUpgradePriority(b))
      .slice(0, LOD_UPGRADE_BATCH_SIZE)
      .map((node) => node.id),
  )
}

function lodUpgradePriority(node: SceneNode): number {
  const p = node.projected
  const centerBias = p
    ? Math.hypot(p.x - state.draw.width / 2, p.y - state.draw.height / 2) *
      0.012
    : 30
  const rendered = state.renderLevels.get(node.id) ?? node.targetLevel
  const levelGap = Math.max(0, rendered - node.targetLevel)
  return node.distance + centerBias - levelGap * 4
}

function renderedLevelForNode(node: SceneNode): number {
  return state.renderLevels.get(node.id) ?? node.targetLevel
}

function uniqueVolumeSlots(slots: RenderSlot[]): RenderSlot[] {
  const byKey = new Map<string, RenderSlot>()
  for (const slot of slots) {
    if (!byKey.has(slot.volumeKey)) byKey.set(slot.volumeKey, slot)
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.volumeKey.localeCompare(b.volumeKey),
  )
}

function sourceSlotSignature(slots: RenderSlot[]): string {
  return slots.map((slot) => slot.volumeKey).join('|')
}

function sourceSlotsLoaded(slots: RenderSlot[]): boolean {
  return (
    slots.length > 0 &&
    slots.every((slot) => state.loadedSourceKeys.has(slot.volumeKey))
  )
}

function renderSlotSignature(slots: RenderSlot[]): string {
  return slots
    .slice()
    .sort((a, b) => a.node.index - b.node.index)
    .map((slot) => `${slot.node.id}:${slot.volumeKey}`)
    .join('|')
}

function volumeSourceForSlot(slot: RenderSlot): string | File {
  return (
    state.prefetchFiles.get(slot.volumeKey) ??
    rawLevelUrl(slot.node.volume.id, slot.level)
  )
}

function chooseActiveNodes(): SceneNode[] {
  const hardLimit = activeVolumeLimit()
  const entryLimit = raytraceEntryLimit(hardLimit)
  const candidateCount = Math.ceil(entryLimit * ACTIVE_CANDIDATE_MULTIPLIER)
  const candidates = state.visible
    .filter((node) => canEnterRaytrace(node))
    .slice(0, candidateCount)
  const selected = state.activeNodes
    .filter((node) => shouldRetainActiveNode(node))
    .sort((a, b) => activeRenderPriority(a) - activeRenderPriority(b))
    .slice(0, hardLimit)
  const selectedIds = new Set(selected.map((node) => node.id))
  const targetLimit = Math.max(Math.min(selected.length, hardLimit), entryLimit)

  for (const node of candidates) {
    if (selected.length >= targetLimit) break
    if (selectedIds.has(node.id)) continue
    selected.push(node)
    selectedIds.add(node.id)
  }
  return selected.slice(0, hardLimit)
}

function shouldRetainActiveNode(node: SceneNode): boolean {
  if (!node.lastVisibleAt) return false
  if (performance.now() - node.lastVisibleAt > ACTIVE_STICKY_MS) return false
  return canRetainRaytrace(node)
}

function updateGlobalCamera(): void {
  const nv = state.nv
  if (!nv) return
  const camera = cameraPayload()
  const signature = cameraSignature(camera)
  if (signature === state.cameraSignature) return
  state.cameraSignature = signature
  nv.setGlobalCamera(camera)
}

function cameraSignature(camera: NVGlobalCamera): string {
  const yaw = camera.yaw ?? 0
  const pitch = camera.pitch ?? 0
  const fov = camera.fov ?? 0
  return [
    ...camera.position.map((value) => value.toFixed(3)),
    yaw.toFixed(4),
    pitch.toFixed(4),
    fov.toFixed(2),
  ].join(':')
}

function updateFrameBudget(dt: number, now: number): void {
  if (!dt) return
  const perf = state.performance
  const frameMs = clamp(dt * 1000, 0, 80)
  perf.frameMs = lerp(perf.frameMs, frameMs, 0.08)
  if (perf.frameMs > FRAME_BUDGET_MS) {
    perf.lastOverBudgetAt = now
    if (
      perf.activeLimit > ACTIVE_MIN_VOLUME_COUNT &&
      now - perf.lastLimitChangeAt > ACTIVE_TRIM_COOLDOWN_MS
    ) {
      perf.activeLimit -= 1
      perf.lastLimitChangeAt = now
    }
    return
  }

  if (
    perf.activeLimit < ACTIVE_VOLUME_COUNT &&
    !shouldDeferLodUpgrades() &&
    now - perf.lastOverBudgetAt > FRAME_RECOVERY_MS &&
    now - perf.lastLimitChangeAt > FRAME_RECOVERY_MS
  ) {
    perf.activeLimit += 1
    perf.lastLimitChangeAt = now
  }
}

function maintainRenderBudget(now: number): void {
  if (!state.nv || state.loadingSignature || state.activeNodes.length === 0)
    return
  const limit = activeVolumeLimit()
  if (now - state.performance.lastTrimAt < ACTIVE_TRIM_COOLDOWN_MS) return

  const selected = state.activeNodes
    .filter((node) => canRetainRaytrace(node))
    .slice()
    .sort((a, b) => activeRenderPriority(a) - activeRenderPriority(b))
    .slice(0, limit)
  const selectedIds = selected.map((node) => node.id).join('|')
  const activeIds = state.activeNodes.map((node) => node.id).join('|')
  if (state.activeNodes.length <= limit && selectedIds === activeIds) return

  const slots = selected.map(currentRenderSlot)
  applyRenderSlots(slots, selected)
  state.performance.lastTrimAt = now
}

function activeVolumeLimit(): number {
  return clamp(
    Math.round(state.performance.activeLimit || ACTIVE_VOLUME_COUNT),
    ACTIVE_MIN_VOLUME_COUNT,
    ACTIVE_VOLUME_COUNT,
  )
}

function raytraceEntryLimit(hardLimit: number = activeVolumeLimit()): number {
  if (shouldDeferLodUpgrades())
    return Math.min(hardLimit, ACTIVE_MOVING_VOLUME_COUNT)
  return hardLimit
}

function activeRenderPriority(node: SceneNode): number {
  const visibleRank = Number.isFinite(node.visibleRank)
    ? node.visibleRank
    : ACTIVE_VOLUME_COUNT * 4
  const centerBias = node.projected
    ? Math.hypot(
        node.projected.x - state.draw.width / 2,
        node.projected.y - state.draw.height / 2,
      ) * 0.018
    : 24
  const nearestBias = state.nearest?.id === node.id ? -18 : 0
  return visibleRank + node.distance * 0.08 + centerBias + nearestBias
}

function currentRenderSlot(node: SceneNode): RenderSlot {
  const level = state.renderLevels.get(node.id) ?? node.targetLevel
  return {
    node,
    level,
    volumeKey: volumeLevelKey(node.volume, level),
  }
}

function canEnterRaytrace(node: SceneNode): boolean {
  if (!node?.projected) return false
  return node.distance <= raytraceDistanceLimit('enter')
}

function canRetainRaytrace(node: SceneNode): boolean {
  if (!node?.projected) return false
  return node.distance <= raytraceDistanceLimit('exit')
}

function raytraceDistanceLimit(mode: 'enter' | 'exit' = 'enter'): number {
  const quality = els.quality.value
  const base =
    quality === 'low'
      ? 46
      : quality === 'balanced'
        ? 60
        : quality === 'sharp'
          ? 84
          : RAYTRACE_ENTER_DISTANCE
  if (mode === 'exit') return base + RAYTRACE_EXIT_MARGIN
  if (shouldDeferLodUpgrades())
    return Math.min(base, RAYTRACE_MOVING_ENTER_DISTANCE)
  return base
}

function scheduleLowResPrefetch(): void {
  if (!state.visible.length) return
  const activeIds = new Set(state.activeNodes.map((node) => node.id))
  const queuedKeys = new Set(state.prefetchQueue.map((job) => job.key))
  const now = Date.now()
  const candidates = prefetchCandidateNodes()

  scheduleFacingSubvolumePrefetch(candidates, activeIds, queuedKeys, now)

  for (const node of candidates) {
    if (activeIds.has(node.id)) continue
    const level = lowestReadyLevel(node.volume)
    if (level === null) continue
    const key = volumeLevelKey(node.volume, level)
    enqueuePrefetchJob(
      {
        kind: 'volume',
        key,
        level,
        volume: node.volume,
        distance: node.distance,
        priority: node.distance + 12,
        url: rawLevelUrl(node.volume.id, level),
      },
      queuedKeys,
      now,
    )
  }

  state.prefetchQueue.sort((a, b) => a.priority - b.priority)
  if (state.prefetchQueue.length > PREFETCH_QUEUE_LIMIT) {
    state.prefetchQueue.length = PREFETCH_QUEUE_LIMIT
  }
  pumpPrefetchQueue()
}

function scheduleFacingSubvolumePrefetch(
  nodes: SceneNode[],
  activeIds: Set<string>,
  queuedKeys: Set<string>,
  now: number,
): void {
  const prioritizedNodes = nodes
    .slice()
    .sort(
      (a, b) =>
        subvolumeNodePriority(a, activeIds) -
        subvolumeNodePriority(b, activeIds),
    )
    .slice(0, SUBVOLUME_PREFETCH_VOLUME_COUNT)

  for (const node of prioritizedNodes) {
    const plan = ensureSubvolumePlan(node.volume)
    if (!plan || plan.status !== 'ready') continue
    const occupancy = ensureOccupancyGrid(node.volume)
    const level = subvolumePrefetchLevel(node)
    const rankedCells = plan.cells
      .filter((cell) => cellHasContent(occupancy, cell.sourceBbox))
      .map((cell) => ({
        cell,
        model: pickSubvolumeModel(cell, level),
        priority: subvolumeCellPriority(node, plan, cell),
      }))
      .filter(
        (
          item,
        ): item is {
          cell: SubvolumeCell
          model: SubvolumeModel
          priority: number
        } => Boolean(item.model),
      )
      .sort((a, b) => a.priority - b.priority)
      .slice(0, SUBVOLUME_PREFETCH_CELLS_PER_NODE)

    rankedCells.forEach((item, index) => {
      const key = subvolumeLevelKey(
        node.volume,
        item.model.level,
        item.model.bbox,
      )
      enqueuePrefetchJob(
        {
          kind: 'subvolume',
          key,
          level: item.model.level,
          volume: node.volume,
          distance: node.distance,
          priority:
            item.priority - (activeIds.has(node.id) ? 8 : 0) + index * 0.08,
          url: item.model.url,
        },
        queuedKeys,
        now,
      )
    })
  }
}

function enqueuePrefetchJob(
  job: PrefetchJob,
  queuedKeys: Set<string>,
  now: number,
): boolean {
  if (
    state.prefetched.has(job.key) ||
    state.prefetching.has(job.key) ||
    queuedKeys.has(job.key)
  ) {
    return false
  }
  const failedAt = state.prefetchFailedAt.get(job.key) ?? 0
  if (failedAt && now - failedAt < PREFETCH_RETRY_MS) return false
  state.prefetchQueue.push(job)
  queuedKeys.add(job.key)
  return true
}

function pumpPrefetchQueue(): void {
  while (
    state.prefetching.size < PREFETCH_CONCURRENCY &&
    state.prefetchQueue.length > 0
  ) {
    const job = state.prefetchQueue.shift()
    if (!job || state.prefetched.has(job.key) || state.prefetching.has(job.key))
      continue
    state.prefetching.add(job.key)
    fetch(job.url, { cache: 'force-cache' })
      .then((res) => {
        if (!res.ok) throw new Error(`${job.url} returned ${res.status}`)
        return res.arrayBuffer()
      })
      .then((buffer) => rememberPrefetchedJob(job, buffer))
      .catch((err: unknown) => {
        state.prefetchFailedAt.set(job.key, Date.now())
        console.warn(`${job.kind} prefetch failed for ${job.key}`, err)
      })
      .finally(() => {
        state.prefetching.delete(job.key)
        pumpPrefetchQueue()
      })
  }
}

function prefetchCandidateNodes(): SceneNode[] {
  const candidates: SceneNode[] = []
  const seen = new Set<string>()
  const add = (node: SceneNode | undefined): void => {
    if (!node || seen.has(node.id)) return
    candidates.push(node)
    seen.add(node.id)
  }

  state.visible.slice(0, PREFETCH_VOLUME_COUNT).forEach(add)
  state.nodes
    .slice()
    .sort((a, b) => a.distance - b.distance)
    .slice(0, PREFETCH_VOLUME_COUNT)
    .forEach(add)

  return candidates.slice(0, PREFETCH_VOLUME_COUNT)
}

function rememberPrefetchedJob(job: PrefetchJob, buffer: ArrayBuffer): void {
  state.prefetched.add(job.key)
  state.prefetchFailedAt.delete(job.key)

  if (job.kind === 'subvolume') {
    if (!state.prefetchedSubvolumes.has(job.key)) {
      state.prefetchSubvolumeOrder.push(job.key)
    }
    state.prefetchedSubvolumes.add(job.key)
    while (state.prefetchSubvolumeOrder.length > SUBVOLUME_PREFETCH_LIMIT) {
      const expired = state.prefetchSubvolumeOrder.shift()
      if (!expired) break
      state.prefetchedSubvolumes.delete(expired)
      state.prefetched.delete(expired)
    }
    return
  }

  const file = new File([buffer], prefetchFileName(job.volume, job.level), {
    type: 'application/gzip',
  })
  if (!state.prefetchFiles.has(job.key)) state.prefetchOrder.push(job.key)
  state.prefetchFiles.set(job.key, file)
  while (state.prefetchOrder.length > PREFETCH_BUFFER_LIMIT) {
    const expired = state.prefetchOrder.shift()
    if (!expired) break
    state.prefetchFiles.delete(expired)
    state.prefetched.delete(expired)
  }
}

function ensureSubvolumePlan(volume: ApiVolume): SubvolumePlan {
  const cached = state.subvolumePlans.get(volume.id)
  const now = Date.now()
  if (cached?.status === 'ready' || cached?.status === 'loading') return cached
  if (cached?.status === 'failed' && now - cached.failedAt < PREFETCH_RETRY_MS)
    return cached

  const record: SubvolumePlan = {
    status: 'loading',
    cells: [],
    promise: null,
    failedAt: 0,
  }
  record.promise = fetchJson(subvolumeManifestUrl(volume.id))
    .then((manifest: unknown) => {
      const parsed = parseSubvolumeManifest(manifest, volume)
      Object.assign(record, parsed, { status: 'ready', failedAt: 0 })
      return record
    })
    .catch((err: unknown) => {
      record.status = 'failed'
      record.failedAt = Date.now()
      console.warn(
        `Subvolume Presentation manifest failed for ${volume.id}`,
        err,
      )
      return record
    })
  state.subvolumePlans.set(volume.id, record)
  return record
}

function ensureOccupancyGrid(volume: ApiVolume): OccupancyGrid {
  const cached = state.subvolumeOccupancy.get(volume.id)
  const now = Date.now()
  if (cached?.status === 'ready' || cached?.status === 'loading') return cached
  if (cached?.status === 'failed' && now - cached.failedAt < PREFETCH_RETRY_MS)
    return cached

  const record: OccupancyGrid = {
    status: 'loading',
    data: null,
    dims: null,
    blockSize: OCCUPANCY_BLOCK_SIZE,
    failedAt: 0,
  }
  const url = `/volumes/${encodeURIComponent(volume.id)}/occupancy?block=${OCCUPANCY_BLOCK_SIZE}`
  fetch(url, { cache: 'force-cache' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`${url} returned ${res.status}`)
      const dimsHeader = res.headers.get('X-Occupancy-Dims')
      const blockHeader = res.headers.get('X-Occupancy-Block')
      const dims = dimsHeader
        ? dimsHeader.split(',').map((s) => Number(s.trim()))
        : null
      if (
        !dims ||
        dims.length !== 3 ||
        dims.some((v) => !Number.isFinite(v) || v <= 0)
      ) {
        throw new Error(`Bad X-Occupancy-Dims header: ${dimsHeader}`)
      }
      const buf = await res.arrayBuffer()
      record.data = new Uint8Array(buf)
      record.dims = [dims[0] ?? 0, dims[1] ?? 0, dims[2] ?? 0]
      record.blockSize = Number(blockHeader) || OCCUPANCY_BLOCK_SIZE
      record.status = 'ready'
      record.failedAt = 0
    })
    .catch((err: unknown) => {
      record.status = 'failed'
      record.failedAt = Date.now()
      console.warn(`Occupancy grid fetch failed for ${volume.id}`, err)
    })
  state.subvolumeOccupancy.set(volume.id, record)
  return record
}

// Returns false only when we have a ready occupancy grid AND every macroblock
// touching `sourceBbox` is zero. Loading/failed/missing all fall through to
// true so prefetch keeps working until the grid arrives.
function cellHasContent(
  occupancy: OccupancyGrid,
  sourceBbox: number[],
): boolean {
  if (!occupancy || occupancy.status !== 'ready') return true
  if (!Array.isArray(sourceBbox) || sourceBbox.length !== 6) return true
  const data = occupancy.data
  const dims = occupancy.dims
  if (!data || !dims) return true
  const blockSize = occupancy.blockSize
  const [nx, ny, nz] = dims
  const [x0, y0, z0, x1, y1, z1] = sourceBbox as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const bx0 = Math.max(0, Math.floor(x0 / blockSize))
  const by0 = Math.max(0, Math.floor(y0 / blockSize))
  const bz0 = Math.max(0, Math.floor(z0 / blockSize))
  const bx1 = Math.min(nx, Math.ceil(x1 / blockSize))
  const by1 = Math.min(ny, Math.ceil(y1 / blockSize))
  const bz1 = Math.min(nz, Math.ceil(z1 / blockSize))
  if (bx0 >= bx1 || by0 >= by1 || bz0 >= bz1) return false
  for (let bz = bz0; bz < bz1; bz++) {
    const zBase = bz * nx * ny
    for (let by = by0; by < by1; by++) {
      const yBase = zBase + by * nx
      for (let bx = bx0; bx < bx1; bx++) {
        if (data[yBase + bx]) return true
      }
    }
  }
  return false
}

interface ParsedSubvolume {
  volumeId: string
  sceneSize: [number, number, number]
  sceneCenter: [number, number, number]
  cells: SubvolumeCell[]
}

interface RawSceneItem {
  type?: string
  width?: number
  height?: number
  depth?: number
  items?: { items?: RawAnnotation[] }[]
}

interface RawAnnotation {
  id?: string
  selector?: { x?: number; y?: number; z?: number }
  body?: {
    type?: string
    items?: RawModel[]
    id?: string
    [key: string]: unknown
  }
}

interface RawModel {
  type?: string
  id?: string
  [key: string]: unknown
}

function parseSubvolumeManifest(
  manifest: unknown,
  volume: ApiVolume,
): ParsedSubvolume {
  const m = manifest as { items?: RawSceneItem[] }
  const scene = (m.items ?? []).find((item) => item.type === 'Scene')
  const pages = scene?.items ?? []
  const annotations: RawAnnotation[] = pages.flatMap((page) => page.items ?? [])
  const sceneSize: [number, number, number] = [
    Number(scene?.width) || 1,
    Number(scene?.height) || 1,
    Number(scene?.depth) || 1,
  ]
  const sceneCenter: [number, number, number] = [
    sceneSize[0] / 2,
    sceneSize[1] / 2,
    sceneSize[2] / 2,
  ]
  const cells = annotations
    .map((annotation, index) => parseSubvolumeAnnotation(annotation, index))
    .filter((cell): cell is SubvolumeCell => cell !== null)
  return { volumeId: volume.id, sceneSize, sceneCenter, cells }
}

function parseSubvolumeAnnotation(
  annotation: RawAnnotation,
  index: number,
): SubvolumeCell | null {
  const selector = annotation.selector ?? {}
  const cx = Number(selector.x)
  const cy = Number(selector.y)
  const cz = Number(selector.z)
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz))
    return null
  const models = choiceItems(annotation.body)
    .filter((body) => body.type === 'Model' && body.id)
    .map(parseSubvolumeModel)
    .filter((model): model is SubvolumeModel => model !== null)
    .sort((a, b) => a.level - b.level)
  if (!models.length) return null
  const firstMeta = models[0]?.meta ?? {}
  const sourceBbox = Array.isArray(firstMeta.sourceBbox)
    ? firstMeta.sourceBbox
    : (models[0]?.bbox ?? [])
  const gridIndexRaw = firstMeta.gridIndex
  const gridIndex = Array.isArray(gridIndexRaw)
    ? (gridIndexRaw as number[])
    : null
  return {
    id: annotation.id ?? `cell-${index}`,
    center: [cx, cy, cz],
    gridIndex,
    sourceBbox,
    models,
  }
}

function choiceItems(body: RawAnnotation['body']): RawModel[] {
  if (!body) return []
  if (body.type === 'Choice') return Array.isArray(body.items) ? body.items : []
  return [body as RawModel]
}

function parseSubvolumeModel(model: RawModel): SubvolumeModel | null {
  try {
    if (!model.id) return null
    const url = new URL(model.id, window.location.href)
    const level = Number(url.searchParams.get('level') ?? 0)
    const metaRaw = model[VOLUMETRIC_NS]
    const meta = (
      typeof metaRaw === 'object' && metaRaw !== null
        ? (metaRaw as SubvolumeMeta)
        : {}
    ) as SubvolumeMeta
    const bbox = Array.isArray(meta.sourceBbox)
      ? meta.sourceBbox.map(Number)
      : parseBboxQuery(url.searchParams.get('bbox'))
    if (
      !bbox ||
      bbox.length !== 6 ||
      bbox.some((value) => !Number.isFinite(value))
    )
      return null
    return {
      url: model.id,
      level: Number.isInteger(level) && level >= 0 ? level : 0,
      bbox,
      meta,
    }
  } catch (_err) {
    return null
  }
}

function pickSubvolumeModel(
  cell: SubvolumeCell,
  requestedLevel: number,
): SubvolumeModel | null {
  if (!cell.models.length) return null
  const exact = cell.models.find((model) => model.level === requestedLevel)
  if (exact) return exact
  return cell.models.reduce((best, model) =>
    Math.abs(model.level - requestedLevel) <
    Math.abs(best.level - requestedLevel)
      ? model
      : best,
  )
}

function subvolumePrefetchLevel(node: SceneNode): number {
  const lowest = lowestReadyLevel(node.volume)
  if (lowest === null) return node.targetLevel
  if (node.distance < 34) return node.targetLevel
  return lowest
}

function subvolumeNodePriority(
  node: SceneNode,
  activeIds: Set<string>,
): number {
  return node.distance - (activeIds.has(node.id) ? 24 : 0)
}

function subvolumeCellPriority(
  node: SceneNode,
  plan: SubvolumePlan,
  cell: SubvolumeCell,
): number {
  const world = subvolumeCellWorldPosition(node, plan, cell)
  const cam = sceneCamera()
  const distance = Math.hypot(world.x - cam.x, world.y - cam.y, world.z - cam.z)
  const local = normalizeVector({
    x: world.x - node.x,
    y: world.y - node.y,
    z: world.z - node.z,
  })
  const towardCamera = normalizeVector({
    x: cam.x - node.x,
    y: cam.y - node.y,
    z: cam.z - node.z,
  })
  const facing = dot(local, towardCamera)
  return distance - facing * SUBVOLUME_FRONT_BIAS
}

function subvolumeCellWorldPosition(
  node: SceneNode,
  plan: SubvolumePlan,
  cell: SubvolumeCell,
): { x: number; y: number; z: number } {
  const center = plan.sceneCenter ?? [0, 0, 0]
  const size = plan.sceneSize ?? [1, 1, 1]
  const local: [number, number, number] = [
    ((cell.center[0] - center[0]) / size[0]) * node.scale * 2,
    ((cell.center[1] - center[1]) / size[1]) * node.scale * 2,
    ((cell.center[2] - center[2]) / size[2]) * node.scale * 2,
  ]
  const rotated = rotateLocalVector(local, node.orientation)
  return {
    x: node.x + rotated[0],
    y: node.y + rotated[1],
    z: node.z + rotated[2],
  }
}

function cameraPayload(): NVGlobalCamera {
  const cam = sceneCamera()
  return {
    position: [cam.x, cam.y, cam.z],
    yaw: cam.yaw,
    pitch: cam.pitch,
    fov: cam.fov,
    near: 0.1,
    far: 900,
  }
}

function chooseLevel(node: SceneNode, distance: number): number {
  const levels = availableLevels(node.volume)
  if (levels.length === 0) return 0
  const lowest = levels[levels.length - 1] ?? 0
  const quality = els.quality.value
  if (quality === 'low') return rememberLevel(node, lowest)

  const current = levels.includes(node.targetLevel) ? node.targetLevel : null
  const sticky = stickyLevel(levels, current, distance, lowest)
  if (sticky !== null && quality !== 'sharp') {
    return rememberLevel(node, motionGatedLevel(node, sticky, lowest))
  }

  let next = lowest
  if (quality === 'sharp') {
    if (els.nearNative.checked && distance < 13 && levels.includes(0)) next = 0
    else
      next = bestAvailableLevel(
        levels,
        distance < 26 ? 1 : distance < 54 ? 2 : lowest,
      )
  } else if (quality === 'balanced') {
    if (els.nearNative.checked && distance < 8 && levels.includes(0)) next = 0
    else
      next = bestAvailableLevel(
        levels,
        distance < 19 ? 1 : distance < 45 ? 2 : lowest,
      )
  } else if (els.nearNative.checked && distance < 10 && levels.includes(0)) {
    next = 0
  } else if (distance < 18) {
    next = bestAvailableLevel(levels, 1)
  } else if (distance < 40) {
    next = bestAvailableLevel(levels, 2)
  }
  return rememberLevel(node, motionGatedLevel(node, next, lowest))
}

function motionGatedLevel(
  node: SceneNode,
  desired: number,
  lowest: number,
): number {
  if (!shouldDeferLodUpgrades()) return desired
  const rendered = state.renderLevels.get(node.id)
  if (rendered !== undefined && desired < rendered) return rendered
  if (rendered === undefined && desired < lowest) return lowest
  return desired
}

function shouldDeferLodUpgrades(): boolean {
  const now = performance.now()
  return (
    state.motion.speed > MOTION_SPEED_THRESHOLD ||
    state.motion.angularSpeed > MOTION_ANGULAR_THRESHOLD ||
    now - state.motion.lastMeaningfulMotionAt < MOTION_UPGRADE_DELAY_MS
  )
}

function shouldDeferActiveReload(): boolean {
  return state.activeNodes.length > 0 && shouldDeferLodUpgrades()
}

function lowestReadyLevel(volume: ApiVolume): number | null {
  const levels = availableLevels(volume)
  return levels.length > 0 ? (levels[levels.length - 1] ?? null) : null
}

function stickyLevel(
  _levels: number[],
  current: number | null,
  distance: number,
  lowest: number,
): number | null {
  if (current === null) return null
  if (current === 0 && distance < 15) return 0
  if (current === 1 && distance > 7 && distance < 28) return 1
  if (current === 2 && distance > 16 && distance < 52) return 2
  if (current === lowest && distance > 34) return lowest
  return null
}

function rememberLevel(node: SceneNode, level: number): number {
  node.targetLevel = level
  return level
}

function availableLevels(volume: ApiVolume): number[] {
  return (volume.levels ?? [])
    .filter((level) => level.ready !== false)
    .map((level) => Number(level.level))
    .filter((level) => Number.isInteger(level) && level >= 0)
    .sort((a, b) => a - b)
}

function bestAvailableLevel(levels: number[], requested: number): number {
  if (levels.includes(requested)) return requested
  return levels.reduce((best, level) =>
    Math.abs(level - requested) < Math.abs(best - requested) ? level : best,
  )
}

function drawOverlay(): void {
  const ctx = els.backdrop.getContext('2d')
  if (!ctx) return
  const { width, height, dpr } = state.draw
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  drawReticle(ctx, width, height)
  drawProjectedMarkers(ctx)
  drawProjectedLabels(ctx)
}

function drawReticle(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  ctx.strokeStyle = 'rgba(101,216,230,0.12)'
  ctx.lineWidth = 1
  const cx = width / 2
  const cy = height / 2
  ctx.beginPath()
  ctx.moveTo(cx - 18, cy)
  ctx.lineTo(cx - 6, cy)
  ctx.moveTo(cx + 6, cy)
  ctx.lineTo(cx + 18, cy)
  ctx.moveTo(cx, cy - 18)
  ctx.lineTo(cx, cy - 6)
  ctx.moveTo(cx, cy + 6)
  ctx.lineTo(cx, cy + 18)
  ctx.stroke()
}

function drawProjectedMarkers(ctx: CanvasRenderingContext2D): void {
  const activeIds = new Set(state.activeNodes.map((node) => node.id))
  const markerLimit = labelsAreInMotionMode()
    ? LABEL_MOVING_MARKER_LIMIT
    : LABEL_SETTLED_MARKER_LIMIT
  for (const node of state.visible.slice(0, markerLimit)) {
    const p = node.projected
    if (!p) continue
    const isActive = activeIds.has(node.id)
    const isNearest = state.nearest?.id === node.id
    const r = clamp(12 * p.scale, 5, 26)
    ctx.strokeStyle = isNearest
      ? 'rgba(255,189,87,0.92)'
      : isActive
        ? 'rgba(101,216,230,0.52)'
        : 'rgba(148,215,123,0.24)'
    ctx.lineWidth = isNearest ? 1.5 : 1
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, TWO_PI)
    ctx.stroke()
  }
}

function drawProjectedLabels(ctx: CanvasRenderingContext2D): void {
  if (!els.showTitles.checked) {
    resetLabelLayer()
    return
  }
  const now = performance.now()
  const moving = labelsAreInMotionMode()
  updateLabelLayer(now, moving)
  if (state.labels.canvas.width > 0 && state.labels.canvas.height > 0) {
    ctx.drawImage(
      state.labels.canvas,
      0,
      0,
      state.draw.width,
      state.draw.height,
    )
  }
}

function resetLabelLayer(): void {
  const { width, height, dpr } = state.draw
  if (state.labels.canvas.width > 0 && state.labels.canvas.height > 0) {
    const labelCtx = state.labels.canvas.getContext('2d')
    if (labelCtx) {
      labelCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      labelCtx.clearRect(0, 0, width, height)
    }
  }
  state.labels.signature = ''
  state.labels.lastUpdate = 0
}

function updateLabelLayer(now: number, moving: boolean): void {
  const { width, height, dpr } = state.draw
  const pixelWidth = Math.round(width * dpr)
  const pixelHeight = Math.round(height * dpr)
  const resized =
    state.labels.canvas.width !== pixelWidth ||
    state.labels.canvas.height !== pixelHeight
  if (resized) {
    state.labels.canvas.width = pixelWidth
    state.labels.canvas.height = pixelHeight
  }

  const signature = labelLayerSignature(moving)
  const throttle = moving ? LABEL_MOVING_THROTTLE_MS : LABEL_SETTLED_THROTTLE_MS
  if (
    !resized &&
    signature === state.labels.signature &&
    now - state.labels.lastUpdate < throttle
  ) {
    return
  }

  const labelCtx = state.labels.canvas.getContext('2d')
  if (!labelCtx) return
  labelCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  labelCtx.clearRect(0, 0, width, height)
  drawLabelLayer(labelCtx, moving)
  state.labels.lastUpdate = now
  state.labels.signature = signature
}

function drawLabelLayer(ctx: CanvasRenderingContext2D, moving: boolean): void {
  const nodes = labelNodes(moving)
  ctx.font = '12px SFMono-Regular, Consolas, ui-monospace'
  ctx.textBaseline = 'alphabetic'
  for (const node of nodes) {
    const p = node.projected
    if (!p) continue
    const isActive = state.activeNodes.includes(node)
    const isNearest = state.nearest?.id === node.id
    const level = isActive ? renderedLevelForNode(node) : node.targetLevel
    const r = clamp(12 * p.scale, 5, 26)
    ctx.fillStyle = isNearest
      ? 'rgba(255,224,180,0.95)'
      : 'rgba(186,220,218,0.78)'
    ctx.fillText(`${node.volume.id} L${level}`, p.x + r + 6, p.y + 4)
  }
}

function labelNodes(moving: boolean): SceneNode[] {
  if (moving) {
    const nearest = state.nearest
    return nearest?.projected ? [nearest] : []
  }
  const activeIds = new Set(state.activeNodes.map((node) => node.id))
  return state.visible
    .filter(
      (node) =>
        node.projected &&
        (activeIds.has(node.id) || state.nearest?.id === node.id),
    )
    .slice(0, LABEL_SETTLED_TEXT_LIMIT)
}

function labelLayerSignature(moving: boolean): string {
  const nodes = labelNodes(moving)
  return [
    moving ? 'moving' : 'settled',
    state.draw.width,
    state.draw.height,
    ...nodes.map((node) => `${node.id}:${renderedLevelForNode(node)}`),
  ].join('|')
}

function labelsAreInMotionMode(): boolean {
  return shouldDeferLodUpgrades()
}

function drawRadar(): void {
  const ctx = els.radar.getContext('2d')
  if (!ctx) return
  const rect = els.radar.getBoundingClientRect()
  const dpr = state.draw.dpr
  const w = Math.max(1, Math.round(rect.width))
  const h = Math.max(1, Math.round(rect.height))
  if (
    els.radar.width !== Math.round(w * dpr) ||
    els.radar.height !== Math.round(h * dpr)
  ) {
    els.radar.width = Math.round(w * dpr)
    els.radar.height = Math.round(h * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(0,0,0,0.32)'
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = 'rgba(148,162,157,0.18)'
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1)

  const activeIds = new Set(state.activeNodes.map((node) => node.id))
  const warmIndex = radarWarmIndex()
  const cx = w / 2
  const cy = h / 2
  const cam = sceneCamera()
  drawRadarRangeRings(ctx, cx, cy, w, h)
  for (const node of state.nodes) {
    const point = radarPoint(node, cam, cx, cy, w, h)
    if (!point) continue
    const warm = radarNodeWarmth(node, warmIndex)
    drawRadarNode(ctx, point.x, point.y, {
      active: activeIds.has(node.id),
      nearest: state.nearest?.id === node.id,
      warm,
    })
  }
  drawRadarLegend(ctx, w, h)

  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(cam.yaw)
  ctx.fillStyle = 'rgba(148,215,123,0.95)'
  ctx.beginPath()
  ctx.moveTo(0, -9)
  ctx.lineTo(6, 8)
  ctx.lineTo(0, 4)
  ctx.lineTo(-6, 8)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function drawRadarRangeRings(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
): void {
  ctx.strokeStyle = 'rgba(148,162,157,0.09)'
  ctx.lineWidth = 1
  const maxRadius = Math.min(w, h) * 0.46
  for (const ratio of [0.33, 0.66, 1]) {
    ctx.beginPath()
    ctx.arc(cx, cy, maxRadius * ratio, 0, TWO_PI)
    ctx.stroke()
  }
}

function radarPoint(
  node: SceneNode,
  cam: CameraState,
  cx: number,
  cy: number,
  w: number,
  h: number,
): { x: number; y: number } | null {
  const dx = node.x - cam.x
  const dz = node.z - cam.z
  if (Math.abs(dx) > RADAR_RANGE || Math.abs(dz) > RADAR_RANGE) return null
  return {
    x: cx + (dx / RADAR_RANGE) * (w * 0.46),
    y: cy + (dz / RADAR_RANGE) * (h * 0.46),
  }
}

interface NodeWarmth {
  state: 'cold' | 'warming' | 'warm'
  level: number | null
  subvolumeReady: boolean
}

function drawRadarNode(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  flags: { active: boolean; nearest: boolean; warm: NodeWarmth },
): void {
  const { active, nearest, warm } = flags
  if (warm.state !== 'cold') {
    const glow = warm.state === 'warm' ? 0.42 : 0.22
    const radius = warm.state === 'warm' ? 5.4 : 4.2
    ctx.fillStyle = `rgba(255,189,87,${glow})`
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, TWO_PI)
    ctx.fill()
  }

  if (warm.state === 'warm' && warm.subvolumeReady) {
    ctx.strokeStyle = 'rgba(255,236,184,0.72)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(x, y, 6.2, 0, TWO_PI)
    ctx.stroke()
  }

  ctx.fillStyle = nearest
    ? 'rgba(255,236,184,0.98)'
    : active
      ? 'rgba(101,216,230,0.88)'
      : warm.state === 'warm'
        ? 'rgba(255,189,87,0.82)'
        : warm.state === 'warming'
          ? 'rgba(255,189,87,0.44)'
          : 'rgba(101,216,230,0.18)'
  const size = nearest ? 5 : active ? 4 : warm.state === 'warm' ? 3.5 : 3
  ctx.fillRect(x - size / 2, y - size / 2, size, size)
}

function radarWarmIndex(): WarmIndex {
  const volumeLevels = new Map<string, number>()
  const subvolumeReady = new Set<string>()
  const warming = new Set<string>()

  for (const key of state.prefetchFiles.keys()) {
    const parsed = parseVolumeLevelKey(key)
    if (!parsed) continue
    const existing = volumeLevels.get(parsed.volumeId)
    if (existing === undefined || parsed.level < existing) {
      volumeLevels.set(parsed.volumeId, parsed.level)
    }
  }

  for (const key of state.prefetchedSubvolumes) {
    const volumeId = parseSubvolumeVolumeId(key)
    if (volumeId) subvolumeReady.add(volumeId)
  }

  for (const key of state.prefetching) {
    const volumeId = parsePrefetchVolumeId(key)
    if (volumeId) warming.add(volumeId)
  }
  for (const job of state.prefetchQueue) {
    const volumeId = job.volume?.id || parsePrefetchVolumeId(job.key)
    if (volumeId) warming.add(volumeId)
  }

  return { volumeLevels, subvolumeReady, warming }
}

function radarNodeWarmth(node: SceneNode, warmIndex: WarmIndex): NodeWarmth {
  const volumeId = node.volume.id
  if (
    warmIndex.volumeLevels.has(volumeId) ||
    warmIndex.subvolumeReady.has(volumeId)
  ) {
    return {
      state: 'warm',
      level: warmIndex.volumeLevels.get(volumeId) ?? null,
      subvolumeReady: warmIndex.subvolumeReady.has(volumeId),
    }
  }
  if (warmIndex.warming.has(volumeId))
    return { state: 'warming', level: null, subvolumeReady: false }
  return { state: 'cold', level: null, subvolumeReady: false }
}

function drawRadarLegend(
  ctx: CanvasRenderingContext2D,
  _w: number,
  h: number,
): void {
  const x = 10
  const y = h - 13
  drawLegendDot(ctx, x, y, 'rgba(101,216,230,0.88)')
  drawLegendDot(ctx, x + 34, y, 'rgba(255,189,87,0.82)')
  drawLegendDot(ctx, x + 68, y, 'rgba(255,236,184,0.96)')
}

function drawLegendDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
): void {
  ctx.fillStyle = color
  ctx.fillRect(x - 2, y - 2, 4, 4)
}

function updateHud(): void {
  els.statusVisible.textContent = `${state.visible.length} visible`
  els.statusLoaded.textContent = `${state.activeNodes.length} ray traced`
  els.statusQueue.textContent = prefetchStatusText()
  els.statusSpeed.textContent = `speed ${state.camera.speed.toFixed(0)}`

  const nearest = state.nearest
  if (!nearest) return
  els.nearestTitle.textContent = nearest.volume.id
  els.nearestDistance.textContent = nearest.distance.toFixed(1)
  const rendered = state.renderLevels.get(nearest.id)
  els.nearestLod.textContent =
    rendered !== undefined && rendered !== nearest.targetLevel
      ? `L${rendered} -> L${nearest.targetLevel}`
      : `L${nearest.targetLevel}`
  els.nearestShape.textContent = Array.isArray(nearest.volume.shape)
    ? nearest.volume.shape.join(' x ')
    : '-'
  els.nearestFormat.textContent = nearest.volume.format || '-'
}

function prefetchStatusText(): string {
  if (state.loadingSignature) return 'streaming'
  if (state.prefetching.size > 0) return `${state.prefetching.size} prefetching`
  if (state.prefetchQueue.length > 0)
    return `${state.prefetchQueue.length} queued`
  if (state.prefetchedSubvolumes.size > 0) {
    return `${state.prefetchFiles.size} vols / ${state.prefetchedSubvolumes.size} cells`
  }
  return `${state.prefetchFiles.size} prefetched`
}

function resizeCanvases(): void {
  state.draw.dpr = Math.max(1, window.devicePixelRatio || 1)
  const rect = els.space.getBoundingClientRect()
  state.draw.width = Math.max(1, Math.round(rect.width))
  state.draw.height = Math.max(1, Math.round(rect.height))
  els.backdrop.width = Math.round(state.draw.width * state.draw.dpr)
  els.backdrop.height = Math.round(state.draw.height * state.draw.dpr)
  els.canvas.width = Math.round(state.draw.width * state.draw.dpr)
  els.canvas.height = Math.round(state.draw.height * state.draw.dpr)
  state.nv?.resize?.()
  state.nv?.drawScene()
}

function updateSpeed(): void {
  state.camera.speed = Number(els.speed.value || 14)
  state.renderCamera.speed = state.camera.speed
}

function togglePause(): void {
  state.running = !state.running
  els.pause.textContent = state.running ? 'Pause' : 'Resume'
}

function recenterCamera(): void {
  Object.assign(state.camera, { x: 0, y: 0, z: 34, yaw: 0, pitch: -0.05 })
  Object.assign(state.renderCamera, { x: 0, y: 0, z: 34, yaw: 0, pitch: -0.05 })
  Object.assign(state.motion, {
    vx: 0,
    vy: 0,
    vz: 0,
    speed: 0,
    angularSpeed: 0,
  })
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return res.json() as Promise<unknown>
}

function rawLevelUrl(id: string, level: number): string {
  return `/volumes/${encodeURIComponent(id)}/raw.nii.gz?level=${level}`
}

function volumeLevelKey(volume: ApiVolume, level: number): string {
  return `${volume.id}:L${level}`
}

function parseVolumeLevelKey(
  key: string,
): { volumeId: string; level: number } | null {
  const match = String(key).match(/^(.*):L(\d+)$/)
  if (!match?.[1] || !match[2]) return null
  return { volumeId: match[1], level: Number(match[2]) }
}

function parseSubvolumeVolumeId(key: string): string | null {
  const marker = ':cell:'
  const index = String(key).indexOf(marker)
  return index > 0 ? String(key).slice(0, index) : null
}

function parsePrefetchVolumeId(key: string): string | null {
  const subvolumeId = parseSubvolumeVolumeId(key)
  if (subvolumeId) return subvolumeId
  return parseVolumeLevelKey(key)?.volumeId ?? null
}

function subvolumeManifestUrl(id: string): string {
  const params = new URLSearchParams({
    nx: String(SUBVOLUME_GRID.nx),
    ny: String(SUBVOLUME_GRID.ny),
    nz: String(SUBVOLUME_GRID.nz),
    ex: String(SUBVOLUME_GRID.ex),
    ey: String(SUBVOLUME_GRID.ey),
    ez: String(SUBVOLUME_GRID.ez),
  })
  return `/iiif/presentation/${encodeURIComponent(id)}/exploded/manifest?${params.toString()}`
}

function subvolumeLevelKey(
  volume: ApiVolume,
  level: number,
  bbox: number[],
): string {
  return `${volume.id}:cell:L${level}:${bbox.join(',')}`
}

function prefetchFileName(volume: ApiVolume, level: number): string {
  return `${volume.id.replace(/[^a-z0-9._-]+/gi, '_')}-L${level}.nii.gz`
}

function parseBboxQuery(value: string | null): number[] | null {
  if (!value) return null
  const parts = String(value).split(',').map(Number)
  return parts.length === 6 ? parts : null
}

// Multiple scene nodes share the same source NIfTI (only ~20 fixtures spread
// across 120 nodes). All instances of one source render through a single
// NVImage with a single colormap, so we key colormap + window by source id —
// not node id — to keep appearance stable as the dedup winner shifts and as
// LOD swaps in.
const RANDOM_COLORMAPS = [
  'hot',
  'cool',
  'viridis',
  'inferno',
  'plasma',
  'mako',
  'cividis',
  'batlow',
  'warm',
  'winter',
  'redyell',
  'hotiron',
  'actc',
  'hsv',
  'green2cyan',
  'green2orange',
]

function colormapForVolume(volume: ApiVolume): string {
  let hash = 0
  for (let i = 0; i < volume.id.length; i++) {
    hash = (hash * 31 + volume.id.charCodeAt(i)) | 0
  }
  const idx = Math.abs(hash) % RANDOM_COLORMAPS.length
  return RANDOM_COLORMAPS[idx] ?? 'Gray'
}

function cacheVolumeWindow(volumeId: string, volumeKey: string): void {
  const vols = state.nv?.model.getVolumes()
  if (!vols) return
  const vol = vols.find((v) => v.name === volumeKey)
  if (!vol) return
  const { calMin, calMax } = vol
  if (
    typeof calMin === 'number' &&
    typeof calMax === 'number' &&
    Number.isFinite(calMin) &&
    Number.isFinite(calMax) &&
    calMax > calMin
  ) {
    state.volumeWindow.set(volumeId, { calMin, calMax })
  }
}

// Lock the per-source extents used by global3d MVP math. Each cropped LOD has
// a slightly different tight-bbox in mm space, so swapping LODs would shift
// the MVP center/diameter and visibly translate the volume. Reusing the
// first-loaded LOD's extents keeps the projection stable across LOD swaps.
function stabilizeVolumeExtents(volumeId: string, volumeKey: string): void {
  const vols = state.nv?.model.getVolumes()
  if (!vols) return
  const vol = vols.find((v) => v.name === volumeKey) as
    | {
        name?: string
        extentsMin?: ArrayLike<number>
        extentsMax?: ArrayLike<number>
      }
    | undefined
  if (!vol?.extentsMin || !vol?.extentsMax) return
  const cached = state.volumeExtents.get(volumeId)
  if (cached) {
    const target = vol as unknown as {
      extentsMin: [number, number, number]
      extentsMax: [number, number, number]
    }
    target.extentsMin = [...cached.min]
    target.extentsMax = [...cached.max]
    return
  }
  const min = vol.extentsMin
  const max = vol.extentsMax
  if (
    Number.isFinite(min[0]) &&
    Number.isFinite(min[1]) &&
    Number.isFinite(min[2]) &&
    Number.isFinite(max[0]) &&
    Number.isFinite(max[1]) &&
    Number.isFinite(max[2])
  ) {
    state.volumeExtents.set(volumeId, {
      min: [min[0], min[1], min[2]],
      max: [max[0], max[1], max[2]],
    })
  }
}

function visibleScore(node: SceneNode): number {
  const p = node.projected
  if (!p) return Number.POSITIVE_INFINITY
  const centerBias =
    Math.hypot(p.x - state.draw.width / 2, p.y - state.draw.height / 2) * 0.018
  return node.distance + centerBias
}

function sceneCamera(): CameraState {
  return state.renderCamera || state.camera
}

function worldToCamera(node: SceneNode): {
  x: number
  y: number
  depth: number
} {
  const cam = sceneCamera()
  const dx = node.x - cam.x
  const dy = node.y - cam.y
  const dz = node.z - cam.z
  const cy = Math.cos(-cam.yaw)
  const sy = Math.sin(-cam.yaw)
  const x1 = dx * cy - dz * sy
  const z1 = dx * sy + dz * cy
  const cp = Math.cos(-cam.pitch)
  const sp = Math.sin(-cam.pitch)
  const y2 = dy * cp - z1 * sp
  const z2 = dy * sp + z1 * cp
  return { x: x1, y: y2, depth: -z2 }
}

function cameraForward(): { x: number; y: number; z: number } {
  const cam = state.camera
  const cp = Math.cos(cam.pitch)
  return {
    x: Math.sin(cam.yaw) * cp,
    y: Math.sin(cam.pitch),
    z: -Math.cos(cam.yaw) * cp,
  }
}

function distanceToCamera(node: SceneNode): number {
  const cam = sceneCamera()
  return Math.hypot(node.x - cam.x, node.y - cam.y, node.z - cam.z)
}

function smoothingFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * Math.max(0, dt))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(b, a) * t
}

function angleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b))
}

function rotateLocalVector(
  vector: [number, number, number],
  orientation: [number, number, number],
): [number, number, number] {
  const [rx, ry, rz] = orientation
  let [x, y, z] = vector

  let c = Math.cos(rx)
  let s = Math.sin(rx)
  ;[y, z] = [y * c - z * s, y * s + z * c]

  c = Math.cos(ry)
  s = Math.sin(ry)
  ;[x, z] = [x * c + z * s, -x * s + z * c]

  c = Math.cos(rz)
  s = Math.sin(rz)
  ;[x, y] = [x * c - y * s, x * s + y * c]

  return [x, y, z]
}

function normalizeVector(vector: { x: number; y: number; z: number }): {
  x: number
  y: number
  z: number
} {
  const length = Math.hypot(vector.x, vector.y, vector.z)
  if (length <= 1e-6) return { x: 0, y: 0, z: 0 }
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  }
}

function dot(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId)
  })
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function showFatal(err: unknown): void {
  console.error(err)
  els.subtitle.textContent = 'Fly space unavailable'
  const div = document.createElement('div')
  div.className = 'fatal'
  div.textContent =
    err instanceof Error ? err.message : 'The fly space failed to load.'
  document.body.appendChild(div)
}
