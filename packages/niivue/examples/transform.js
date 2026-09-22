import { mat4, vec3 } from 'gl-matrix'
import NiiVue from '../src/index.ts'

const RADII = [82, 64, 46] // concentric rings for X, Y, Z
const CELL = 200 // per-dial height
const AXES = ['X', 'Y', 'Z']
const COLORS = ['#e44', '#4c4', '#48f']
// one knob revolution = 360 units of that dial
const DIALS = [
  { name: 'Translate (mm)', unit: 0.25, fmt: (v) => v.toFixed(1) },
  // ponytail: Euler XYZ gimbal-locks near 90; clamp instead of switching to quaternions
  { name: 'Rotate (deg)', unit: 1, fmt: (v) => v.toFixed(0), max: 30 },
  { name: 'Scale', unit: 0.01, fmt: (v) => (1 + v).toFixed(2) },
]

const nv1 = new NiiVue({ backgroundColor: [0.2, 0.2, 0.2, 1] })
const ctx = gizmo.getContext('2d')
const C = gizmo.width / 2

// per volume: dial values, affine at load (rows), centre in world mm at load
const state = []
let vol = 0
let values = null
let pivot = null
let hover = null
let drag = null

const toRows = (m) =>
  [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => m[c * 4 + r]))
const toMat = (rows) =>
  mat4.fromValues(...[0, 1, 2, 3].flatMap((c) => rows.map((row) => row[c])))
const rad = (d) => (d * Math.PI) / 180

// world-space T = translate(t) * about pivot( Rx Ry Rz S )
function buildTransform() {
  const [t, r, s] = values
  const m = mat4.fromTranslation(
    mat4.create(),
    vec3.add(vec3.create(), t, pivot),
  )
  mat4.rotateX(m, m, rad(r[0]))
  mat4.rotateY(m, m, rad(r[1]))
  mat4.rotateZ(m, m, rad(r[2]))
  mat4.scale(m, m, [1 + s[0], 1 + s[1], 1 + s[2]])
  mat4.translate(m, m, vec3.negate(vec3.create(), pivot))
  return m
}

async function apply() {
  const m = mat4.multiply(
    mat4.create(),
    buildTransform(),
    toMat(state[vol].original),
  )
  await nv1.setVolumeAffine(vol, toRows(m))
  document.getElementById('dials').textContent = DIALS.map(
    (d, i) => `${d.name}: ${values[i].map(d.fmt).join(', ')}`,
  ).join('   ')
}

// 12 o'clock is zero; clockwise increases
const knobAngle = (dial, axis) =>
  rad(-90 + values[dial][axis] / DIALS[dial].unit)
const knobPos = (dial, axis) => {
  const a = knobAngle(dial, axis)
  const r = RADII[axis]
  return [C + r * Math.cos(a), dial * CELL + CELL / 2 + r * Math.sin(a)]
}

function draw() {
  ctx.clearRect(0, 0, gizmo.width, gizmo.height)
  ctx.font = '13px system-ui'
  ctx.textAlign = 'center'
  for (const [dial, d] of DIALS.entries()) {
    const cy = dial * CELL + CELL / 2
    ctx.lineWidth = 2
    for (const axis of [0, 1, 2]) {
      ctx.strokeStyle = COLORS[axis]
      ctx.globalAlpha = 0.4
      ctx.beginPath()
      ctx.arc(C, cy, RADII[axis], 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    ctx.fillStyle = '#ddd'
    ctx.fillText(d.name, C, cy - RADII[0] - 8)
    for (const axis of [0, 1, 2]) {
      const [x, y] = knobPos(dial, axis)
      const hot = hover && hover.dial === dial && hover.axis === axis
      ctx.fillStyle = COLORS[axis]
      ctx.beginPath()
      ctx.arc(x, y, hot ? 11 : 8, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#000'
      ctx.fillText(AXES[axis], x, y + 4)
    }
  }
}

function hit(x, y) {
  for (const dial of [0, 1, 2]) {
    for (const axis of [0, 1, 2]) {
      const [kx, ky] = knobPos(dial, axis)
      if (Math.hypot(x - kx, y - ky) < 12) return { dial, axis }
    }
  }
  return null
}

const pos = (e) => {
  const b = gizmo.getBoundingClientRect()
  return [e.clientX - b.left, e.clientY - b.top]
}
const angleAt = (dial, x, y) => Math.atan2(y - (dial * CELL + CELL / 2), x - C)

gizmo.onpointerdown = (e) => {
  const [x, y] = pos(e)
  const h = hit(x, y)
  if (!h) return
  drag = { ...h, angle: angleAt(h.dial, x, y) }
  gizmo.setPointerCapture(e.pointerId)
}
gizmo.onpointermove = (e) => {
  const [x, y] = pos(e)
  if (!drag) {
    hover = hit(x, y)
    draw()
    return
  }
  const angle = angleAt(drag.dial, x, y)
  let delta = angle - drag.angle
  if (delta > Math.PI) delta -= 2 * Math.PI
  if (delta < -Math.PI) delta += 2 * Math.PI
  drag.angle = angle
  const d = DIALS[drag.dial]
  const v = values[drag.dial][drag.axis] + ((delta * 180) / Math.PI) * d.unit
  values[drag.dial][drag.axis] = d.max
    ? Math.max(-d.max, Math.min(d.max, v))
    : v
  draw()
  apply()
}
gizmo.onpointerup = () => {
  drag = null
}

function selectVolume(i) {
  vol = i
  ;({ values, pivot } = state[i])
  draw()
  apply()
}
target.onchange = function () {
  selectVolume(Number(this.value))
}
resetAffine.onclick = async () => {
  for (const v of values) v.fill(0)
  draw()
  await apply()
}
webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}

nv1.addEventListener('locationChange', (e) => {
  document.getElementById('location').textContent = e.detail.string
})
await nv1.attachToCanvas(gl1)
nv1.sliceType = 3
await nv1.loadVolumes([
  { url: '/volumes/mni152.nii.gz', calMin: 30, calMax: 80, colormap: 'gray' },
  { url: '/volumes/mpld_asl.nii.gz', colormap: 'red', opacity: 0.5 },
])
for (const [i, v] of nv1.volumes.entries()) {
  const original = nv1.getVolumeAffine(i)
  const d = v.hdr.dims
  state.push({
    original,
    values: DIALS.map(() => [0, 0, 0]),
    pivot: vec3.transformMat4(
      vec3.create(),
      [d[1] / 2, d[2] / 2, d[3] / 2],
      toMat(original),
    ),
  })
}
nv1.setCrosshairPos([41, -16, 58])
selectVolume(Number(target.value))
