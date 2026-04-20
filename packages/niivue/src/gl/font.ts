import { log } from "@/logger";
import { applyCORS } from "@/NVLoader";
import type { NVFontData } from "@/NVTypes";
import {
  buildTextLayout,
  calculateFontSizePx,
  emptyBatch,
  FLOATS_PER_PANEL,
  type FontMetrics,
  type GlyphBatch,
} from "@/view/NVFont";
import { NVRenderer } from "@/view/NVRenderer";
import { fontFragShader, fontVertShader } from "./fontShader";
import { panelFragShader, panelVertShader } from "./panelShader";
import { Shader } from "./shader";

const BYTES_PER_PANEL = FLOATS_PER_PANEL * 4;

async function loadFontTexture(
  gl: WebGL2RenderingContext,
  pngPath: string,
): Promise<{ texture: WebGLTexture; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const texture = gl.createTexture();
      if (!texture) {
        reject(new Error("Failed to create font texture"));
        return;
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      resolve({ texture, width: img.width, height: img.height });
    };
    img.onerror = reject;
    applyCORS(img);
    img.src = pngPath;
  });
}

export class FontRenderer extends NVRenderer {
  private _gl: WebGL2RenderingContext | null = null;
  private _shader: Shader | null = null;
  private _vao: WebGLVertexArrayObject | null = null;
  private _glyphBuffer: WebGLBuffer | null = null;
  private _fontTexture: WebGLTexture | null = null;
  private _fontMets: FontMetrics | null = null;
  private _canvasWidth = 1;
  private _canvasHeight = 1;
  private _texWidth = 1;
  private _texHeight = 1;
  private _fontPx = 16;
  private _panelShader: Shader | null = null;
  private _panelVao: WebGLVertexArrayObject | null = null;
  private _panelBuffer: WebGLBuffer | null = null;

  /** Current rasterized font size in device pixels (post-resize). */
  get fontPx(): number {
    return this._fontPx;
  }

  async init(gl: WebGL2RenderingContext, fontData?: NVFontData): Promise<void> {
    if (this.isReady) return;
    if (!fontData) return;
    this._gl = gl;
    try {
      // Load font assets from pre-parsed data
      const fontResult = await loadFontTexture(gl, fontData.atlasUrl);
      this._fontTexture = fontResult.texture;
      this._texWidth = fontResult.width;
      this._texHeight = fontResult.height;
      this._fontMets = fontData.metrics;
      // Create shader program
      this._shader = new Shader(gl, fontVertShader, fontFragShader);
      // Create VAO
      this._vao = gl.createVertexArray();
      if (!this._vao) {
        throw new Error("Failed to create font VAO");
      }
      gl.bindVertexArray(this._vao);
      // Create buffer for glyph instance data
      this._glyphBuffer = gl.createBuffer();
      if (!this._glyphBuffer) {
        gl.bindVertexArray(null);
        throw new Error("Failed to create glyph buffer");
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this._glyphBuffer);
      // Get attribute locations
      const aRect = gl.getAttribLocation(this._shader.program, "glyphRect");
      const aUvRect = gl.getAttribLocation(this._shader.program, "glyphUvRect");
      const aColor = gl.getAttribLocation(this._shader.program, "glyphColor");
      const aRange = gl.getAttribLocation(this._shader.program, "glyphRange");
      const FLOATS_PER_GLYPH = 16;
      const BYTES_PER_GLYPH = FLOATS_PER_GLYPH * 4;
      // glyphRect: offset 0, vec4
      gl.enableVertexAttribArray(aRect);
      gl.vertexAttribPointer(aRect, 4, gl.FLOAT, false, BYTES_PER_GLYPH, 0);
      gl.vertexAttribDivisor(aRect, 1);
      // glyphUvRect: offset 16, vec4
      gl.enableVertexAttribArray(aUvRect);
      gl.vertexAttribPointer(aUvRect, 4, gl.FLOAT, false, BYTES_PER_GLYPH, 16);
      gl.vertexAttribDivisor(aUvRect, 1);
      // glyphColor: offset 32, vec4
      gl.enableVertexAttribArray(aColor);
      gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, BYTES_PER_GLYPH, 32);
      gl.vertexAttribDivisor(aColor, 1);
      // glyphRange: offset 48, float
      gl.enableVertexAttribArray(aRange);
      gl.vertexAttribPointer(aRange, 1, gl.FLOAT, false, BYTES_PER_GLYPH, 48);
      gl.vertexAttribDivisor(aRange, 1);
      gl.bindVertexArray(null);
      // Panel shader for label backing rects
      this._panelShader = new Shader(gl, panelVertShader, panelFragShader);
      this._panelVao = gl.createVertexArray();
      if (!this._panelVao) {
        throw new Error("Failed to create panel VAO");
      }
      gl.bindVertexArray(this._panelVao);
      this._panelBuffer = gl.createBuffer();
      if (!this._panelBuffer) {
        gl.bindVertexArray(null);
        throw new Error("Failed to create panel buffer");
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this._panelBuffer);
      const pRect = gl.getAttribLocation(
        this._panelShader.program,
        "panelRect",
      );
      const pColor = gl.getAttribLocation(
        this._panelShader.program,
        "panelColor",
      );
      const pRadius = gl.getAttribLocation(
        this._panelShader.program,
        "panelRadius",
      );
      gl.enableVertexAttribArray(pRect);
      gl.vertexAttribPointer(pRect, 4, gl.FLOAT, false, BYTES_PER_PANEL, 0);
      gl.vertexAttribDivisor(pRect, 1);
      gl.enableVertexAttribArray(pColor);
      gl.vertexAttribPointer(pColor, 4, gl.FLOAT, false, BYTES_PER_PANEL, 16);
      gl.vertexAttribDivisor(pColor, 1);
      gl.enableVertexAttribArray(pRadius);
      gl.vertexAttribPointer(pRadius, 1, gl.FLOAT, false, BYTES_PER_PANEL, 32);
      gl.vertexAttribDivisor(pRadius, 1);
      gl.bindVertexArray(null);
      this.isReady = true;
    } catch (err) {
      log.error("Failed to initialize font system:", err);
      this.isReady = false;
    }
  }

  resize(
    _gl: WebGL2RenderingContext,
    width: number,
    height: number,
    dpi: number = 1,
    fontSizeScaling: number = 0.4,
    fontMinPx: number = 13,
  ): void {
    this._canvasWidth = width;
    this._canvasHeight = height;
    this._fontPx = calculateFontSizePx(
      width,
      height,
      dpi,
      fontSizeScaling,
      fontMinPx,
    );
  }

  buildText(
    str: string,
    x: number,
    y: number,
    scale: number,
    color: number[] = [1, 1, 1, 1],
    anchorX: number = 0,
    anchorY: number = 0,
    backColor: number[] = [0, 0, 0, 0],
  ): GlyphBatch {
    if (!this.isReady || !this._fontMets) return emptyBatch();
    return buildTextLayout(
      str,
      x,
      y,
      this._fontPx,
      scale,
      this._fontMets,
      color,
      anchorX,
      anchorY,
      backColor,
    );
  }

  createBindGroup() {
    return null;
  }

  draw(
    gl: WebGL2RenderingContext,
    _pass: unknown,
    _bindGroup: unknown,
    _storageBuffer: unknown,
    textList: GlyphBatch[],
    maxGlyphs: number,
  ): void {
    if (
      !this.isReady ||
      textList.length === 0 ||
      !this._glyphBuffer ||
      !this._vao ||
      !this._shader ||
      !this._fontTexture
    )
      return;
    // Safeguard for undefined maxGlyphs
    if (!maxGlyphs || maxGlyphs < 1) {
      maxGlyphs = 256;
    }
    // Panel pass: draw backing rectangles first
    if (this._panelShader && this._panelVao && this._panelBuffer) {
      let panelCount = 0;
      for (const item of textList) {
        if (item.backColor && item.backColor[3] > 0) panelCount++;
      }
      if (panelCount > 0) {
        const panelData = new Float32Array(panelCount * FLOATS_PER_PANEL);
        let idx = 0;
        for (const item of textList) {
          if (!item.backColor || item.backColor[3] <= 0) continue;
          const off = idx * FLOATS_PER_PANEL;
          panelData.set(item.backRect, off);
          panelData.set(item.backColor, off + 4);
          panelData[off + 8] = item.backRadius;
          idx++;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this._panelBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, panelData, gl.DYNAMIC_DRAW);
        this._panelShader.use(gl);
        if (this._panelShader.uniforms.canvasSize)
          gl.uniform2f(
            this._panelShader.uniforms.canvasSize,
            this._canvasWidth,
            this._canvasHeight,
          );
        gl.depthMask(false);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindVertexArray(this._panelVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, panelCount);
        gl.bindVertexArray(null);
      }
    }
    // Glyph pass
    // Combine all text items
    let totalChars = 0;
    const combinedData = new Float32Array(maxGlyphs * 16);
    for (const item of textList) {
      if (totalChars + item.count > maxGlyphs) break;
      combinedData.set(item.data, totalChars * 16);
      totalChars += item.count;
    }
    if (totalChars === 0) return;
    // Upload glyph data
    gl.bindBuffer(gl.ARRAY_BUFFER, this._glyphBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, combinedData, gl.DYNAMIC_DRAW);
    // Set up state
    this._shader.use(gl);
    if (this._shader.uniforms.canvasSize)
      gl.uniform2f(
        this._shader.uniforms.canvasSize,
        this._canvasWidth,
        this._canvasHeight,
      );
    if (this._shader.uniforms.texSize)
      gl.uniform2f(
        this._shader.uniforms.texSize,
        this._texWidth,
        this._texHeight,
      );
    // Bind font texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._fontTexture);
    if (this._shader.uniforms.fontTexture)
      gl.uniform1i(this._shader.uniforms.fontTexture, 0);
    // Disable depth writing for text (overlay)
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // Draw instanced quads
    gl.bindVertexArray(this._vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, totalChars);
    gl.bindVertexArray(null);
    // Restore state
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }

  destroy(): void {
    const gl = this._gl;
    if (!gl) return;
    if (this._vao) gl.deleteVertexArray(this._vao);
    if (this._glyphBuffer) gl.deleteBuffer(this._glyphBuffer);
    if (this._fontTexture) gl.deleteTexture(this._fontTexture);
    if (this._shader?.program) gl.deleteProgram(this._shader.program);
    if (this._panelVao) gl.deleteVertexArray(this._panelVao);
    if (this._panelBuffer) gl.deleteBuffer(this._panelBuffer);
    if (this._panelShader?.program) gl.deleteProgram(this._panelShader.program);
    this.isReady = false;
    this._shader = null;
    this._vao = null;
    this._glyphBuffer = null;
    this._fontTexture = null;
    this._fontMets = null;
    this._panelShader = null;
    this._panelVao = null;
    this._panelBuffer = null;
    this._gl = null;
  }
}
