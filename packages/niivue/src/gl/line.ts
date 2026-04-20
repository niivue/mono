import { FLOATS_PER_LINE, type LineData } from "@/view/NVLine";
import { NVRenderer } from "@/view/NVRenderer";
import { lineFragShader, lineVertShader } from "./lineShader";
import { Shader } from "./shader";

export class LineRenderer extends NVRenderer {
  private _gl: WebGL2RenderingContext | null = null;
  private _shader: Shader | null = null;
  private _vao: WebGLVertexArrayObject | null = null;
  private _lineBuffer: WebGLBuffer | null = null;
  private _canvasWidth = 1;
  private _canvasHeight = 1;

  init(gl: WebGL2RenderingContext): void {
    if (this.isReady) return;
    this._gl = gl;
    this._shader = new Shader(gl, lineVertShader, lineFragShader);
    // Create VAO
    this._vao = gl.createVertexArray();
    if (!this._vao) {
      throw new Error("Failed to create line VAO");
    }
    gl.bindVertexArray(this._vao);
    // Create buffer for line instance data
    // Each line: startX, startY, endX, endY, thickness, pad, pad, pad, r, g, b, a (12 floats)
    this._lineBuffer = gl.createBuffer();
    if (!this._lineBuffer) {
      gl.bindVertexArray(null);
      throw new Error("Failed to create line buffer");
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._lineBuffer);
    // Get attribute locations
    const aLineStart = gl.getAttribLocation(this._shader.program, "lineStart");
    const aLineEnd = gl.getAttribLocation(this._shader.program, "lineEnd");
    const aLineThickness = gl.getAttribLocation(
      this._shader.program,
      "lineThickness",
    );
    const aLineColor = gl.getAttribLocation(this._shader.program, "lineColor");
    const BYTES_PER_LINE = FLOATS_PER_LINE * 4;
    // lineStart: offset 0, vec2
    gl.enableVertexAttribArray(aLineStart);
    gl.vertexAttribPointer(aLineStart, 2, gl.FLOAT, false, BYTES_PER_LINE, 0);
    gl.vertexAttribDivisor(aLineStart, 1); // per instance
    // lineEnd: offset 8, vec2
    gl.enableVertexAttribArray(aLineEnd);
    gl.vertexAttribPointer(aLineEnd, 2, gl.FLOAT, false, BYTES_PER_LINE, 8);
    gl.vertexAttribDivisor(aLineEnd, 1);
    // lineThickness: offset 16, float
    gl.enableVertexAttribArray(aLineThickness);
    gl.vertexAttribPointer(
      aLineThickness,
      1,
      gl.FLOAT,
      false,
      BYTES_PER_LINE,
      16,
    );
    gl.vertexAttribDivisor(aLineThickness, 1);
    // lineColor: offset 32, vec4
    gl.enableVertexAttribArray(aLineColor);
    gl.vertexAttribPointer(aLineColor, 4, gl.FLOAT, false, BYTES_PER_LINE, 32);
    gl.vertexAttribDivisor(aLineColor, 1);
    gl.bindVertexArray(null);
    this.isReady = true;
  }

  resize(_gl: WebGL2RenderingContext, width: number, height: number): void {
    this._canvasWidth = width;
    this._canvasHeight = height;
  }

  draw(
    gl: WebGL2RenderingContext,
    _pass: unknown,
    _bindGroup: unknown,
    _storageBuffer: unknown,
    lines: LineData[],
    maxLines = 2048,
  ): void {
    if (
      !this.isReady ||
      lines.length === 0 ||
      !this._lineBuffer ||
      !this._vao ||
      !this._shader
    )
      return;
    // Prepare line data
    const allLineData = new Float32Array(maxLines * FLOATS_PER_LINE);
    const lineCount = Math.min(lines.length, maxLines);
    for (let i = 0; i < lineCount; i++) {
      const line = lines[i];
      if (!line) continue;
      allLineData.set(line.data, i * FLOATS_PER_LINE);
    }
    // Upload line data
    gl.bindBuffer(gl.ARRAY_BUFFER, this._lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, allLineData, gl.DYNAMIC_DRAW);
    // Set up state
    this._shader.use(gl);
    const canvasSize = this._shader.uniforms.canvasSize;
    if (canvasSize) {
      gl.uniform2f(canvasSize, this._canvasWidth, this._canvasHeight);
    }
    // Disable depth writing for lines (overlay)
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    // Enable blending
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // Draw instanced quads (4 vertices per line, lineCount instances)
    gl.bindVertexArray(this._vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, lineCount);
    gl.bindVertexArray(null);
    // Restore depth state
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  destroy(): void {
    const gl = this._gl;
    if (!gl) return;
    if (this._vao) gl.deleteVertexArray(this._vao);
    if (this._lineBuffer) gl.deleteBuffer(this._lineBuffer);
    if (this._shader?.program) gl.deleteProgram(this._shader.program);
    this.isReady = false;
    this._shader = null;
    this._vao = null;
    this._lineBuffer = null;
    this._gl = null;
  }
}
