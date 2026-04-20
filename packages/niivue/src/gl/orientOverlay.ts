/**
 * orientOverlay.js
 *
 * Transforms a scalar volume to an RGBA8 3D texture by applying calibration
 * and colormap lookup. Uses WebGL2 for GPU-accelerated processing.
 * Unlike WebGPU, we do this in one pass: read NEAREST, write LINEAR
 */

import * as NVCmaps from "@/cmap/NVCmaps";
import { log } from "@/logger";
import type { NVImage, TypedVoxelArray } from "@/NVTypes";
import { buildOrientUniforms, prepareRGBAData } from "@/view/NVOrient";

type ShaderPrograms = {
  uint: WebGLProgram;
  sint: WebGLProgram;
  float: WebGLProgram;
};

// top of file
const _programCache = new WeakMap<WebGL2RenderingContext, ShaderPrograms>(); // gl -> { uint, sint, float }

function getOrCreatePrograms(gl: WebGL2RenderingContext): ShaderPrograms {
  let cache = _programCache.get(gl);
  if (cache) return cache;
  cache = createShaderPrograms(gl);
  _programCache.set(gl, cache);
  return cache;
}

/**
 * Create a 3D RGBA8 WebGL texture directly from an RGB/RGBA NIfTI image.
 * Mirrors the WebGPU rgba2Texture() behavior.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {Object} nvimage - must contain hdr.datatypeCode, img (ArrayBuffer/TypedArray),
 *                           dims (NIfTI dims array), dimsRAS, img2RASstep
 * @returns {WebGLTexture}
 */
export function rgba2Texture(
  gl: WebGL2RenderingContext,
  nvimage: NVImage,
): WebGLTexture {
  const { rgbaData, texDims } = prepareRGBAData(nvimage);
  const tex = gl.createTexture();
  if (!tex) {
    throw new Error("rgba2Texture: failed to create texture");
  }
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.texImage3D(
    gl.TEXTURE_3D,
    0,
    gl.RGBA8,
    texDims[0],
    texDims[1],
    texDims[2],
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    rgbaData,
  );
  gl.bindTexture(gl.TEXTURE_3D, null);
  return tex;
}

// Vertex shader - renders a full-screen quad for each output slice
const vertShader = `#version 300 es
precision highp float;
in vec3 vPos;
out vec2 TexCoord;
void main() {
    TexCoord = vPos.xy;
    gl_Position = vec4((vPos.xy - vec2(0.5, 0.5)) * 2.0, 0.0, 1.0);
}`;

// Fragment shader prefix for unsigned integer input (usampler3D)
const fragShaderPrefixU = `#version 300 es
uniform highp usampler3D intensityVol;
`;

// Fragment shader prefix for signed integer input (isampler3D)
const fragShaderPrefixI = `#version 300 es
uniform highp isampler3D intensityVol;
`;

// Fragment shader prefix for float input (sampler3D)
const fragShaderPrefixF = `#version 300 es
uniform highp sampler3D intensityVol;
`;

const fragShaderBody = `
precision highp int;
precision highp float;
in vec2 TexCoord;
out vec4 FragColor;
uniform float coordZ;
uniform float scl_slope;
uniform float scl_inter;
uniform float cal_max;
uniform float cal_min;
uniform float cal_minNeg;
uniform float cal_maxNeg;
uniform int isAlphaThreshold;
uniform int isColorbarFromZero;
uniform float overlayOpacity;
uniform highp sampler2D colormap;
uniform highp sampler2D colormapNeg;
uniform mat4 mtx;
uniform int isLabel;
uniform float labelMin;
uniform float labelWidth;

void main(void) {
    // Transform output coordinates to input coordinates using the matrix
    vec4 vx = vec4(TexCoord.xy, coordZ, 1.0) * mtx;
    // Check bounds - set transparent if outside input volume
    if ((vx.x < 0.0) || (vx.x > 1.0) ||
        (vx.y < 0.0) || (vx.y > 1.0) ||
        (vx.z < 0.0) || (vx.z > 1.0)) {
        FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }
    // Sample input volume and apply calibration: calibrated = raw * slope + intercept
    float raw = float(texture(intensityVol, vx.xyz).r);
    float f = (scl_slope * raw) + scl_inter;
    // Label colormap: discrete integer index -> LUT color
    if (isLabel != 0) {
        int rawLabel = int(round(f));
        // Index 0 is always unlabeled (air/background) -> transparent
        if (rawLabel == 0) {
            FragColor = vec4(0.0);
            return;
        }
        int labelIdx = rawLabel - int(labelMin);
        int clampedIdx = clamp(labelIdx, 0, int(labelWidth) - 1);
        float texCoord = (float(clampedIdx) + 0.5) / labelWidth;
        FragColor = texture(colormap, vec2(clamp(texCoord, 0.0, 1.0), 0.5));
        if (overlayOpacity > 0.0)
            FragColor.a *= overlayOpacity;
        return;
    }
    // Positive colormap
    float mn = cal_min;
    float mx = cal_max;
    if ((isAlphaThreshold != 0) || (isColorbarFromZero != 0))
        mn = 0.0;
    float r = max(0.00001, abs(mx - mn));
    mn = min(mn, mx);
    float txl = (f - mn) / r;
    if (f > mn) {
        txl = max(txl, 2.0/256.0);
    }
    FragColor = texture(colormap, vec2(clamp(txl, 0.0, 1.0), 0.5)).rgba;
    // Negative colormap
    mn = cal_minNeg;
    mx = cal_maxNeg;
    if ((isAlphaThreshold != 0) || (isColorbarFromZero != 0))
        mx = 0.0;
    if ((cal_minNeg < cal_maxNeg) && (f < mx)) {
        r = max(0.00001, abs(mx - mn));
        mn = min(mn, mx);
        txl = 1.0 - (f - mn) / r;
        txl = max(txl, 2.0/256.0);
        FragColor = texture(colormapNeg, vec2(clamp(txl, 0.0, 1.0), 0.5));
    }
    // Overlay: make alpha binary (fully opaque or fully transparent)
    if (overlayOpacity > 0.0)
        FragColor.a = step(0.00001, FragColor.a);
    // Alpha threshold effects
    if (isAlphaThreshold != 0) {
        if ((cal_minNeg != cal_maxNeg) && (f < 0.0) && (f > cal_maxNeg))
            FragColor.a = pow(-f / -cal_maxNeg, 2.0);
        else if ((f > 0.0) && (cal_min > 0.0))
            FragColor.a *= pow(f / cal_min, 2.0);
    } else if (isColorbarFromZero != 0) {
        if ((cal_minNeg != cal_maxNeg) && (f < 0.0) && (f > cal_maxNeg))
            FragColor.a = 0.0;
        else if ((f > 0.0) && (cal_min > 0.0) && (f < cal_min))
            FragColor.a = 0.0;
    }
    // Bake overlay opacity into alpha for pre-integration
    if (overlayOpacity > 0.0)
        FragColor.a *= overlayOpacity;
}`;

/**
 * Compile a WebGL shader
 * @param {WebGL2RenderingContext} gl - WebGL2 context
 * @param {string} source - Shader source code
 * @param {number} type - Shader type (gl.VERTEX_SHADER or gl.FRAGMENT_SHADER)
 * @returns {WebGLShader} Compiled shader
 */
function compileShader(
  gl: WebGL2RenderingContext,
  source: string,
  type: number,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("orientOverlay: failed to create shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}`);
  }
  return shader;
}

/**
 * Create a shader program from vertex and fragment shaders
 * @param {WebGL2RenderingContext} gl - WebGL2 context
 * @param {string} vertSrc - Vertex shader source
 * @param {string} fragSrc - Fragment shader source
 * @returns {WebGLProgram} Linked shader program
 */
function createProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
): WebGLProgram {
  const vertShader = compileShader(gl, vertSrc, gl.VERTEX_SHADER);
  const fragShader = compileShader(gl, fragSrc, gl.FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertShader);
    gl.deleteShader(fragShader);
    throw new Error("orientOverlay: failed to create program");
  }
  gl.attachShader(program, vertShader);
  gl.attachShader(program, fragShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    gl.deleteShader(vertShader);
    gl.deleteShader(fragShader);
    throw new Error(`Program link error: ${info}`);
  }
  // Clean up individual shaders after linking
  gl.deleteShader(vertShader);
  gl.deleteShader(fragShader);
  return program;
}

/**
 * Create and cache shader programs for different data types
 * @param {WebGL2RenderingContext} gl - WebGL2 context
 * @returns {Object} Object containing shader programs for uint, sint, and float types
 */
function createShaderPrograms(gl: WebGL2RenderingContext): ShaderPrograms {
  return {
    uint: createProgram(gl, vertShader, fragShaderPrefixU + fragShaderBody),
    sint: createProgram(gl, vertShader, fragShaderPrefixI + fragShaderBody),
    float: createProgram(gl, vertShader, fragShaderPrefixF + fragShaderBody),
  };
}

/**
 * Get uniform locations for a shader program
 * @param {WebGL2RenderingContext} gl - WebGL2 context
 * @param {WebGLProgram} program - Shader program
 * @returns {Object} Object containing uniform locations
 */
function getUniformLocations(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
) {
  return {
    coordZ: gl.getUniformLocation(program, "coordZ"),
    scl_slope: gl.getUniformLocation(program, "scl_slope"),
    scl_inter: gl.getUniformLocation(program, "scl_inter"),
    cal_max: gl.getUniformLocation(program, "cal_max"),
    cal_min: gl.getUniformLocation(program, "cal_min"),
    cal_minNeg: gl.getUniformLocation(program, "cal_minNeg"),
    cal_maxNeg: gl.getUniformLocation(program, "cal_maxNeg"),
    isAlphaThreshold: gl.getUniformLocation(program, "isAlphaThreshold"),
    isColorbarFromZero: gl.getUniformLocation(program, "isColorbarFromZero"),
    overlayOpacity: gl.getUniformLocation(program, "overlayOpacity"),
    colormap: gl.getUniformLocation(program, "colormap"),
    colormapNeg: gl.getUniformLocation(program, "colormapNeg"),
    intensityVol: gl.getUniformLocation(program, "intensityVol"),
    mtx: gl.getUniformLocation(program, "mtx"),
    isLabel: gl.getUniformLocation(program, "isLabel"),
    labelMin: gl.getUniformLocation(program, "labelMin"),
    labelWidth: gl.getUniformLocation(program, "labelWidth"),
  };
}

/**
 * Create the full-screen quad geometry
 * @param {WebGL2RenderingContext} gl - WebGL2 context
 * @param {WebGLProgram} program - Shader program to get attribute location from
 * @returns {Object} Object containing VAO and VBO
 */
function createQuadGeometry(gl: WebGL2RenderingContext, program: WebGLProgram) {
  // Full-screen quad vertices (x, y, z) covering 0..1 in UV space
  const vertices = new Float32Array([
    0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0,
  ]);
  const vao = gl.createVertexArray();
  if (!vao) {
    throw new Error("orientOverlay: failed to create VAO");
  }
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  if (!vbo) {
    gl.bindVertexArray(null);
    throw new Error("orientOverlay: failed to create VBO");
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, "vPos");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, vbo };
}

/**
 * Determine WebGL texture format and shader type based on NIfTI datatype code
 * @param {number} datatypeCode - NIfTI datatype code
 * @returns {Object} Object with internalFormat, format, type, shaderType, and TypedArrayConstructor
 */
type TypedArrayCtor = {
  new (buffer: ArrayBufferLike): TypedVoxelArray;
  from?: (arrayLike: ArrayLike<number>) => TypedVoxelArray;
};

type TextureConfig = {
  internalFormat: string;
  format: string;
  type: string;
  shaderType: keyof ShaderPrograms;
  TypedArray: TypedArrayCtor;
  convertTo?: typeof Float32Array;
};

function getTextureConfig(datatypeCode: number): TextureConfig {
  // NIfTI datatype codes
  const DT_UINT8 = 2;
  const DT_INT16 = 4;
  const DT_INT32 = 8;
  const DT_FLOAT32 = 16;
  const DT_FLOAT64 = 64;
  const DT_INT8 = 256;
  const DT_UINT16 = 512;
  const DT_UINT32 = 768;
  switch (datatypeCode) {
    case DT_UINT8:
      return {
        internalFormat: "R8UI",
        format: "RED_INTEGER",
        type: "UNSIGNED_BYTE",
        shaderType: "uint",
        TypedArray: Uint8Array,
      };
    case DT_INT8:
      return {
        internalFormat: "R8I",
        format: "RED_INTEGER",
        type: "BYTE",
        shaderType: "sint",
        TypedArray: Int8Array,
      };
    case DT_UINT16:
      return {
        internalFormat: "R16UI",
        format: "RED_INTEGER",
        type: "UNSIGNED_SHORT",
        shaderType: "uint",
        TypedArray: Uint16Array,
      };
    case DT_INT16:
      return {
        internalFormat: "R16I",
        format: "RED_INTEGER",
        type: "SHORT",
        shaderType: "sint",
        TypedArray: Int16Array,
      };
    case DT_UINT32:
      return {
        internalFormat: "R32UI",
        format: "RED_INTEGER",
        type: "UNSIGNED_INT",
        shaderType: "uint",
        TypedArray: Uint32Array,
      };
    case DT_INT32:
      return {
        internalFormat: "R32I",
        format: "RED_INTEGER",
        type: "INT",
        shaderType: "sint",
        TypedArray: Int32Array,
      };
    case DT_FLOAT32:
      return {
        internalFormat: "R32F",
        format: "RED",
        type: "FLOAT",
        shaderType: "float",
        TypedArray: Float32Array,
      };
    case DT_FLOAT64:
      // WebGL doesn't support 64-bit floats, convert to 32-bit
      return {
        internalFormat: "R32F",
        format: "RED",
        type: "FLOAT",
        shaderType: "float",
        TypedArray: Float64Array,
        convertTo: Float32Array,
      };
    default:
      throw new Error(`Unsupported NIfTI datatype code: ${datatypeCode}`);
  }
}

/**
 * Transform a scalar volume to an RGBA8 3D texture by applying calibration
 * and colormap lookup.
 *
 * @param {WebGL2RenderingContext} gl - WebGL2 context
 * @param {Object} nvimage - Source volume with hdr, img, cal_min, cal_max properties
 * @param {Object} nvimageTarget - Target volume (determines output dimensions via dimsRAS)
 * @param {Float32Array} mtx - 4x4 transformation matrix (output coords -> input coords)
 * @param {boolean} isOverlay - Whether this is an overlay (applies alpha step)
 * @returns {WebGLTexture} 3D RGBA8 texture with colormap-applied data
 */
export function overlay2Texture(
  gl: WebGL2RenderingContext,
  nvimage: NVImage,
  nvimageTarget: NVImage,
  mtx: Float32Array,
  overlayOpacity = 1,
): WebGLTexture {
  if (nvimage.hdr.datatypeCode === 128 || nvimage.hdr.datatypeCode === 2304) {
    return rgba2Texture(gl, nvimage);
  }
  if (!nvimageTarget.dimsRAS) {
    throw new Error("overlay2Texture: nvimageTarget.dimsRAS missing");
  }
  // Get dimensions
  const dimsIn = [
    nvimage.hdr.dims[1] ?? 0,
    nvimage.hdr.dims[2] ?? 0,
    nvimage.hdr.dims[3] ?? 0,
  ];
  const dimsOut = [
    nvimageTarget.dimsRAS[1] ?? 0,
    nvimageTarget.dimsRAS[2] ?? 0,
    nvimageTarget.dimsRAS[3] ?? 0,
  ];
  // Determine texture configuration based on datatype
  const texConfig = getTextureConfig(nvimage.hdr.datatypeCode);
  // Create shader programs (could be cached for efficiency)
  const programs = getOrCreatePrograms(gl);
  const program = programs[texConfig.shaderType];
  gl.useProgram(program);
  // Get uniform locations
  const uniforms = getUniformLocations(gl, program);
  // Create quad geometry
  const { vao, vbo } = createQuadGeometry(gl, program);
  // --- Create input 3D texture ---
  const inputTexture = gl.createTexture();
  if (!inputTexture) {
    gl.deleteBuffer(vbo);
    gl.deleteVertexArray(vao);
    throw new Error("overlay2Texture: failed to create input texture");
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_3D, inputTexture);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  // Prepare image data (offset by frame4D for 4D volumes)
  let imgData = nvimage.img;
  if (!imgData) {
    gl.deleteTexture(inputTexture);
    gl.deleteBuffer(vbo);
    gl.deleteVertexArray(vao);
    throw new Error("overlay2Texture: image data missing");
  }
  const frame = nvimage.frame4D ?? 0;
  const frameElementOffset = frame * nvimage.nVox3D;
  const frameElementLength = nvimage.nVox3D;
  if (texConfig.convertTo) {
    // Convert Float64 to Float32
    const sourceArray =
      imgData instanceof ArrayBuffer
        ? new texConfig.TypedArray(imgData)
        : imgData;
    const fullConverted = texConfig.convertTo.from(sourceArray);
    imgData = fullConverted.subarray(
      frameElementOffset,
      frameElementOffset + frameElementLength,
    ) as TypedVoxelArray;
  } else if (imgData instanceof ArrayBuffer) {
    // Create typed array view directly from ArrayBuffer at frame offset
    const full = new texConfig.TypedArray(imgData) as TypedVoxelArray;
    imgData = full.subarray(
      frameElementOffset,
      frameElementOffset + frameElementLength,
    ) as TypedVoxelArray;
  } else {
    // Create typed array view from existing typed array's buffer at frame offset
    const typed =
      imgData instanceof
      (texConfig.TypedArray as unknown as {
        new (buffer: ArrayBufferLike): TypedVoxelArray;
      })
        ? imgData
        : (new texConfig.TypedArray(imgData.buffer) as TypedVoxelArray);
    imgData = typed.subarray(
      frameElementOffset,
      frameElementOffset + frameElementLength,
    ) as TypedVoxelArray;
  }
  // Upload input texture
  const glAny = gl as WebGL2RenderingContext & Record<string, number>;
  gl.texStorage3D(
    gl.TEXTURE_3D,
    1,
    glAny[texConfig.internalFormat],
    dimsIn[0],
    dimsIn[1],
    dimsIn[2],
  );
  gl.texSubImage3D(
    gl.TEXTURE_3D,
    0,
    0,
    0,
    0,
    dimsIn[0],
    dimsIn[1],
    dimsIn[2],
    glAny[texConfig.format],
    glAny[texConfig.type],
    imgData as ArrayBufferView,
  );
  // --- Create colormap texture(s) ---
  const isLabelVol =
    nvimage.colormapLabel !== null && nvimage.colormapLabel !== undefined;
  const colormapTexture = gl.createTexture();
  if (!colormapTexture) {
    gl.deleteTexture(inputTexture);
    gl.deleteBuffer(vbo);
    gl.deleteVertexArray(vao);
    throw new Error("overlay2Texture: failed to create colormap texture");
  }
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, colormapTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (isLabelVol) {
    // Label colormap: variable-width LUT with nearest filtering
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const labelLut = nvimage.colormapLabel?.lut;
    const nLabels = labelLut.length / 4;
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      nLabels,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      labelLut,
    );
  } else {
    // Continuous colormap: 256-wide LUT with linear filtering
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const lutData = NVCmaps.lutrgba8(nvimage.colormap);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      256,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      lutData,
    );
  }
  // --- Create negative colormap texture ---
  const hasNegColormap =
    !isLabelVol &&
    nvimage.colormapNegative &&
    nvimage.colormapNegative.length > 0;
  const negColormapTexture = gl.createTexture();
  if (!negColormapTexture) {
    gl.deleteTexture(inputTexture);
    gl.deleteTexture(colormapTexture);
    gl.deleteBuffer(vbo);
    gl.deleteVertexArray(vao);
    throw new Error(
      "overlay2Texture: failed to create negative colormap texture",
    );
  }
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, negColormapTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (hasNegColormap) {
    const negLutData = NVCmaps.lutrgba8(nvimage.colormapNegative);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      256,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      negLutData,
    );
  } else {
    // Dummy 1-pixel transparent texture
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]),
    );
  }
  // --- Create output 3D RGBA8 texture ---
  const outputTexture = gl.createTexture();
  if (!outputTexture) {
    gl.deleteTexture(inputTexture);
    gl.deleteTexture(colormapTexture);
    gl.deleteTexture(negColormapTexture);
    gl.deleteBuffer(vbo);
    gl.deleteVertexArray(vao);
    throw new Error("overlay2Texture: failed to create output texture");
  }
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_3D, outputTexture);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texStorage3D(
    gl.TEXTURE_3D,
    1,
    gl.RGBA8,
    dimsOut[0],
    dimsOut[1],
    dimsOut[2],
  );
  // --- Set up framebuffer for render-to-texture ---
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) {
    gl.deleteTexture(inputTexture);
    gl.deleteTexture(colormapTexture);
    gl.deleteTexture(negColormapTexture);
    gl.deleteTexture(outputTexture);
    gl.deleteBuffer(vbo);
    gl.deleteVertexArray(vao);
    throw new Error("overlay2Texture: failed to create framebuffer");
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  // Save current GL state
  const savedViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
  const savedCullFace = gl.isEnabled(gl.CULL_FACE);
  const savedBlend = gl.isEnabled(gl.BLEND);
  const savedDepthTest = gl.isEnabled(gl.DEPTH_TEST);
  const savedActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  const savedVAO = gl.getParameter(
    gl.VERTEX_ARRAY_BINDING,
  ) as WebGLVertexArrayObject | null;
  // Set viewport to output slice dimensions
  gl.viewport(0, 0, dimsOut[0], dimsOut[1]);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  // Bind VAO
  gl.bindVertexArray(vao);
  // Set uniforms
  if (uniforms.intensityVol) gl.uniform1i(uniforms.intensityVol, 0); // Input texture unit
  if (uniforms.colormap) gl.uniform1i(uniforms.colormap, 1); // Positive colormap unit
  if (uniforms.colormapNeg) gl.uniform1i(uniforms.colormapNeg, 2); // Negative colormap unit
  const u = buildOrientUniforms(nvimage, overlayOpacity);
  if (uniforms.scl_slope) gl.uniform1f(uniforms.scl_slope, u.slope);
  if (uniforms.scl_inter) gl.uniform1f(uniforms.scl_inter, u.intercept);
  if (uniforms.cal_min) gl.uniform1f(uniforms.cal_min, u.calMin);
  if (uniforms.cal_max) gl.uniform1f(uniforms.cal_max, u.calMax);
  if (uniforms.cal_minNeg) gl.uniform1f(uniforms.cal_minNeg, u.mnNeg);
  if (uniforms.cal_maxNeg) gl.uniform1f(uniforms.cal_maxNeg, u.mxNeg);
  if (uniforms.isAlphaThreshold)
    gl.uniform1i(uniforms.isAlphaThreshold, u.isAlphaThreshold);
  if (uniforms.isColorbarFromZero)
    gl.uniform1i(uniforms.isColorbarFromZero, u.isColorbarFromZero);
  if (uniforms.overlayOpacity)
    gl.uniform1f(uniforms.overlayOpacity, u.overlayOpacity);
  if (uniforms.mtx) gl.uniformMatrix4fv(uniforms.mtx, false, mtx);
  if (uniforms.isLabel) gl.uniform1i(uniforms.isLabel, u.isLabel);
  if (uniforms.labelMin) gl.uniform1f(uniforms.labelMin, u.labelMin);
  if (uniforms.labelWidth) gl.uniform1f(uniforms.labelWidth, u.labelWidth);
  // Render each output slice
  for (let z = 0; z < dimsOut[2]; z++) {
    // Compute normalized z coordinate (center of voxel)
    const coordZ = (z + 0.5) / dimsOut[2];
    if (uniforms.coordZ) gl.uniform1f(uniforms.coordZ, coordZ);
    // Attach output texture slice to framebuffer
    gl.framebufferTextureLayer(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      outputTexture,
      0,
      z,
    );
    // Draw quad
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // --- Cleanup ---
  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  // Restore viewport
  gl.viewport(
    savedViewport[0],
    savedViewport[1],
    savedViewport[2],
    savedViewport[3],
  );
  // Restore GL state
  if (savedCullFace) gl.enable(gl.CULL_FACE);
  else gl.disable(gl.CULL_FACE);
  if (savedBlend) gl.enable(gl.BLEND);
  else gl.disable(gl.BLEND);
  if (savedDepthTest) gl.enable(gl.DEPTH_TEST);
  else gl.disable(gl.DEPTH_TEST);
  gl.activeTexture(savedActiveTexture);
  gl.bindVertexArray(savedVAO);
  // Unbind textures from the units we used
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_3D, null);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_3D, null);
  gl.activeTexture(savedActiveTexture);
  // Delete temporary resources
  gl.deleteTexture(inputTexture);
  gl.deleteTexture(colormapTexture);
  gl.deleteTexture(negColormapTexture);
  gl.deleteBuffer(vbo);
  gl.deleteVertexArray(vao);
  gl.deleteFramebuffer(framebuffer);
  return outputTexture;
}

/**
 * Read a 3D RGBA8 texture back to CPU as a Uint8Array.
 * Used for multi-overlay blending where intermediate textures must be combined on CPU.
 */
export function readTexture3D(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  dims: number[],
): Uint8Array {
  const [w, h, d] = dims;
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error("readTexture3D: failed to create framebuffer");
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const result = new Uint8Array(w * h * d * 4);
  for (let z = 0; z < d; z++) {
    gl.framebufferTextureLayer(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      texture,
      0,
      z,
    );
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, result, z * w * h * 4);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  return result;
}

/**
 * Mask overlay texture by background volume: zero out overlay alpha wherever
 * the background volume alpha is zero. Modifies the overlay texture in-place.
 */
export function maskOverlayByBackground(
  gl: WebGL2RenderingContext,
  volumeTexture: WebGLTexture,
  overlayTexture: WebGLTexture,
  dims: number[],
): void {
  const bgData = readTexture3D(gl, volumeTexture, dims);
  const ovData = readTexture3D(gl, overlayTexture, dims);
  const nVox = dims[0] * dims[1] * dims[2];
  for (let i = 0; i < nVox; i++) {
    if (bgData[i * 4 + 3] === 0) {
      ovData[i * 4 + 3] = 0;
    }
  }
  gl.bindTexture(gl.TEXTURE_3D, overlayTexture);
  gl.texSubImage3D(
    gl.TEXTURE_3D,
    0,
    0,
    0,
    0,
    dims[0],
    dims[1],
    dims[2],
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    ovData,
  );
  gl.bindTexture(gl.TEXTURE_3D, null);
}

export function destroy(gl: WebGL2RenderingContext): void {
  // If there is no cache for this context, nothing to do
  const cache = _programCache.get(gl);
  if (!cache) return;
  // Delete each cached program (uint, sint, float)
  for (const key of Object.keys(cache) as Array<keyof ShaderPrograms>) {
    const program = cache[key];
    if (program) {
      try {
        gl.deleteProgram(program);
      } catch (err) {
        // swallow errors — deleting already-deleted programs is harmless,
        // but different browsers may throw in edge cases
        log.warn("orientOverlay.destroy: failed to delete program", key, err);
      }
    }
  }
  // Remove reference from WeakMap so GC can collect
  _programCache.delete(gl);
}
