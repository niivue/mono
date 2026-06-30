// Render an NVSlide as a textured plane in 3D world (MNI152 mm) space.
//
// Leverages NVSlide for the slide model + tile streaming (cache, decode) and
// slidePlaneTiles()/axialPlaneTransform() for the 2D->3D placement. This demo is
// a self-contained WebGL2 orbit viewer: it draws each slide tile as a textured
// quad at its world position, inside an MNI152 bounding box, depth-composited.
// (Compositing with an actual MNI152 volume render is the next step.)
import { mat4 } from 'gl-matrix'
import { axialPlaneTransform, NVSlide, slidePlaneTiles } from '../src/index.ts'

// Approximate MNI152 world extents in mm.
const MNI = { xmin: -90, xmax: 90, ymin: -126, ymax: 90, zmin: -72, zmax: 108 }

const canvas = document.getElementById('gl')
const hud = document.getElementById('hud')
const gl = canvas.getContext('webgl2', { alpha: false, antialias: true })
if (!gl) throw new Error('WebGL2 unavailable')

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
uniform mat4 uMvp;
out vec2 vUV;
void main(){ vUV = aUV; gl_Position = uMvp * vec4(aPos, 1.0); }`

const FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 o;
uniform sampler2D uTex;
uniform int uTextured;
uniform vec4 uColor;
void main(){ o = uTextured == 1 ? texture(uTex, vUV) : uColor; }`

function compile(type, src) {
  const s = gl.createShader(type)
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed')
  }
  return s
}
const prog = gl.createProgram()
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS))
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS))
gl.linkProgram(prog)
const uMvp = gl.getUniformLocation(prog, 'uMvp')
const uTextured = gl.getUniformLocation(prog, 'uTextured')
const uColor = gl.getUniformLocation(prog, 'uColor')

// One reusable interleaved buffer (pos.xyz, uv.xy) for quads and box lines.
const vbo = gl.createBuffer()
const vao = gl.createVertexArray()
gl.bindVertexArray(vao)
gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
gl.enableVertexAttribArray(0)
gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0)
gl.enableVertexAttribArray(1)
gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12)

// 12 edges of the MNI box as line vertices (uv unused).
function boxLines() {
  const { xmin, xmax, ymin, ymax, zmin, zmax } = MNI
  const c = [
    [xmin, ymin, zmin],
    [xmax, ymin, zmin],
    [xmax, ymax, zmin],
    [xmin, ymax, zmin],
    [xmin, ymin, zmax],
    [xmax, ymin, zmax],
    [xmax, ymax, zmax],
    [xmin, ymax, zmax],
  ]
  const e = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ]
  const v = []
  for (const [a, b] of e) v.push(...c[a], 0, 0, ...c[b], 0, 0)
  return new Float32Array(v)
}
const boxVerts = boxLines()

// Orbit camera.
let azimuth = 35
let elevation = 18
let distance = 430
let drag = null
canvas.addEventListener('mousedown', (ev) => {
  drag = { x: ev.clientX, y: ev.clientY }
})
window.addEventListener('mouseup', () => {
  drag = null
})
window.addEventListener('mousemove', (ev) => {
  if (!drag) return
  azimuth += (ev.clientX - drag.x) * 0.4
  elevation = Math.max(
    -89,
    Math.min(89, elevation + (ev.clientY - drag.y) * 0.4),
  )
  drag = { x: ev.clientX, y: ev.clientY }
})
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault()
  distance = Math.max(60, Math.min(2000, distance * (1 + ev.deltaY * 0.001)))
})

function mvpMatrix() {
  const center = [
    (MNI.xmin + MNI.xmax) / 2,
    (MNI.ymin + MNI.ymax) / 2,
    (MNI.zmin + MNI.zmax) / 2,
  ]
  const proj = mat4.perspective(
    mat4.create(),
    Math.PI / 4,
    canvas.width / Math.max(1, canvas.height),
    1,
    6000,
  )
  const az = (azimuth * Math.PI) / 180
  const el = (elevation * Math.PI) / 180
  const eye = [
    center[0] + distance * Math.cos(el) * Math.sin(az),
    center[1] + distance * Math.sin(el),
    center[2] + distance * Math.cos(el) * Math.cos(az),
  ]
  const view = mat4.lookAt(mat4.create(), eye, center, [0, 1, 0])
  return mat4.multiply(mat4.create(), proj, view)
}

const texCache = new Map()
function textureFor(key, bitmap) {
  let tex = texCache.get(key)
  if (tex) return tex
  tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  texCache.set(key, tex)
  return tex
}

let slide = null
let level = null
let planeTiles = []

function resize() {
  const dpr = window.devicePixelRatio || 1
  const w = Math.floor(canvas.clientWidth * dpr)
  const h = Math.floor(canvas.clientHeight * dpr)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
}

function drawQuad(corners, key) {
  const [tl, tr, bl, br] = corners
  // TRIANGLE_STRIP order TL,TR,BL,BR; uv top-left origin.
  const v = new Float32Array([
    ...tl,
    0,
    0,
    ...tr,
    1,
    0,
    ...bl,
    0,
    1,
    ...br,
    1,
    1,
  ])
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW)
  gl.uniform1i(uTextured, 1)
  gl.bindTexture(gl.TEXTURE_2D, texCache.get(key))
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}

function frame() {
  resize()
  gl.viewport(0, 0, canvas.width, canvas.height)
  gl.clearColor(0.027, 0.063, 0.051, 1)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  gl.enable(gl.DEPTH_TEST)
  gl.useProgram(prog)
  gl.bindVertexArray(vao)
  gl.uniformMatrix4fv(uMvp, false, mvpMatrix())

  // MNI152 bounding box for spatial context.
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, boxVerts, gl.DYNAMIC_DRAW)
  gl.uniform1i(uTextured, 0)
  gl.uniform4f(uColor, 0.45, 0.83, 0.81, 0.5)
  gl.drawArrays(gl.LINES, 0, boxVerts.length / 5)

  let ready = 0
  if (slide && level) {
    for (const q of planeTiles) {
      const tile = level.tiles[q.row * level.columns + q.col]
      slide.requestTile(level, tile)
      const bitmap = slide.cachedTileBitmap(q.key)
      if (!bitmap) continue
      textureFor(q.key, bitmap)
      drawQuad(q.corners, q.key)
      ready++
    }
    hud.textContent = `${slide.manifest.name}\nplane tiles ${ready}/${planeTiles.length} · L${level.index} ${level.width}x${level.height}\naz ${Math.round(azimuth)} el ${Math.round(elevation)} dist ${Math.round(distance)}`
  }
  requestAnimationFrame(frame)
}

async function main() {
  const base = import.meta.env.BASE_URL || '/'
  const url = new URL(
    `${base.endsWith('/') ? base : `${base}/`}tile-range-poc/tiles.json`,
    window.location.href,
  ).toString()
  slide = await NVSlide.fromManifestUrl(url)
  // A mid pyramid level keeps the plane to a handful of tiles for the overview.
  const levels = slide.manifest.levels
  level = levels[Math.min(1, levels.length - 1)]
  const tw = level.tileWidth ?? slide.manifest.tileSize ?? 256
  const th = level.tileHeight ?? slide.manifest.tileSize ?? 256
  const transform = axialPlaneTransform(
    slide.manifest.width,
    slide.manifest.height,
    {
      xmin: MNI.xmin,
      xmax: MNI.xmax,
      ymin: MNI.ymin,
      ymax: MNI.ymax,
      z: (MNI.zmin + MNI.zmax) / 2,
    },
  )
  planeTiles = slidePlaneTiles(level, tw, th, transform)
  requestAnimationFrame(frame)
}

main().catch((err) => {
  hud.textContent = `error: ${err instanceof Error ? err.message : err}`
  console.error(err)
})
