import { expect, test } from 'bun:test'
import type {
  OverlayBackendHandle,
  OverlayFrame,
  OverlayRenderer,
} from '@niivue/niivue'
import type {
  UIKitBackendHandle,
  UIKitOverlayFrame,
  UIKitOverlayRenderer,
} from './hook'

// uikit keeps its own copy of core's overlay hook types (so it needs no
// niivue): if either side drifts, these assignments stop typechecking.
test('uikit hook types match core both ways', () => {
  const both = [
    (h: UIKitBackendHandle): OverlayBackendHandle => h,
    (h: OverlayBackendHandle): UIKitBackendHandle => h,
    (f: UIKitOverlayFrame): OverlayFrame => f,
    (f: OverlayFrame): UIKitOverlayFrame => f,
    (r: UIKitOverlayRenderer): OverlayRenderer => r,
    (r: OverlayRenderer): UIKitOverlayRenderer => r,
  ]
  expect(both).toHaveLength(6)
})
