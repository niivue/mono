import { decompress } from '@/codecs/NVGz'
import { log } from '@/logger'
import type { ColorMap, MZ3 } from '@/NVTypes'
import { makeLabelLut } from '../../cmap/NVCmaps.js'

declare const Buffer:
  | { from: (value: string, encoding: string) => Uint8Array }
  | undefined

type XmlTag = {
  name: string
  startPos: number
  contentStartPos: number
  contentEndPos: number
  endPos: number
}

export const extensions = ['GII']
export const type = 'mz3'

function toArrayBuffer(raw: Uint8Array): ArrayBuffer {
  return raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength,
  ) as ArrayBuffer
}

function viewToArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  ) as ArrayBuffer
}

function base64ToUint8(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'))
  }
  const binaryString = atob(base64)
  const len = binaryString.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

export async function read(buffer: ArrayBuffer, n_vert = 0): Promise<MZ3> {
  let len = buffer.byteLength
  if (len < 20) {
    throw new Error(`File too small to be GII: bytes = ${len}`)
  }
  let chars = new TextDecoder('ascii').decode(buffer)
  if (chars[0].charCodeAt(0) === 31) {
    // raw GIFTI saved as .gii.gz is smaller than gz GIFTI due to base64 overhead
    const raw = await decompress(new Uint8Array(buffer))
    buffer = toArrayBuffer(raw)
    chars = new TextDecoder('ascii').decode(buffer)
  }
  let pos = 0
  function readXMLtag(): XmlTag {
    let isEmptyTag = true
    let startPos = pos
    while (isEmptyTag) {
      while (pos < len && chars[pos] !== '<') {
        pos++
      }
      startPos = pos
      while (pos < len && chars[pos] !== '>') {
        pos++
      }
      isEmptyTag = chars[pos - 1] === '/'
      if (startPos + 1 < len && chars[startPos + 1] === '/') {
        pos += 1
        isEmptyTag = true
      }
      if (pos >= len) {
        break
      }
    }
    const tagString = new TextDecoder()
      .decode(buffer.slice(startPos + 1, pos))
      .trim()
    const startTag = tagString.split(' ')[0].trim()
    const contentStartPos = pos
    let contentEndPos = pos
    let endPos = pos
    if (chars[startPos + 1] !== '?' && chars[startPos + 1] !== '!') {
      const endTag = `</${startTag}>`
      contentEndPos = chars.indexOf(endTag, contentStartPos)
      endPos = contentEndPos + endTag.length - 1
    }
    return {
      name: tagString,
      startPos,
      contentStartPos,
      contentEndPos,
      endPos,
    }
  }
  let tag = readXMLtag()
  if (!tag.name.startsWith('?xml')) {
    throw new Error('readGII: Invalid XML file')
  }
  while (!tag.name.startsWith('GIFTI') && tag.endPos < len) {
    tag = readXMLtag()
  }
  if (
    !tag.name.startsWith('GIFTI') ||
    tag.contentStartPos === tag.contentEndPos
  ) {
    throw new Error('readGII: XML file does not include GIFTI tag')
  }
  len = tag.contentEndPos
  let positions = new Float32Array()
  let indices = new Uint32Array()
  let scalars = new Float32Array()
  let anatomicalStructurePrimary = ''
  let isIdx = false
  let isPts = false
  let isVectors = false
  let isColMajor = false
  let Dims = [1, 1, 1]
  const FreeSurferTranlate = [0, 0, 0]
  let dataType = 0
  let isGzip = false
  let isASCII = false
  let nvert = 0
  let isDataSpaceScanner = false
  tag.endPos = tag.contentStartPos
  let line = ''
  function readNumericTag(tagName: string, isFloat = false): number {
    const p = line.indexOf(tagName)
    if (p < 0) {
      return 1
    }
    const spos = line.indexOf('"', p) + 1
    const epos = line.indexOf('"', spos)
    const str = line.slice(spos, epos)
    if (isFloat) {
      return parseFloat(str)
    }
    return parseInt(str, 10)
  }
  function readBracketTag(tagName: string): string {
    const p = line.indexOf(tagName)
    if (p < 0) {
      return ''
    }
    const spos = p + tagName.length
    const epos = line.indexOf(']', spos)
    return line.slice(spos, epos)
  }
  const Labels: ColorMap = { R: [], G: [], B: [], A: [], I: [], labels: [] }
  while (tag.endPos < len && tag.name.length > 1) {
    tag = readXMLtag()
    if (tag.name.startsWith('Label Key')) {
      line = tag.name
      Labels.I.push(readNumericTag('Key='))
      Labels.R.push(Math.round(255 * readNumericTag('Red=', true)))
      Labels.G.push(Math.round(255 * readNumericTag('Green=', true)))
      Labels.B.push(Math.round(255 * readNumericTag('Blue=', true)))
      Labels.A.push(Math.round(255 * readNumericTag('Alpha', true)))
      line = new TextDecoder()
        .decode(buffer.slice(tag.contentStartPos + 1, tag.contentEndPos))
        .trim()
      Labels.labels?.push(readBracketTag('<![CDATA['))
    }
    if (tag.name.trim() === 'Data') {
      if (isVectors) {
        continue
      }
      line = new TextDecoder()
        .decode(buffer.slice(tag.contentStartPos + 1, tag.contentEndPos))
        .trim()
      let datBin: Int32Array | Float32Array | Uint8Array
      if (isASCII) {
        const nvert = Dims[0] * Dims[1] * Dims[2]
        const lines = line.split(/\s+/)
        if (nvert !== lines.length) {
          throw new Error('Unable to parse ASCII GIfTI')
        }
        if (dataType === 2) {
          dataType = 8
        }
        if (dataType === 32) {
          dataType = 16
        }
        if (dataType === 8) {
          datBin = new Int32Array(nvert)
          for (let v = 0; v < nvert; v++) {
            datBin[v] = parseInt(lines[v], 10)
          }
        } else {
          datBin = new Float32Array(nvert)
          for (let v = 0; v < nvert; v++) {
            datBin[v] = parseFloat(lines[v])
          }
        }
      } else {
        if (isGzip) {
          const datZ = base64ToUint8(line.slice())
          datBin = await decompress(new Uint8Array(datZ))
        } else {
          datBin = base64ToUint8(line.slice())
        }
      }
      if (isPts) {
        if (dataType !== 16) {
          log.warn('expect positions as FLOAT32')
        }
        positions = new Float32Array(
          viewToArrayBuffer(datBin as ArrayBufferView),
        )
        if (isColMajor) {
          const tmp = positions.slice()
          const np = tmp.length / 3
          let j = 0
          for (let p = 0; p < np; p++) {
            for (let i = 0; i < 3; i++) {
              positions[j] = tmp[i * np + p]
              j++
            }
          }
        }
      } else if (isIdx) {
        if (dataType !== 8) {
          log.warn('expect indices as INT32')
        }
        indices = new Uint32Array(viewToArrayBuffer(datBin as ArrayBufferView))
        if (isColMajor) {
          const tmp = indices.slice()
          const np = tmp.length / 3
          let j = 0
          for (let p = 0; p < np; p++) {
            for (let i = 0; i < 3; i++) {
              indices[j] = tmp[i * np + p]
              j++
            }
          }
        }
      } else {
        nvert = Dims[0] * Dims[1] * Dims[2]
        if (n_vert !== 0) {
          if (nvert % n_vert !== 0) {
            log.warn(
              `Number of vertices in scalar overlay (${nvert}) does not match mesh (${n_vert})`,
            )
          }
        }
        function float32Concat(
          first: Float32Array,
          second: Float32Array,
        ): Float32Array {
          const firstLength = first.length
          const result = new Float32Array(firstLength + second.length)
          result.set(first)
          result.set(second, firstLength)
          return result
        }
        let scalarsNew: Float32Array
        if (dataType === 2) {
          const scalarsInt = new Uint8Array(
            viewToArrayBuffer(datBin as ArrayBufferView),
          )
          scalarsNew = Float32Array.from(scalarsInt)
        } else if (dataType === 8) {
          const scalarsInt = new Int32Array(
            viewToArrayBuffer(datBin as ArrayBufferView),
          )
          scalarsNew = Float32Array.from(scalarsInt)
        } else if (dataType === 16) {
          scalarsNew = new Float32Array(
            viewToArrayBuffer(datBin as ArrayBufferView),
          )
        } else if (dataType === 32) {
          const scalarFloat = new Float64Array(
            viewToArrayBuffer(datBin as ArrayBufferView),
          )
          scalarsNew = Float32Array.from(scalarFloat)
        } else {
          throw new Error(`Invalid dataType: ${dataType}`)
        }
        scalars = float32Concat(
          scalars,
          scalarsNew,
        ) as Float32Array<ArrayBuffer>
      }
      continue
    }
    if (tag.name.trim() === 'DataSpace') {
      line = new TextDecoder()
        .decode(buffer.slice(tag.contentStartPos + 1, tag.contentEndPos))
        .trim()
      if (line.includes('NIFTI_XFORM_SCANNER_ANAT')) {
        isDataSpaceScanner = true
      }
    }
    if (tag.name.trim() === 'MD') {
      line = new TextDecoder()
        .decode(buffer.slice(tag.contentStartPos + 1, tag.contentEndPos))
        .trim()
      if (
        line.includes('AnatomicalStructurePrimary') &&
        line.includes('CDATA[')
      ) {
        anatomicalStructurePrimary =
          readBracketTag('<Value><![CDATA[').toUpperCase()
      }
      if (line.includes('VolGeom') && line.includes('CDATA[')) {
        let e = -1
        if (line.includes('VolGeomC_R')) {
          e = 0
        }
        if (line.includes('VolGeomC_A')) {
          e = 1
        }
        if (line.includes('VolGeomC_S')) {
          e = 2
        }
        if (e < 0) {
          continue
        }
        FreeSurferTranlate[e] = parseFloat(readBracketTag('<Value><![CDATA['))
      }
    }
    if (!tag.name.startsWith('DataArray')) {
      continue
    }
    line = tag.name
    Dims = [1, 1, 1]
    isGzip = line.includes('Encoding="GZipBase64Binary"')
    isASCII = line.includes('Encoding="ASCII"')
    isIdx = line.includes('Intent="NIFTI_INTENT_TRIANGLE"')
    isPts = line.includes('Intent="NIFTI_INTENT_POINTSET"')
    isVectors = line.includes('Intent="NIFTI_INTENT_VECTOR"')
    isColMajor = line.includes('ArrayIndexingOrder="ColumnMajorOrder"')
    if (line.includes('DataType="NIFTI_TYPE_UINT8"')) {
      dataType = 2
    }
    if (line.includes('DataType="NIFTI_TYPE_INT32"')) {
      dataType = 8
    }
    if (line.includes('DataType="NIFTI_TYPE_FLOAT32"')) {
      dataType = 16
    }
    if (line.includes('DataType="NIFTI_TYPE_FLOAT64"')) {
      dataType = 32
    }
    Dims[0] = readNumericTag('Dim0=')
    Dims[1] = readNumericTag('Dim1=')
    Dims[2] = readNumericTag('Dim2=')
  }
  let colormapLabel: unknown
  if (Labels.I.length > 1) {
    const hasAlpha = Labels.A.some((a) => a > 0)
    if (!hasAlpha) {
      Labels.A.fill(255)
    }
    colormapLabel = makeLabelLut(Labels)
  }
  if (n_vert > 0) {
    const out: MZ3 & { anatomicalStructurePrimary?: string } = {
      scalars,
      colormapLabel,
    }
    out.anatomicalStructurePrimary = anatomicalStructurePrimary
    return out as MZ3
  }
  if (
    positions.length > 2 &&
    !isDataSpaceScanner &&
    (FreeSurferTranlate[0] !== 0 ||
      FreeSurferTranlate[1] !== 0 ||
      FreeSurferTranlate[2] !== 0)
  ) {
    nvert = Math.floor(positions.length / 3)
    let i = 0
    for (let v = 0; v < nvert; v++) {
      positions[i] += FreeSurferTranlate[0]
      i++
      positions[i] += FreeSurferTranlate[1]
      i++
      positions[i] += FreeSurferTranlate[2]
      i++
    }
  }
  const out: MZ3 & { anatomicalStructurePrimary?: string } = {
    positions,
    indices,
    scalars,
    colormapLabel,
  }
  out.anatomicalStructurePrimary = anatomicalStructurePrimary
  return out as MZ3
}
