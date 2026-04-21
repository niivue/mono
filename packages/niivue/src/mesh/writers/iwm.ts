import { encode } from 'cbor-x'

export const extensions = ['IWM.CBOR']

export async function write(
  positions: Float32Array,
  indices: Uint32Array,
): Promise<ArrayBuffer> {
  const nvert = positions.length / 3
  const ntri = indices.length / 3

  // Convert RAS (NIfTI) to LPS (ITK) — flip X and Y
  const lpsPositions = new Float32Array(positions)
  for (let i = 0; i < lpsPositions.length; i += 3) {
    lpsPositions[i] = -lpsPositions[i]
    lpsPositions[i + 1] = -lpsPositions[i + 1]
  }

  // Build cells buffer: [cellType, numVerts, i0, i1, i2] per triangle
  // cellType 2 = TRIANGLE_CELL
  const cellBufferSize = ntri * 5
  const cells = new BigUint64Array(cellBufferSize)
  let j = 0
  let k = 0
  for (let t = 0; t < ntri; t++) {
    cells[j++] = 2n // TriangleCell
    cells[j++] = 3n // Triangle has 3 indices
    cells[j++] = BigInt(indices[k++])
    cells[j++] = BigInt(indices[k++])
    cells[j++] = BigInt(indices[k++])
  }

  const iwm = {
    meshType: {
      dimension: 3,
      pointComponentType: 'float32',
      pointPixelComponentType: 'int8',
      pointPixelType: 'Scalar',
      pointPixelComponents: 0,
      cellComponentType: 'uint64',
      cellPixelComponentType: 'int8',
      cellPixelType: 'Scalar',
      cellPixelComponents: 0,
    },
    numberOfPoints: BigInt(nvert),
    numberOfPointPixels: 0n,
    numberOfCells: BigInt(ntri),
    numberOfCellPixels: 0n,
    cellBufferSize: BigInt(cellBufferSize),
    points: lpsPositions,
    cells,
  }

  const encoded = encode(iwm)
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  )
}
