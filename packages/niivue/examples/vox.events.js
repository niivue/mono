import NiiVue from "../src/index.ts"

const MAX_LOG_ENTRIES = 200

const CATEGORY = {
  locationChange: "interaction",
  frameChange: "interaction",
  dragRelease: "interaction",
  pointerUp: "interaction",
  measurementCompleted: "interaction",
  angleCompleted: "interaction",
  volumeLoaded: "loading",
  meshLoaded: "loading",
  volumeRemoved: "loading",
  meshRemoved: "loading",
  documentLoaded: "loading",
  viewAttached: "lifecycle",
  viewDestroyed: "lifecycle",
  canvasResize: "lifecycle",
  azimuthElevationChange: "control",
  clipPlaneChange: "control",
  sliceTypeChange: "control",
  volumeUpdated: "control",
  meshUpdated: "control",
  penValueChanged: "drawing",
  drawingChanged: "drawing",
  drawingEnabled: "drawing",
  change: "change",
}

const EVENT_NAMES = Object.keys(CATEGORY)

const activeFilters = new Set([
  "interaction",
  "loading",
  "lifecycle",
  "control",
  "drawing",
])

const log = document.getElementById("event-log")
let entryCount = 0

function formatDetail(name, detail) {
  if (detail === undefined || detail === null) return ""
  switch (name) {
    case "locationChange":
      return detail.string || ""
    case "frameChange":
      return `frame ${detail.frame}`
    case "pointerUp":
      return `(${detail.x}, ${detail.y}) btn=${detail.button}`
    case "dragRelease":
      return `${detail.mmLength.toFixed(1)}mm`
    case "measurementCompleted":
      return `${detail.distance.toFixed(1)}mm`
    case "angleCompleted":
      return `${detail.angle.toFixed(1)}\u00B0`
    case "volumeLoaded":
    case "volumeRemoved":
      return detail.volume?.name || ""
    case "meshLoaded":
    case "meshRemoved":
      return detail.mesh?.name || ""
    case "viewAttached":
      return detail.backend
    case "canvasResize":
      return `${detail.width}\u00D7${detail.height}`
    case "azimuthElevationChange":
      return `az=${detail.azimuth} el=${detail.elevation}`
    case "clipPlaneChange":
      return detail.clipPlane.map((v) => v.toFixed(1)).join(", ")
    case "sliceTypeChange":
      return `type=${detail.sliceType}`
    case "volumeUpdated": {
      const parts = Object.entries(detail.changes).map(
        ([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(2) : v}`,
      )
      return `[${detail.volumeIndex}] ${parts.join(", ")}`
    }
    case "meshUpdated": {
      const mparts = Object.entries(detail.changes).map(
        ([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(2) : v}`,
      )
      return `[${detail.meshIndex}] ${mparts.join(", ")}`
    }
    case "drawingChanged":
      return detail.action
    case "drawingEnabled":
      return detail.isEnabled ? "on" : "off"
    case "penValueChanged":
      return `pen=${detail.penValue}`
    case "change":
      return `${detail.property} = ${JSON.stringify(detail.value)}`
    default:
      return JSON.stringify(detail)
  }
}

function logEvent(name, detail) {
  const cat = CATEGORY[name]
  if (!activeFilters.has(cat)) return

  const el = document.createElement("div")
  el.className = `log-entry cat-${cat}`
  el.dataset.cat = cat

  const now = new Date()
  const ts = `${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`

  const detailStr = formatDetail(name, detail)
  el.innerHTML =
    `<span class="log-badge">${name}</span>` +
    `<span class="log-detail">${detailStr}</span>` +
    `<span class="log-time">${ts}</span>`

  log.prepend(el)
  entryCount++
  if (entryCount > MAX_LOG_ENTRIES) {
    log.lastElementChild?.remove()
    entryCount--
  }
}

// Filter checkboxes
for (const cb of document.querySelectorAll(
  "#filter-bar input[type=checkbox]",
)) {
  cb.addEventListener("change", function () {
    const cat = this.dataset.cat
    if (this.checked) {
      activeFilters.add(cat)
    } else {
      activeFilters.delete(cat)
    }
    for (const entry of log.querySelectorAll(".log-entry")) {
      entry.style.display = activeFilters.has(entry.dataset.cat) ? "" : "none"
    }
  })
}

clearBtn.onclick = () => {
  log.innerHTML = ""
  entryCount = 0
}

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}

dragMode.onchange = () => {
  nv1.primaryDragMode = parseInt(dragMode.value, 10)
}

drawCheck.onclick = function () {
  if (this.checked) {
    nv1.createEmptyDrawing()
    nv1.drawIsEnabled = true
    nv1.drawPenValue = 1
  } else {
    nv1.drawIsEnabled = false
    nv1.closeDrawing()
  }
}

webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? "webgpu" : "webgl2" })
}

function handleLocationChange(data) {
  document.getElementById("location").innerHTML = `&nbsp;&nbsp;${data.string}`
}

const nv1 = new NiiVue({
  backgroundColor: [0.2, 0.2, 0.2, 1],
  isColorbarVisible: true,
})

// Debounce canvasResize to avoid feedback loops
let resizeTimer = 0
function debouncedResizeLog(detail) {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => logEvent("canvasResize", detail), 300)
}

// Register listeners for every event
for (const name of EVENT_NAMES) {
  nv1.addEventListener(name, (e) => {
    const detail = e instanceof CustomEvent ? e.detail : undefined
    if (name === "locationChange") handleLocationChange(detail)
    if (name === "canvasResize") {
      debouncedResizeLog(detail)
      return
    }
    logEvent(name, detail)
  })
}

await nv1.attachToCanvas(gl1)
sliceType.onchange()
await nv1.loadVolumes({ url: "/volumes/mni152.nii.gz" })
