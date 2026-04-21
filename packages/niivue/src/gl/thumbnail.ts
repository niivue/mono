import { applyCORS } from "@/NVLoader"
import { NVRenderer } from "@/view/NVRenderer"
import { Shader } from "./shader"

const vertShader = `#version 300 es
precision highp float;

uniform vec2 canvasSize;
uniform vec2 texSize;

out vec2 vUv;

void main() {
    int vIdx = gl_VertexID;
    vec2 pos = vec2(0.0);
    if (vIdx == 1) { pos.x = 1.0; }
    else if (vIdx == 2) { pos.y = 1.0; }
    else if (vIdx == 3) { pos.x = 1.0; pos.y = 1.0; }

    // Aspect-ratio-correct "contain" fit
    float canvasAspect = canvasSize.x / canvasSize.y;
    float texAspect = texSize.x / texSize.y;
    vec2 scale = vec2(1.0);
    if (texAspect > canvasAspect) {
        scale.y = canvasAspect / texAspect;
    } else {
        scale.x = texAspect / canvasAspect;
    }
    vec2 offset = (vec2(1.0) - scale) * 0.5;
    vec2 ndc = (offset + pos * scale) * 2.0 - 1.0;

    gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
    vUv = pos;
}
`

const fragShader = `#version 300 es
precision highp float;

uniform sampler2D thumbTex;

in vec2 vUv;
out vec4 fragColor;

void main() {
    fragColor = texture(thumbTex, vUv);
}
`

export class ThumbnailRenderer extends NVRenderer {
  private _gl: WebGL2RenderingContext | null = null
  private _shader: Shader | null = null
  private _texture: WebGLTexture | null = null
  private _texWidth = 0
  private _texHeight = 0
  private _canvasWidth = 1
  private _canvasHeight = 1

  init(gl: WebGL2RenderingContext): void {
    if (this.isReady) return
    this._gl = gl
    this._shader = new Shader(gl, vertShader, fragShader)
    this.isReady = true
  }

  async loadThumbnail(gl: WebGL2RenderingContext, url: string): Promise<void> {
    if (!this.isReady) return
    // Destroy old texture
    if (this._texture) {
      gl.deleteTexture(this._texture)
      this._texture = null
    }
    const image = new Image()
    applyCORS(image)
    image.src = url
    await image.decode()
    this._texWidth = image.width
    this._texHeight = image.height
    this._texture = gl.createTexture()
    if (!this._texture) return
    gl.bindTexture(gl.TEXTURE_2D, this._texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
  }

  resize(_gl: WebGL2RenderingContext, width: number, height: number): void {
    this._canvasWidth = width
    this._canvasHeight = height
  }

  draw(gl: WebGL2RenderingContext): void {
    if (!this.isReady || !this._shader || !this._texture) return

    this._shader.use(gl)

    if (this._shader.uniforms.canvasSize)
      gl.uniform2f(
        this._shader.uniforms.canvasSize,
        this._canvasWidth,
        this._canvasHeight,
      )
    if (this._shader.uniforms.texSize)
      gl.uniform2f(
        this._shader.uniforms.texSize,
        this._texWidth,
        this._texHeight,
      )

    gl.depthMask(false)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this._texture)
    if (this._shader.uniforms.thumbTex)
      gl.uniform1i(this._shader.uniforms.thumbTex, 0)

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    gl.depthMask(true)
    gl.enable(gl.DEPTH_TEST)
    gl.enable(gl.CULL_FACE)
  }

  hasTexture(): boolean {
    return this._texture !== null
  }

  destroy(): void {
    const gl = this._gl
    if (!gl) return
    if (this._texture) {
      gl.deleteTexture(this._texture)
      this._texture = null
    }
    if (this._shader?.program) {
      gl.deleteProgram(this._shader.program)
    }
    this._shader = null
    this.isReady = false
    this._gl = null
  }
}
