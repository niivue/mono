import ndarray from 'ndarray'
import { assign } from 'ndarray-ops'
import { describe, expect, it } from 'vitest'

import type * as zarr from '../../src/index.js'
import { setter } from '../../src/indexing/ops.js'
import type { Projection } from '../../src/indexing/types.js'
import { slice, sliceIndices } from '../../src/indexing/util.js'

/** Compute strides for 'C' or 'F' ordered array from shape */
function get_strides(shape: readonly number[], order: 'C' | 'F') {
  return (order === 'C' ? row_major_stride : col_major_stride)(shape)
}

function row_major_stride(shape: readonly number[]) {
  const ndim = shape.length
  const stride: number[] = globalThis.Array(ndim)
  for (let i = ndim - 1, step = 1; i >= 0; i--) {
    stride[i] = step
    step *= shape[i]
  }
  return stride
}

function col_major_stride(shape: readonly number[]) {
  const ndim = shape.length
  const stride: number[] = globalThis.Array(ndim)
  for (let i = 0, step = 1; i < ndim; i++) {
    stride[i] = step
    step *= shape[i]
  }
  return stride
}

function to_c<D extends zarr.DataType>({
  data,
  shape,
  stride,
}: zarr.Chunk<D>): zarr.Chunk<D> {
  const size = shape.reduce((a, b) => a * b, 1)
  // @ts-expect-error - We know constructor exists on TypedArray
  const out = ndarray(new data.constructor(size), shape)
  // @ts-expect-error - ndarray types are a mismatch with ours but this operation is safe
  assign(out, ndarray(data, shape, stride))
  return out
}

function indices(size: number) {
  return sliceIndices(slice(null), size)
}

describe('setter', () => {
  it('setter.setScalar - fill', async () => {
    const a = setter.prepare(
      new Float32Array(2 * 3 * 4),
      [2, 3, 4],
      get_strides([2, 3, 4], 'C'),
    )

    const sel = [2, 3, 4].map(indices)
    setter.setScalar(a, sel, 1)
    // biome-ignore format: the array should not be formatted
    expect(a.data).toStrictEqual(new Float32Array([
			1, 1, 1, 1,
			1, 1, 1, 1,
			1, 1, 1, 1,

			1, 1, 1, 1,
			1, 1, 1, 1,
			1, 1, 1, 1,
		]));
  })

  it('setter.setScalar - point', async () => {
    const a = setter.prepare(
      new Float32Array(2 * 3 * 4),
      [2, 3, 4],
      get_strides([2, 3, 4], 'C'),
    )

    setter.setScalar(a, [0, 0, 0], 1)
    // biome-ignore format: the array should not be formatted
    expect(a.data).toStrictEqual(new Float32Array([
			1, 0, 0, 0,
			0, 0, 0, 0,
			0, 0, 0, 0,

			0, 0, 0, 0,
			0, 0, 0, 0,
			0, 0, 0, 0,
		]));

    setter.setScalar(a, [1, 1, 1], 2)
    // biome-ignore format: the array should not be formatted
    expect(a.data).toStrictEqual(new Float32Array([
			1, 0, 0, 0,
			0, 0, 0, 0,
			0, 0, 0, 0,

			0, 0, 0, 0,
			0, 2, 0, 0,
			0, 0, 0, 0,
		]));

    setter.setScalar(a, [1, 2, 3], 3)
    // biome-ignore format: the array should not be formatted
    expect(a.data).toStrictEqual(new Float32Array([
			1, 0, 0, 0,
			0, 0, 0, 0,
			0, 0, 0, 0,

			0, 0, 0, 0,
			0, 2, 0, 0,
			0, 0, 0, 3,
		]));

    setter.setScalar(a, [1, 2, 2], 4)
    // biome-ignore format: the array should not be formatted
    expect(a.data).toStrictEqual(new Float32Array([
			1, 0, 0, 0,
			0, 0, 0, 0,
			0, 0, 0, 0,

			0, 0, 0, 0,
			0, 2, 0, 0,
			0, 0, 4, 3,
		]));
  })

  it('setter.setScalar - mixed', async () => {
    const a = setter.prepare(
      new Float32Array(2 * 3 * 4),
      [2, 3, 4],
      get_strides([2, 3, 4], 'C'),
    )

    let sel = [indices(2), sliceIndices(slice(2), 3), 0]
    setter.setScalar(a, sel, 1)
    // biome-ignore format: the array should not be formatted
    expect(a.data).toStrictEqual(new Float32Array([
			1, 0, 0, 0,
			1, 0, 0, 0,
			0, 0, 0, 0,

			1, 0, 0, 0,
			1, 0, 0, 0,
			0, 0, 0, 0,
		]));

    sel = [0, indices(3), indices(4)]
    setter.setScalar(a, sel, 2)

    // biome-ignore format: the array should not be formatted
    expect(a.data).toStrictEqual(new Float32Array([
			2, 2, 2, 2,
			2, 2, 2, 2,
			2, 2, 2, 2,

			1, 0, 0, 0,
			1, 0, 0, 0,
			0, 0, 0, 0,
		]));
  })

  it('setter.setScalar - mixed F order', async () => {
    const f = setter.prepare(
      new Float32Array(2 * 3 * 4),
      [2, 3, 4],
      get_strides([2, 3, 4], 'F'),
    )

    let sel = [sliceIndices(slice(null), 2), sliceIndices(slice(2), 3), 0]
    setter.setScalar(f, sel, 1)
    // biome-ignore format: the array should not be formatted
    expect(f.data).toStrictEqual(new Float32Array([
			1, 1, 1, 1, 0, 0,
			0, 0, 0, 0, 0, 0,
			0, 0, 0, 0, 0, 0,
			0, 0, 0, 0, 0, 0,
		]));

    sel = [0, sliceIndices(slice(null), 3), sliceIndices(slice(null), 4)]
    setter.setScalar(f, sel, 2)

    // biome-ignore format: the array should not be formatted
    expect(f.data).toStrictEqual(new Float32Array([
			2, 1, 2, 1, 2, 0,
			2, 0, 2, 0, 2, 0,
			2, 0, 2, 0, 2, 0,
			2, 0, 2, 0, 2, 0,
		]));

    // biome-ignore format: the array should not be formatted
    expect(to_c(f).data).toStrictEqual(new Float32Array([
			2, 2, 2, 2,
			2, 2, 2, 2,
			2, 2, 2, 2,

			1, 0, 0, 0,
			1, 0, 0, 0,
			0, 0, 0, 0,
		]));
  })

  it('set_from_chunk - complete', async () => {
    const dest = setter.prepare(
      new Float32Array(2 * 3 * 4),
      [2, 3, 4],
      get_strides([2, 3, 4], 'C'),
    )

    const src = setter.prepare(
      new Float32Array(2 * 2 * 2).fill(1),
      [2, 2, 2],
      get_strides([2, 2, 2], 'C'),
    )

    const mapping: Projection[] = [
      { from: [0, 2, 1], to: [0, 2, 1] },
      { from: [0, 2, 1], to: [0, 2, 1] },
      { from: [0, 2, 1], to: [0, 2, 1] },
    ]

    setter.setFromChunk(dest, src, mapping)
    // biome-ignore format: the array should not be formatted
    expect(dest.data).toStrictEqual(new Float32Array([
			1, 1, 0, 0,
			1, 1, 0, 0,
			0, 0, 0, 0,

			1, 1, 0, 0,
			1, 1, 0, 0,
			0, 0, 0, 0,
		]));
  })

  it('set_from_chunk - from complete to strided', async () => {
    const dest = setter.prepare(
      new Float32Array(2 * 3 * 4),
      [2, 3, 4],
      get_strides([2, 3, 4], 'C'),
    )

    const src = setter.prepare(
      new Float32Array(2 * 2 * 2).fill(2),
      [2, 2, 2],
      get_strides([2, 2, 2], 'C'),
    )

    const mapping: Projection[] = [
      { from: [0, 2, 1], to: [0, 2, 1] },
      { from: [0, 2, 1], to: [0, 3, 2] },
      { from: [0, 2, 1], to: [0, 4, 2] },
    ]

    setter.setFromChunk(dest, src, mapping)
    // biome-ignore format: the array should not be formatted
    expect(dest.data).toStrictEqual(new Float32Array([
			2, 0, 2, 0,
			0, 0, 0, 0,
			2, 0, 2, 0,

			2, 0, 2, 0,
			0, 0, 0, 0,
			2, 0, 2, 0,
		]));
  })

  it('set_from_chunk - from strided to complete', async () => {
    const dest = setter.prepare(
      new Float32Array(2 * 2 * 2),
      [2, 2, 2],
      get_strides([2, 2, 2], 'C'),
    )

    const src = setter.prepare(
      // biome-ignore format: the array should not be formatted
      new Float32Array([
				2, 0, 2, 0,
				0, 0, 0, 0,
				2, 0, 2, 0,

				2, 0, 2, 0,
				0, 0, 0, 0,
				2, 0, 2, 0,
			]),
      [2, 3, 4],
      get_strides([2, 3, 4], 'C'),
    )

    const mapping: Projection[] = [
      { to: [0, 2, 1], from: [0, 2, 1] },
      { to: [0, 2, 1], from: [0, 3, 2] },
      { to: [0, 2, 1], from: [0, 4, 2] },
    ]

    setter.setFromChunk(dest, src, mapping)
    expect(dest.data).toStrictEqual(new Float32Array(2 * 2 * 2).fill(2))
  })

  it('set_from_chunk - src squeezed', async () => {
    const dest = setter.prepare(
      new Float32Array(2 * 3 * 4),
      [2, 3, 4],
      get_strides([2, 3, 4], 'C'),
    )

    const src = setter.prepare(
      new Float32Array([2, 0, 0, 2]),
      [4],
      get_strides([4], 'C'),
    )

    const mapping: Projection[] = [
      { to: 0, from: null },
      { to: [0, 3, 2], from: [0, 4, 3] },
      { to: 1, from: null },
    ]

    setter.setFromChunk(dest, src, mapping)
    // biome-ignore format: the array should not be formatted
    expect(dest.data).toStrictEqual(new Float32Array([
			0, 2, 0, 0,
			0, 0, 0, 0,
			0, 2, 0, 0,

			0, 0, 0, 0,
			0, 0, 0, 0,
			0, 0, 0, 0,
		]));
  })

  it('set_from_chunk - dest squeezed', async () => {
    const dest = setter.prepare(new Float32Array(4), [4], get_strides([4], 'C'))

    const src = setter.prepare(
      // biome-ignore format: the array should not be formatted
      new Float32Array([
				0, 2, 0, 0,
				0, 0, 0, 0,
				0, 2, 0, 0,

				0, 0, 0, 0,
				0, 0, 0, 0,
				0, 0, 0, 0,
			]),
      [2, 3, 4],
      get_strides([2, 3, 4], 'C'),
    )

    const mapping: Projection[] = [
      { from: 0, to: null },
      { from: [0, 3, 2], to: [0, 4, 3] },
      { from: 1, to: null },
    ]

    setter.setFromChunk(dest, src, mapping)
    expect(dest.data).toStrictEqual(new Float32Array([2, 0, 0, 2]))
  })

  it('set_from_chunk - complete F order', async () => {
    const dest = setter.prepare(
      new Float32Array(2 * 3 * 4),
      [2, 3, 4],
      get_strides([2, 3, 4], 'F'),
    )

    const src = setter.prepare(
      new Float32Array(2 * 2 * 2).fill(1),
      [2, 2, 2],
      get_strides([2, 2, 2], 'F'),
    )

    const mapping: Projection[] = [
      { from: [0, 2, 1], to: [0, 2, 1] },
      { from: [0, 2, 1], to: [0, 2, 1] },
      { from: [0, 2, 1], to: [0, 2, 1] },
    ]

    setter.setFromChunk(dest, src, mapping)
    // biome-ignore format: the array should not be formatted
    expect(to_c(dest).data).toStrictEqual(new Float32Array([
			1, 1, 0, 0,
			1, 1, 0, 0,
			0, 0, 0, 0,

			1, 1, 0, 0,
			1, 1, 0, 0,
			0, 0, 0, 0,
		]));
  })

  it('set_from_chunk - F order', async () => {
    const dest = setter.prepare(
      new Float32Array(2 * 3 * 4),
      [2, 3, 4],
      get_strides([2, 3, 4], 'F'),
    )

    const src = setter.prepare(
      new Float32Array([2, 0, 0, 2]),
      [4],
      get_strides([4], 'F'),
    )

    const mapping: Projection[] = [
      { to: 0, from: null },
      { to: [0, 3, 2], from: [0, 4, 3] },
      { to: 1, from: null },
    ]

    setter.setFromChunk(dest, src, mapping)
    // biome-ignore format: the array should not be formatted
    expect(to_c(dest).data).toStrictEqual(new Float32Array([
			0, 2, 0, 0,
			0, 0, 0, 0,
			0, 2, 0, 0,

			0, 0, 0, 0,
			0, 0, 0, 0,
			0, 0, 0, 0,
		]));
  })

  it('set_from_chunk - dest=F order, src=C order', async () => {
    const dest = setter.prepare(
      new Float32Array(2 * 3 * 4),
      [2, 3, 4],
      get_strides([2, 3, 4], 'F'),
    )

    const src = setter.prepare(
      new Float32Array([2, 0, 0, 2]),
      [4],
      get_strides([4], 'C'),
    )

    const mapping: Projection[] = [
      { to: 0, from: null },
      { to: [0, 3, 2], from: [0, 4, 3] },
      { to: 1, from: null },
    ]

    setter.setFromChunk(dest, src, mapping)
    // biome-ignore format: the array should not be formatted
    expect(to_c(dest).data).toStrictEqual(new Float32Array([
			0, 2, 0, 0,
			0, 0, 0, 0,
			0, 2, 0, 0,

			0, 0, 0, 0,
			0, 0, 0, 0,
			0, 0, 0, 0,
		]));
  })

  it('set_from_chunk - dest=C order, src=F order', async () => {
    const dest = setter.prepare(
      new Float32Array(2 * 3 * 4),
      [2, 3, 4],
      get_strides([2, 3, 4], 'C'),
    )

    const src = setter.prepare(
      new Float32Array([2, 0, 0, 2]),
      [4],
      get_strides([4], 'F'),
    )

    const mapping: Projection[] = [
      { to: 0, from: null },
      { to: [0, 3, 2], from: [0, 4, 3] },
      { to: 1, from: null },
    ]

    setter.setFromChunk(dest, src, mapping)
    // biome-ignore format: the array should not be formatted
    expect(dest.data).toStrictEqual(new Float32Array([
			0, 2, 0, 0,
			0, 0, 0, 0,
			0, 2, 0, 0,

			0, 0, 0, 0,
			0, 0, 0, 0,
			0, 0, 0, 0,
		]));
  })
})
