// The standalone demo's own content: one triangle with its own tiny shader on
// either backend, drawn from a UIKitOverlayFrame. Shared with the e2e spec
// (packages/niivue/e2e/uikit-canvas-host.spec.ts), which loads it raw.
// State is in device pixels: centre, circumradius, angle (radians), colour.

const GLSL_VS = `#version 300 es
uniform vec2 size, center;
uniform float radius, angle;
void main() {
  float a = angle + float(gl_VertexID) * 2.0943951;
  vec2 p = center + radius * vec2(sin(a), -cos(a));
  gl_Position = vec4(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, 0.0, 1.0);
}`
const GLSL_FS = `#version 300 es
precision mediump float;
uniform vec4 color;
out vec4 fragColor;
void main() { fragColor = color; }`
const WGSL = `
struct U { size: vec2f, center: vec2f, color: vec4f, radius: f32, angle: f32 }
@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let a = u.angle + f32(i) * 2.0943951;
  let p = u.center + u.radius * vec2f(sin(a), -cos(a));
  return vec4f(p.x / u.size.x * 2.0 - 1.0, 1.0 - p.y / u.size.y * 2.0, 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return u.color; }`

export function createTriangle() {
  let gl = null
  let program = null
  let loc = null
  let pipeline = null
  let uniforms = null
  let bindGroup = null
  const data = new Float32Array(12)

  function drawGL(g, frame, s) {
    if (gl !== g) {
      gl = g
      const shader = (type, src) => {
        const sh = gl.createShader(type)
        gl.shaderSource(sh, src)
        gl.compileShader(sh)
        gl.attachShader(program, sh)
      }
      program = gl.createProgram()
      shader(gl.VERTEX_SHADER, GLSL_VS)
      shader(gl.FRAGMENT_SHADER, GLSL_FS)
      gl.linkProgram(program)
      loc = (n) => gl.getUniformLocation(program, n)
    }
    gl.useProgram(program)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(null)
    gl.uniform2f(loc('size'), frame.bounds.width, frame.bounds.height)
    gl.uniform2f(loc('center'), s.cx, s.cy)
    gl.uniform1f(loc('radius'), s.radius)
    gl.uniform1f(loc('angle'), s.angle)
    gl.uniform4fv(loc('color'), s.color)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  function drawGPU({ device, pass, colorFormat }, frame, s) {
    if (!pipeline) {
      const module = device.createShaderModule({ code: WGSL })
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [{ format: colorFormat }],
        },
      })
      uniforms = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniforms } }],
      })
    }
    data.set([
      frame.bounds.width,
      frame.bounds.height,
      s.cx,
      s.cy,
      ...s.color,
      s.radius,
      s.angle,
    ])
    device.queue.writeBuffer(uniforms, 0, data)
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(3)
  }

  return {
    draw(frame, state) {
      if (frame.handle.backend === 'webgl2')
        drawGL(frame.handle.gl, frame, state)
      else drawGPU(frame.handle, frame, state)
    },
  }
}
