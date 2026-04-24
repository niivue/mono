/**
 * Allow-list of NiiVue controller properties exposed to the native host.
 *
 * Every entry declares:
 *   - `kind`: how the JSON value is coerced before assigning to the controller
 *   - `emitOnChange`: whether inbound changes from NiiVue's `change` event
 *     should be forwarded to Swift (set to false for transient/internal props)
 *
 * Adding a property = one line here + one line in the Swift view-model.
 */

export type PropKind =
  | 'boolean'
  | 'number'
  | 'string'
  | 'enum' // integer-backed enum, sent as number
  | 'rgba' // [r,g,b,a] 0..1

export type PropSpec = {
  kind: PropKind
  emitOnChange?: boolean
}

export const PROP_ALLOWLIST: Record<string, PropSpec> = {
  // Layout
  sliceType: { kind: 'enum', emitOnChange: true },
  multiplanarType: { kind: 'enum', emitOnChange: true },
  showRender: { kind: 'enum', emitOnChange: true },
  mosaicString: { kind: 'string', emitOnChange: true },
  heroFraction: { kind: 'number', emitOnChange: true },
  isRadiological: { kind: 'boolean', emitOnChange: true },

  // UI chrome
  isColorbarVisible: { kind: 'boolean', emitOnChange: true },
  isOrientCubeVisible: { kind: 'boolean', emitOnChange: true },
  isOrientationTextVisible: { kind: 'boolean', emitOnChange: true },
  is3DCrosshairVisible: { kind: 'boolean', emitOnChange: true },
  isCrossLinesVisible: { kind: 'boolean', emitOnChange: true },
  isRulerVisible: { kind: 'boolean', emitOnChange: true },
  isLegendVisible: { kind: 'boolean', emitOnChange: true },

  // Scene
  backgroundColor: { kind: 'rgba', emitOnChange: true },
  gamma: { kind: 'number', emitOnChange: true },
  azimuth: { kind: 'number', emitOnChange: true },
  elevation: { kind: 'number', emitOnChange: true },
}

export function coerce(kind: PropKind, value: unknown): unknown {
  switch (kind) {
    case 'boolean':
      return Boolean(value)
    case 'number':
    case 'enum':
      return Number(value)
    case 'string':
      return String(value ?? '')
    case 'rgba': {
      if (!Array.isArray(value) || value.length < 3) {
        throw new Error('rgba requires [r,g,b] or [r,g,b,a]')
      }
      const [r, g, b, a = 1] = value as number[]
      return [Number(r), Number(g), Number(b), Number(a)]
    }
  }
}
