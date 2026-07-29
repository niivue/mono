// Export a single slice of a voxel drawing bitmap as a standalone SVG. Unlike a
// slide's vector layer, a volume drawing is a raster (label indices per voxel),
// so there is no polygon to serialize. We instead emit one `<rect>` per
// horizontal run of same-label voxels on the chosen slice — lossless, scalable,
// and compact for typical segmentations. The SVG is sized in voxels (viewBox =
// slice width x height) so it registers with the slice grid in any viewer.

export interface DrawingSliceToSVGParams {
  bitmap: Uint8Array
  /** NIfTI-style [ndim, dimX, dimY, dimZ] (RAS-resampled drawing dims). */
  dims: number[]
  /** Depth axis of the slice: 0 = sagittal (x), 1 = coronal (y), 2 = axial (z). */
  sliceAxis: number
  /** Fixed index along `sliceAxis`. */
  sliceIndex: number
  /**
   * CSS color for a non-zero label, or null/'' to skip it (treated as
   * transparent). Label 0 is always skipped.
   */
  colorForLabel: (label: number) => string | null
}

// In-plane axes (column, row) for each slice/depth axis, matching the drawing
// tools' convention (sliceTypeDim): axial fixes z -> plane (x,y); coronal fixes
// y -> plane (x,z); sagittal fixes x -> plane (y,z).
function planeAxes(sliceAxis: number): [number, number] {
  if (sliceAxis === 2) return [0, 1] // axial: x, y
  if (sliceAxis === 1) return [0, 2] // coronal: x, z
  return [1, 2] // sagittal: y, z
}

/**
 * Serialize one slice of a drawing bitmap to an SVG string. Returns an empty-body
 * SVG (still valid) when the slice has no painted voxels or the index is out of
 * range. Same-label horizontal runs are merged into a single rect.
 */
export function drawingSliceToSVG(params: DrawingSliceToSVGParams): string {
  const { bitmap, dims, sliceAxis, sliceIndex, colorForLabel } = params
  const dimX = dims[1]
  const dimY = dims[2]
  const dimZ = dims[3]
  const dimOf = [dimX, dimY, dimZ]
  const [aCol, aRow] = planeAxes(sliceAxis)
  const width = dimOf[aCol]
  const height = dimOf[aRow]
  const depthDim = dimOf[sliceAxis]

  const header = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`

  if (sliceIndex < 0 || sliceIndex >= depthDim || width < 1 || height < 1) {
    return `${header}\n</svg>\n`
  }

  const coord = [0, 0, 0]
  coord[sliceAxis] = sliceIndex
  const flat = (u: number, v: number): number => {
    coord[aCol] = u
    coord[aRow] = v
    return coord[0] + coord[1] * dimX + coord[2] * dimX * dimY
  }

  const rects: string[] = []
  for (let v = 0; v < height; v++) {
    let u = 0
    while (u < width) {
      const label = bitmap[flat(u, v)]
      if (label === 0) {
        u++
        continue
      }
      const color = colorForLabel(label)
      // Merge the horizontal run of this exact label (regardless of color, so a
      // null-colored label still advances the cursor and isn't re-scanned).
      let runEnd = u + 1
      while (runEnd < width && bitmap[flat(runEnd, v)] === label) runEnd++
      if (color) {
        rects.push(
          `  <rect x="${u}" y="${v}" width="${runEnd - u}" height="1" fill="${color}" />`,
        )
      }
      u = runEnd
    }
  }
  return `${header}\n${rects.join('\n')}\n</svg>\n`
}
