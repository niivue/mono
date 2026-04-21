import { decode } from "cbor-x"

// ITK-Wasm mesh format (.iwm.cbor)
// https://docs.itk.org/en/latest/learn/python_quick_start.html

interface IWMeshType {
  dimension: number
  pointComponentType: string
  pointPixelComponentType: string
  pointPixelType: string
  pointPixelComponents: number
  cellComponentType: string
  cellPixelComponentType: string
  cellPixelType: string
  cellPixelComponents: number
}

interface IWMesh {
  meshType: IWMeshType
  cells: BigUint64Array | BigInt64Array | Uint32Array | number[]
  points: Float32Array | number[]
  numberOfPoints?: bigint
  numberOfCells?: bigint
  cellBufferSize?: bigint
  numberOfPointPixels?: bigint
  numberOfCellPixels?: bigint
}

export const extensions = ["IWM.CBOR"]
export const type = "iwm"

export async function read(buffer: ArrayBufferLike): Promise<{
  positions: Float32Array
  indices: Uint32Array
}> {
  const iwm = decode(new Uint8Array(buffer)) as IWMesh
  return iwm2mesh(iwm)
}

function iwm2mesh(iwm: IWMesh): {
  positions: Float32Array
  indices: Uint32Array
} {
  if (!("meshType" in iwm) || !("cells" in iwm) || !("points" in iwm)) {
    throw new Error('.iwm.cbor must have "meshType", "cells" and "points".')
  }

  let cells: Uint32Array
  if (
    iwm.cells instanceof BigUint64Array ||
    iwm.cells instanceof BigInt64Array
  ) {
    cells = new Uint32Array(iwm.cells.length)
    for (let i = 0; i < iwm.cells.length; i++) {
      cells[i] = Number(BigInt(iwm.cells[i]) & BigInt(0xffffffff))
    }
  } else if (
    iwm.cells instanceof Uint32Array ||
    typeof iwm.cells[0] === "number"
  ) {
    cells = new Uint32Array(iwm.cells)
  } else {
    throw new Error("Unsupported data type in iwm.cells")
  }

  // 1st pass: count triangles
  let ntri = 0
  let i = 0
  while (i < cells.length) {
    // enum cell type 2=TRIANGLE_CELL 3=QUADRILATERAL_CELL 4=POLYGON_CELL
    const cellType = cells[i]
    const cellNum = cells[i + 1]
    if (cellType < 2 || cellNum < 3) {
      throw new Error(
        `unsupported iwm cell type ${cellType} or cellNum ${cellNum}`,
      )
    }
    i += cellNum + 2 // skip cellNum, cellType and elements
    ntri += cellNum - 2 // e.g. TRIANGLE has 1 tri, QUAD has 2
  }

  // each triangle has 3 faces
  const indices = new Uint32Array(ntri * 3)

  // 2nd pass: populate triangles
  i = 0
  let j = 0
  while (i < cells.length) {
    const cellNum = cells[i + 1]
    const newTri = cellNum - 2 // e.g. TRIANGLE has 1 tri, QUAD has two
    for (let t = 0; t < newTri; t++) {
      // for each triangle
      indices[j++] = cells[i + 2]
      indices[j++] = cells[i + 2 + 1 + t]
      indices[j++] = cells[i + 2 + 2 + t]
    }
    i += cellNum + 2 // skip cellNum, cellType and elements
  }

  const positions = new Float32Array(iwm.points)

  // NIFTI is RAS, IWM is LPS - flip X and Y
  i = 0
  while (i < positions.length) {
    positions[i] = -positions[i]
    positions[i + 1] = -positions[i + 1]
    i += 3
  }

  return { positions, indices }
}
