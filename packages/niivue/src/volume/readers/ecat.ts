import * as nifti from 'nifti-reader-js'
import { log } from '@/logger'
import { NiiDataType } from '@/NVConstants'
import type { NIFTI1, NIFTI2, TypedVoxelArray } from '@/NVTypes'

export const extensions = ['v']
export const type = 'nii'

export function read(
  buffer: ArrayBuffer,
  _name?: string,
  _pairedImgData: ArrayBuffer | null = null,
): { hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray } {
  const hdr = new nifti.NIFTI1() as NIFTI1
  hdr.dims = [3, 1, 1, 1, 0, 0, 0, 0]
  hdr.pixDims = [1, 1, 1, 1, 1, 0, 0, 0]
  const reader = new DataView(buffer)

  const signature = reader.getInt32(0, false)
  const filetype = reader.getInt16(50, false)
  if (signature !== 1296127058 || filetype < 1 || filetype > 14) {
    throw new Error('Not a valid ECAT file')
  }

  let pos = 512
  let vols = 0
  const frame_duration: number[] = []
  let rawImg = new Float32Array()
  while (true) {
    const hdr0 = reader.getInt32(pos, false)
    const hdr3 = reader.getInt32(pos + 12, false)
    if (hdr0 + hdr3 !== 31) {
      break
    }
    let lpos = pos + 20
    let r = 0
    let voloffset = 0
    while (r < 31) {
      voloffset = reader.getInt32(lpos, false)
      lpos += 16
      if (voloffset === 0) {
        break
      }
      r++
      let ipos = voloffset * 512
      const spos = ipos - 512
      const data_type = reader.getUint16(spos, false)
      hdr.dims[1] = reader.getUint16(spos + 4, false)
      hdr.dims[2] = reader.getUint16(spos + 6, false)
      hdr.dims[3] = reader.getUint16(spos + 8, false)
      const scale_factor = reader.getFloat32(spos + 26, false)
      hdr.pixDims[1] = reader.getFloat32(spos + 34, false) * 10.0
      hdr.pixDims[2] = reader.getFloat32(spos + 38, false) * 10.0
      hdr.pixDims[3] = reader.getFloat32(spos + 42, false) * 10.0
      hdr.pixDims[4] = reader.getUint32(spos + 46, false) / 1000.0
      frame_duration.push(hdr.pixDims[4])
      const nvox3D = hdr.dims[1] * hdr.dims[2] * hdr.dims[3]
      const newImg = new Float32Array(nvox3D)
      if (data_type === 1) {
        for (let i = 0; i < nvox3D; i++) {
          newImg[i] = reader.getUint8(ipos) * scale_factor
          ipos++
        }
      } else if (data_type === 6) {
        for (let i = 0; i < nvox3D; i++) {
          newImg[i] = reader.getUint16(ipos, false) * scale_factor
          ipos += 2
        }
      } else if (data_type === 7) {
        for (let i = 0; i < nvox3D; i++) {
          newImg[i] = reader.getUint32(ipos, false) * scale_factor
          ipos += 4
        }
      } else {
        log.warn(`Unknown ECAT data type ${data_type}`)
      }
      const prevImg = rawImg.slice(0)
      rawImg = new Float32Array(prevImg.length + newImg.length)
      rawImg.set(prevImg)
      rawImg.set(newImg, prevImg.length)
      vols++
    }
    if (voloffset === 0) break
    pos += 512
  }

  hdr.dims[4] = vols
  hdr.pixDims[4] = frame_duration[0]
  if (vols > 1) {
    hdr.dims[0] = 4
    let isFDvaries = false
    for (let i = 0; i < vols; i++) {
      if (frame_duration[i] !== frame_duration[0]) isFDvaries = true
    }
    if (isFDvaries) log.warn('Frame durations vary')
  }
  hdr.sform_code = 1
  hdr.affine = [
    [-hdr.pixDims[1], 0, 0, (hdr.dims[1] - 2) * 0.5 * hdr.pixDims[1]],
    [0, -hdr.pixDims[2], 0, (hdr.dims[2] - 2) * 0.5 * hdr.pixDims[2]],
    [0, 0, -hdr.pixDims[3], (hdr.dims[3] - 2) * 0.5 * hdr.pixDims[3]],
    [0, 0, 0, 1],
  ]
  hdr.numBitsPerVoxel = 32
  hdr.datatypeCode = NiiDataType.DT_FLOAT32

  return { hdr, img: rawImg.buffer as ArrayBuffer }
}
