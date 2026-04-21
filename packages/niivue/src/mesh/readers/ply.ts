import type { MZ3 } from '@/NVTypes'

declare const log: {
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export const extensions = ['PLY']
export const type = 'mz3'
// read PLY format
// https://en.wikipedia.org/wiki/PLY_(file_format)
export async function read(buffer: ArrayBuffer): Promise<MZ3> {
  const len = buffer.byteLength
  const bytes = new Uint8Array(buffer)
  let pos = 0
  function readStr(): string {
    while (pos < len && bytes[pos] === 10) {
      pos++
    } // skip blank lines
    const startPos = pos
    while (pos < len && bytes[pos] !== 10) {
      pos++
    }
    pos++ // skip EOLN
    if (pos - startPos < 1) {
      return ''
    }
    return new TextDecoder().decode(buffer.slice(startPos, pos - 1))
  }
  let line = readStr() // 1st line: magic 'ply'
  if (!line.startsWith('ply')) {
    throw new Error('Not a valid PLY file')
  }
  line = readStr() // 2nd line: format 'format binary_little_endian 1.0'
  const isAscii = line.includes('ascii')
  function dataTypeBytes(str: string): number {
    if (
      str === 'char' ||
      str === 'uchar' ||
      str === 'int8' ||
      str === 'uint8'
    ) {
      return 1
    }
    if (
      str === 'short' ||
      str === 'ushort' ||
      str === 'int16' ||
      str === 'uint16'
    ) {
      return 2
    }
    if (
      str === 'int' ||
      str === 'uint' ||
      str === 'int32' ||
      str === 'uint32' ||
      str === 'float' ||
      str === 'float32'
    ) {
      return 4
    }
    if (str === 'double') {
      return 8
    }
    throw new Error(`Unknown data type: ${str}`)
  }
  const isLittleEndian = line.includes('binary_little_endian')
  let nvert = 0
  let vertIsDouble = false
  let vertStride = 0 // e.g. if each vertex stores xyz as float32 and rgb as uint8, stride is 15
  let indexStrideBytes = 0 // "list uchar int vertex_indices" has stride 1 + 3 * 4
  let indexCountBytes = 0 // if "property list uchar int vertex_index" this is 1 (uchar)
  let indexBytes = 0 // if "property list uchar int vertex_index" this is 4 (int)
  let indexPaddingBytes = 0
  let nIndexPadding = 0
  let nface = 0
  const vertexProps: string[] = []
  let currVertPropOffset = 0
  let redOffset = -1
  let greenOffset = -1
  let blueOffset = -1
  let hasColors = false
  while (pos < len && !line.startsWith('end_header')) {
    line = readStr()
    if (line.startsWith('comment')) {
      continue
    }
    // line = line.replaceAll('\t', ' '); // ?are tabs valid white space?
    let items = line.split(/\s/)
    if (line.startsWith('element vertex')) {
      nvert = parseInt(items[items.length - 1], 10)
      // read vertex properties:
      line = readStr()
      items = line.split(/\s/)
      currVertPropOffset = 0
      vertexProps.length = 0
      while (line.startsWith('property')) {
        const datatype = items[1]
        const propName = items[2]
        // record property name (for ASCII token mapping)
        vertexProps.push(propName)
        // record offsets for color components (for binary parsing)
        if (propName === 'red') {
          redOffset = currVertPropOffset
          hasColors = true
        } else if (propName === 'green') {
          greenOffset = currVertPropOffset
          hasColors = true
        } else if (propName === 'blue') {
          blueOffset = currVertPropOffset
          hasColors = true
        }
        if (propName === 'x' && datatype.startsWith('double')) {
          vertIsDouble = true
        } else if (propName === 'x' && !datatype.startsWith('float')) {
          log.error(`Error: expect ply xyz to be float or double: ${line}`)
        }
        const bytes = dataTypeBytes(datatype)
        vertStride += bytes
        currVertPropOffset += bytes
        line = readStr()
        items = line.split(/\s/)
      }
    }
    if (line.startsWith('element face')) {
      nface = parseInt(items[items.length - 1], 10)
      // read face properties:
      line = readStr()
      items = line.split(/\s/)
      while (line.startsWith('property')) {
        if (items[1] === 'list') {
          indexCountBytes = dataTypeBytes(items[2])
          indexBytes = dataTypeBytes(items[3])
          indexStrideBytes += indexCountBytes + 3 * indexBytes // e.g. "uchar int" is 1 + 3 * 4 bytes
        } else {
          const bytes = dataTypeBytes(items[1])
          indexStrideBytes += bytes
          if (indexBytes === 0) {
            // this index property is BEFORE the list
            indexPaddingBytes += bytes
            nIndexPadding++
          }
        }
        line = readStr()
        items = line.split(/\s/)
      }
    }
  } // while reading all lines of header
  if (isAscii) {
    if (nface < 1) {
      log.error(`Malformed ply format: faces ${nface} `)
    }
    const positions = new Float32Array(nvert * 3)
    let colors: Float32Array | undefined
    // find ascii token indices for x,y,z and rgb if present
    const idxX = vertexProps.indexOf('x')
    const idxY = vertexProps.indexOf('y')
    const idxZ = vertexProps.indexOf('z')
    const idxR = vertexProps.indexOf('red')
    const idxG = vertexProps.indexOf('green')
    const idxB = vertexProps.indexOf('blue')
    if (idxR !== -1 && idxG !== -1 && idxB !== -1) {
      colors = new Float32Array(nvert * 3)
      hasColors = true
    }
    let v = 0
    for (let i = 0; i < nvert; i++) {
      line = readStr()
      const items = line.split(/\s/)
      // read xyz using property indices (fallback to 0,1,2 if not found)
      const tx = idxX >= 0 ? parseFloat(items[idxX]) : parseFloat(items[0])
      const ty = idxY >= 0 ? parseFloat(items[idxY]) : parseFloat(items[1])
      const tz = idxZ >= 0 ? parseFloat(items[idxZ]) : parseFloat(items[2])
      positions[v] = tx
      positions[v + 1] = ty
      positions[v + 2] = tz
      if (hasColors && colors) {
        const rr = idxR >= 0 ? parseInt(items[idxR], 10) : 0
        const gg = idxG >= 0 ? parseInt(items[idxG], 10) : 0
        const bb = idxB >= 0 ? parseInt(items[idxB], 10) : 0
        const vi = i * 3
        colors[vi] = rr / 255.0
        colors[vi + 1] = gg / 255.0
        colors[vi + 2] = bb / 255.0
      }
      v += 3
    }
    let indices = new Uint32Array(nface * 3)
    let f = 0
    for (let i = 0; i < nface; i++) {
      line = readStr()
      const items = line.split(/\s/)
      const nTri = parseInt(items[nIndexPadding], 10) - 2
      if (nTri < 1) {
        break
      } // error
      if (f + nTri * 3 > indices.length) {
        const c = new Uint32Array(indices.length + indices.length)
        c.set(indices)
        indices = c.slice()
      }
      const idx0 = parseInt(items[nIndexPadding + 1], 10)
      let idx1 = parseInt(items[nIndexPadding + 2], 10)
      for (let j = 0; j < nTri; j++) {
        const idx2 = parseInt(items[nIndexPadding + 3 + j], 10)
        indices[f + 0] = idx0
        indices[f + 1] = idx1
        indices[f + 2] = idx2
        idx1 = idx2
        f += 3
      }
    }
    if (indices.length !== f) {
      indices = indices.slice(0, f)
    }
    const out: MZ3 = {
      positions,
      indices,
    }
    if (hasColors) {
      // colors was created only when we detected rgb properties
      out.colors = typeof colors !== 'undefined' ? colors : undefined
    }
    return out
  } // if isAscii
  if (vertStride < 12 || indexCountBytes < 1 || indexBytes < 1 || nface < 1) {
    log.warn(
      `Malformed ply format: stride ${vertStride} count ${indexCountBytes} iBytes ${indexBytes} iStrideBytes ${indexStrideBytes} iPadBytes ${indexPaddingBytes} faces ${nface}`,
    )
  }
  const reader = new DataView(buffer)
  let positions: Float32Array
  let colors: Float32Array | undefined
  if (hasColors) {
    colors = new Float32Array(nvert * 3)
  }
  if (pos % 4 === 0 && vertStride === 12 && isLittleEndian) {
    // optimization: vertices only store xyz position as float
    // n.b. start offset of Float32Array must be a multiple of 4
    positions = new Float32Array(buffer, pos, nvert * 3)
    pos += nvert * vertStride
    // if colors are present they wouldn't be in this optimized path (vertStride would be >12)
  } else {
    positions = new Float32Array(nvert * 3)
    let v = 0
    for (let i = 0; i < nvert; i++) {
      if (vertIsDouble) {
        positions[v] = reader.getFloat64(pos, isLittleEndian)
        positions[v + 1] = reader.getFloat64(pos + 8, isLittleEndian)
        positions[v + 2] = reader.getFloat64(pos + 16, isLittleEndian)
      } else {
        positions[v] = reader.getFloat32(pos, isLittleEndian)
        positions[v + 1] = reader.getFloat32(pos + 4, isLittleEndian)
        positions[v + 2] = reader.getFloat32(pos + 8, isLittleEndian)
      }
      if (hasColors && colors) {
        // read uchar rgb at recorded offsets (if set)
        const base = pos
        const r = redOffset >= 0 ? reader.getUint8(base + redOffset) : 0
        const g = greenOffset >= 0 ? reader.getUint8(base + greenOffset) : 0
        const b = blueOffset >= 0 ? reader.getUint8(base + blueOffset) : 0
        const vi = i * 3
        colors[vi] = r / 255.0
        colors[vi + 1] = g / 255.0
        colors[vi + 2] = b / 255.0
      }
      v += 3
      pos += vertStride
    }
  }
  const indices = new Uint32Array(nface * 3) // assume triangular mesh: pre-allocation optimization
  let isTriangular = true
  let j = 0
  if (indexCountBytes === 1 && indexBytes === 4 && indexStrideBytes === 13) {
    // default mode: "list uchar int vertex_indices" without other properties
    for (let i = 0; i < nface; i++) {
      const nIdx = reader.getUint8(pos)
      pos += indexCountBytes
      if (nIdx !== 3) {
        isTriangular = false
      }
      indices[j] = reader.getUint32(pos, isLittleEndian)
      pos += 4
      indices[j + 1] = reader.getUint32(pos, isLittleEndian)
      pos += 4
      indices[j + 2] = reader.getUint32(pos, isLittleEndian)
      pos += 4
      j += 3
    }
  } else {
    // not 1:4 index data
    let startPos = pos
    for (let i = 0; i < nface; i++) {
      pos = startPos + indexPaddingBytes
      let nIdx = 0
      if (indexCountBytes === 1) {
        nIdx = reader.getUint8(pos)
      } else if (indexCountBytes === 2) {
        nIdx = reader.getUint16(pos, isLittleEndian)
      } else if (indexCountBytes === 4) {
        nIdx = reader.getUint32(pos, isLittleEndian)
      }
      pos += indexCountBytes
      if (nIdx !== 3) {
        isTriangular = false
      }
      for (let k = 0; k < 3; k++) {
        if (indexBytes === 1) {
          indices[j] = reader.getUint8(pos)
        } else if (indexBytes === 2) {
          indices[j] = reader.getUint16(pos, isLittleEndian)
        } else if (indexBytes === 4) {
          indices[j] = reader.getUint32(pos, isLittleEndian)
        }
        j++
        pos += indexBytes
      }
      startPos += indexStrideBytes
    } // for each face
  } // if not 1:4 datatype
  if (!isTriangular) {
    log.warn('Only able to read PLY meshes limited to triangles.')
  }
  const out: MZ3 = {
    positions,
    indices,
  }
  if (hasColors && typeof colors !== 'undefined') {
    out.colors = colors
  }
  return out
} // readPLY()
