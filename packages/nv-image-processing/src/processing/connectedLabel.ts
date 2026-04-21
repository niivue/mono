/**
 * Connected component labeling — pure computation.
 *
 * Port of https://github.com/rordenlab/niimath/blob/master/src/bwlabel.c
 */

export interface ConnectedLabelInput {
  img: ArrayLike<number> | ArrayBuffer
  datatypeCode: number
  dims: number[]
  conn?: number
  binarize?: boolean
  onlyLargestClusterPerClass?: boolean
}

export interface ConnectedLabelOutput {
  img: ArrayBufferView
  datatypeCode: number
  bitsPerVoxel: number
  calMax: number
}

function toTypedView(
  img: ArrayLike<number> | ArrayBuffer,
  dt: number,
): ArrayLike<number> {
  if (!(img instanceof ArrayBuffer)) return img
  switch (dt) {
    case 2:
      return new Uint8Array(img)
    case 4:
      return new Int16Array(img)
    case 8:
      return new Int32Array(img)
    case 16:
      return new Float32Array(img)
    case 64:
      return new Float64Array(img)
    case 256:
      return new Int8Array(img)
    case 512:
      return new Uint16Array(img)
    case 768:
      return new Uint32Array(img)
    default:
      return new Float32Array(img)
  }
}

function idx(A: number, B: number, C: number, DIM: Uint32Array): number {
  return C * DIM[0] * DIM[1] + B * DIM[0] + A
}

function fill_tratab(tt: Uint32Array, nabo: Uint32Array, nr_set: number): void {
  let cntr = 0
  const tn = new Uint32Array(nr_set + 5).fill(0)
  const INT_MAX = 2147483647
  let ltn = INT_MAX
  for (let i = 0; i < nr_set; i++) {
    let j = nabo[i]
    cntr = 0
    while (tt[j - 1] !== j) {
      j = tt[j - 1]
      cntr++
      if (cntr > 100) break
    }
    tn[i] = j
    ltn = Math.min(ltn, j)
  }
  for (let i = 0; i < nr_set; i++) {
    tt[tn[i] - 1] = ltn
  }
}

function check_previous_slice(
  bw: Uint32Array,
  il: Uint32Array,
  r: number,
  c: number,
  sl: number,
  dim: Uint32Array,
  conn: number,
  tt: Uint32Array,
): number {
  const nabo = new Uint32Array(27)
  let nr_set = 0
  if (!sl) return 0
  const val = bw[idx(r, c, sl, dim)]
  if (conn >= 6) {
    const i = idx(r, c, sl - 1, dim)
    if (val === bw[i]) nabo[nr_set++] = il[i]
  }
  if (conn >= 18) {
    if (r) {
      const i = idx(r - 1, c, sl - 1, dim)
      if (val === bw[i]) nabo[nr_set++] = il[i]
    }
    if (c) {
      const i = idx(r, c - 1, sl - 1, dim)
      if (val === bw[i]) nabo[nr_set++] = il[i]
    }
    if (r < dim[0] - 1) {
      const i = idx(r + 1, c, sl - 1, dim)
      if (val === bw[i]) nabo[nr_set++] = il[i]
    }
    if (c < dim[1] - 1) {
      const i = idx(r, c + 1, sl - 1, dim)
      if (val === bw[i]) nabo[nr_set++] = il[i]
    }
  }
  if (conn === 26) {
    if (r && c) {
      const i = idx(r - 1, c - 1, sl - 1, dim)
      if (val === bw[i]) nabo[nr_set++] = il[i]
    }
    if (r < dim[0] - 1 && c) {
      const i = idx(r + 1, c - 1, sl - 1, dim)
      if (val === bw[i]) nabo[nr_set++] = il[i]
    }
    if (r && c < dim[1] - 1) {
      const i = idx(r - 1, c + 1, sl - 1, dim)
      if (val === bw[i]) nabo[nr_set++] = il[i]
    }
    if (r < dim[0] - 1 && c < dim[1] - 1) {
      const i = idx(r + 1, c + 1, sl - 1, dim)
      if (val === bw[i]) nabo[nr_set++] = il[i]
    }
  }
  if (nr_set) {
    fill_tratab(tt, nabo, nr_set)
    return nabo[0]
  }
  return 0
}

function do_initial_labelling(
  bw: Uint32Array,
  dim: Uint32Array,
  conn: number,
): [number, Uint32Array, Uint32Array] {
  let label = 1
  const kGrowArrayBy = 8192
  let ttn = kGrowArrayBy
  let tt = new Uint32Array(ttn).fill(0)
  const il = new Uint32Array(dim[0] * dim[1] * dim[2]).fill(0)
  const nabo = new Uint32Array(27)
  for (let sl = 0; sl < dim[2]; sl++) {
    for (let c = 0; c < dim[1]; c++) {
      for (let r = 0; r < dim[0]; r++) {
        let nr_set = 0
        const val = bw[idx(r, c, sl, dim)]
        if (val === 0) continue
        nabo[0] = check_previous_slice(bw, il, r, c, sl, dim, conn, tt)
        if (nabo[0]) nr_set += 1
        if (conn >= 6) {
          if (r) {
            const i = idx(r - 1, c, sl, dim)
            if (val === bw[i]) nabo[nr_set++] = il[i]
          }
          if (c) {
            const i = idx(r, c - 1, sl, dim)
            if (val === bw[i]) nabo[nr_set++] = il[i]
          }
        }
        if (conn >= 18) {
          if (c && r) {
            const i = idx(r - 1, c - 1, sl, dim)
            if (val === bw[i]) nabo[nr_set++] = il[i]
          }
          if (c && r < dim[0] - 1) {
            const i = idx(r + 1, c - 1, sl, dim)
            if (val === bw[i]) nabo[nr_set++] = il[i]
          }
        }
        if (nr_set) {
          il[idx(r, c, sl, dim)] = nabo[0]
          fill_tratab(tt, nabo, nr_set)
        } else {
          il[idx(r, c, sl, dim)] = label
          if (label >= ttn) {
            ttn += kGrowArrayBy
            const ext = new Uint32Array(ttn)
            ext.set(tt)
            tt = ext
          }
          tt[label - 1] = label
          label++
        }
      }
    }
  }
  for (let i = 0; i < label - 1; i++) {
    let j = i
    while (tt[j] !== j + 1) j = tt[j] - 1
    tt[i] = j + 1
  }
  return [label - 1, tt, il]
}

function translate_labels(
  il: Uint32Array,
  dim: Uint32Array,
  tt: Uint32Array,
  ttn: number,
): [number, Uint32Array] {
  const nvox = dim[0] * dim[1] * dim[2]
  let ml = 0
  const l = new Uint32Array(nvox).fill(0)
  for (let i = 0; i < ttn; i++) ml = Math.max(ml, tt[i])
  const fl = new Uint32Array(ml).fill(0)
  let cl = 0
  for (let i = 0; i < nvox; i++) {
    if (il[i]) {
      if (!fl[tt[il[i] - 1] - 1]) {
        cl += 1
        fl[tt[il[i] - 1] - 1] = cl
      }
      l[i] = fl[tt[il[i] - 1] - 1]
    }
  }
  return [cl, l]
}

function largest_original_cluster_labels(
  bw: Uint32Array,
  cl: number,
  ls: Uint32Array,
): [number, Uint32Array] {
  const nvox = bw.length
  const ls2bw = new Uint32Array(cl + 1).fill(0)
  const sumls = new Uint32Array(cl + 1).fill(0)
  for (let i = 0; i < nvox; i++) {
    ls2bw[ls[i]] = bw[i]
    sumls[ls[i]]++
  }
  let mxbw = 0
  for (let i = 0; i < cl + 1; i++) {
    const bwVal = ls2bw[i]
    mxbw = Math.max(mxbw, bwVal)
    for (let j = 0; j < cl + 1; j++) {
      if (j === i) continue
      if (bwVal !== ls2bw[j]) continue
      if (sumls[i] < sumls[j]) {
        ls2bw[i] = 0
      } else if (sumls[i] === sumls[j] && i < j) {
        ls2bw[i] = 0
      }
    }
  }
  const vxs = new Uint32Array(nvox).fill(0)
  for (let i = 0; i < nvox; i++) vxs[i] = ls2bw[ls[i]]
  return [mxbw, vxs]
}

export function computeConnectedLabel(
  input: ConnectedLabelInput,
): ConnectedLabelOutput {
  const {
    datatypeCode,
    dims,
    conn = 26,
    binarize = false,
    onlyLargestClusterPerClass = false,
  } = input

  const inImg = toTypedView(input.img, datatypeCode)
  const dim = Uint32Array.from([dims[1], dims[2], dims[3]])
  const nvox = dim[0] * dim[1] * dim[2]
  const bw = new Uint32Array(nvox).fill(0)

  if (binarize) {
    for (let i = 0; i < nvox; i++) {
      if (inImg[i] !== 0) bw[i] = 1
    }
  } else {
    for (let i = 0; i < nvox; i++) bw[i] = inImg[i] as number
  }

  const [ttn, tt, il] = do_initial_labelling(bw, dim, conn)
  const [cl, ls] = translate_labels(il, dim, tt ?? new Uint32Array(), ttn)

  let maxLabel: number
  let labeledImg: Uint32Array

  if (onlyLargestClusterPerClass) {
    ;[maxLabel, labeledImg] = largest_original_cluster_labels(bw, cl, ls)
  } else {
    maxLabel = cl
    labeledImg = ls
  }

  // Choose output type based on label count
  let outImg: ArrayBufferView
  let outDatatypeCode: number
  let bitsPerVoxel: number

  if (maxLabel > 65535) {
    outImg = Float32Array.from(labeledImg)
    outDatatypeCode = 16 // DT_FLOAT32
    bitsPerVoxel = 32
  } else if (maxLabel > 255) {
    outImg = Uint16Array.from(labeledImg)
    outDatatypeCode = 512 // DT_UINT16
    bitsPerVoxel = 16
  } else {
    outImg = Uint8Array.from(labeledImg)
    outDatatypeCode = 2 // DT_UINT8
    bitsPerVoxel = 8
  }

  return {
    img: outImg,
    datatypeCode: outDatatypeCode,
    bitsPerVoxel,
    calMax: maxLabel,
  }
}
