import { expect, test } from 'vitest'
import * as zarrita from '../src/index.js'

// zarrita-wasm adds these on top of the zarrita.js API.
const ADDITIONS = ['configureWasm', 'terminateWasmWorkers']

test('public API surface', () => {
  for (const name of ADDITIONS) expect(name in zarrita).toBe(true)
  expect(
    Object.keys(zarrita)
      .filter((k) => !ADDITIONS.includes(k))
      .sort(),
  ).toMatchInlineSnapshot(`
		[
		  "Array",
		  "BoolArray",
		  "ByteStringArray",
		  "CodecPipelineError",
		  "FetchStore",
		  "Group",
		  "InvalidMetadataError",
		  "InvalidSelectionError",
		  "Location",
		  "NotFoundError",
		  "UnicodeStringArray",
		  "UnknownCodecError",
		  "UnsupportedError",
		  "_zarrita_internal_get",
		  "_zarrita_internal_getStrides",
		  "_zarrita_internal_set",
		  "_zarrita_internal_sliceIndices",
		  "create",
		  "defineArrayExtension",
		  "defineStoreExtension",
		  "extendArray",
		  "extendStore",
		  "get",
		  "isZarritaError",
		  "open",
		  "registry",
		  "root",
		  "select",
		  "set",
		  "slice",
		  "withByteCaching",
		  "withConsolidatedMetadata",
		  "withMaybeConsolidatedMetadata",
		  "withRangeCoalescing",
		]
	`)
})
