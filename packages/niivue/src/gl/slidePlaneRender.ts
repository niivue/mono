import type { SlidePlaneState } from '@/slide/slidePlane'
import { NVRenderer } from '@/view/NVRenderer'
import { Shader } from './shader'

// Draws an NVSlide as a textured plane in the 3D render tile. Each tile of the
// chosen slide level is a world-mm quad (computed by `slidePlaneTiles`); this
// renderer uploads the tile's cached bitmap to a GPU texture and draws the quad
// with the render tile's MVP (world mm -> clip), so the slide composites with
// the volume in its own space and depth. Tiles stream in via NVSlide's cache;
// the controller redraws on the slide's `change` event, and this renderer
// uploads any newly-resident bitmaps on the next frame.

const vertSrc = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
uniform mat4 mvpMtx;
out vec2 vUV;
void main(){ vUV = aUV; gl_Position = mvpMtx * vec4(aPos, 1.0); }`

const fragSrc = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D tileTex;
uniform float opacity;
out vec4 outColor;
void main(){
  vec4 c = texture(tileTex, vUV);
  outColor = vec4(c.rgb, c.a * opacity);
}`

export class SlidePlaneRenderer extends NVRenderer {
  private _gl: WebGL2RenderingContext | null = null
  private _shader: Shader | null = null
  private _vao: WebGLVertexArrayObject | null = null
  private _vbo: WebGLBuffer | null = null
  // One texture per resident tile, keyed by NVSlide tile key.
  private _textures = new Map<string, WebGLTexture>()

  init(gl: WebGL2RenderingContext): void {
    if (this.isReady) return
    this._gl = gl
    this._shader = new Shader(gl, vertSrc, fragSrc)
    this._vao = gl.createVertexArray()
    this._vbo = gl.createBuffer()
    if (!this._vao || !this._vbo) {
      throw new Error('Failed to create slide-plane GL objects')
    }
    gl.bindVertexArray(this._vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo)
    // Interleaved [pos.xyz, uv.xy] = 5 floats / 20 bytes per vertex.
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12)
    gl.bindVertexArray(null)
    this.isReady = true
  }

  private _textureFor(
    gl: WebGL2RenderingContext,
    key: string,
    bitmap: ImageBitmap,
  ): WebGLTexture | null {
    const existing = this._textures.get(key)
    if (existing) return existing
    const tex = gl.createTexture()
    if (!tex) return null
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this._textures.set(key, tex)
    return tex
  }

  draw(
    gl: WebGL2RenderingContext,
    mvpMatrix: Float32Array,
    state: SlidePlaneState,
    opacity = 1,
  ): void {
    if (!this.isReady || !this._shader || !this._vao || !this._vbo) return
    this._shader.use(gl)
    if (this._shader.uniforms.mvpMtx) {
      gl.uniformMatrix4fv(this._shader.uniforms.mvpMtx, false, mvpMatrix)
    }
    if (this._shader.uniforms.opacity) {
      gl.uniform1f(this._shader.uniforms.opacity, opacity)
    }
    if (this._shader.uniforms.tileTex) {
      gl.uniform1i(this._shader.uniforms.tileTex, 0)
    }
    gl.activeTexture(gl.TEXTURE0)
    // Depth-test so volume in front occludes the plane, but don't write depth
    // (the plane is a thin overlay; let later layers blend over it too).
    gl.enable(gl.DEPTH_TEST)
    gl.depthMask(false)
    // The plane is two-sided — show it from either face.
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(this._vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo)
    for (const tile of state.tiles) {
      const bitmap = state.slide.cachedTileBitmap(tile.key)
      if (!bitmap) continue
      const tex = this._textureFor(gl, tile.key, bitmap)
      if (!tex) continue
      const [tl, tr, bl, br] = tile.corners
      // TRIANGLE_STRIP order TL, TR, BL, BR; UV origin top-left.
      const v = new Float32Array([
        tl[0],
        tl[1],
        tl[2],
        0,
        0,
        tr[0],
        tr[1],
        tr[2],
        1,
        0,
        bl[0],
        bl[1],
        bl[2],
        0,
        1,
        br[0],
        br[1],
        br[2],
        1,
        1,
      ])
      gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    gl.bindVertexArray(null)
    gl.depthMask(true)
  }

  destroy(): void {
    const gl = this._gl
    if (!gl) return
    for (const tex of this._textures.values()) gl.deleteTexture(tex)
    this._textures.clear()
    if (this._vao) gl.deleteVertexArray(this._vao)
    if (this._vbo) gl.deleteBuffer(this._vbo)
    if (this._shader?.program) gl.deleteProgram(this._shader.program)
    this.isReady = false
    this._shader = null
    this._vao = null
    this._vbo = null
    this._gl = null
  }
}
