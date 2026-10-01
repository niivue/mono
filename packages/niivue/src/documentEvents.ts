// The `change` events a document load implies. `loadDocument` writes settings
// straight into the model (NVDocument.applyDocumentToModel), bypassing the
// property setters that emit `change { property, value }`, so an event-driven
// binding was left stale after every load. This module derives the events those
// setters would have emitted by diffing the settings groups before and after
// the load, naming each key the way its setter does. Pure and dependency-light
// so it is unit-testable under the Bun harness (unlike NVDocument itself).

import { settingEquals } from './documentSettings'

/** The model's settings groups, in the order a load applies them. */
export const SETTINGS_GROUPS = [
  'scene',
  'layout',
  'ui',
  'volume',
  'mesh',
  'draw',
  'interaction',
  'annotation',
] as const

export type SettingsGroupName = (typeof SETTINGS_GROUPS)[number]
export type SettingsSnapshot = Record<
  SettingsGroupName,
  Record<string, unknown>
>

export interface SettingsChange {
  property: string
  value: unknown
}

// Groups whose setters use the bare key (`isRadiological`, `azimuth`); the
// others prefix it with the group name (`volumeMatcap`, `drawPenValue`).
const UNPREFIXED_GROUPS: ReadonlySet<string> = new Set([
  'scene',
  'layout',
  'ui',
  'interaction',
])

// Keys whose setter does not follow the rule.
const RENAMED: Readonly<Record<string, string>> = {
  'layout.margin': 'tileMargin',
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * The `change` property name the setter for `group.key` emits: unprefixed for
 * scene/layout/ui/interaction, `group + Key` for volume/mesh/draw/annotation.
 * A nested key (`ui.graph.lineWidth`) is named by its parent key
 * (`graphLineWidth`), matching the `graph*` setters.
 */
export function changePropertyName(group: string, key: string): string {
  const renamed = RENAMED[`${group}.${key}`]
  if (renamed) return renamed
  return UNPREFIXED_GROUPS.has(group) ? key : `${group}${capitalise(key)}`
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !ArrayBuffer.isView(v)
  )
}

// Deep copy a setting so the snapshot survives in-place mutation of the model.
// Typed arrays (gl-matrix vectors on `scene`) become plain arrays; settingEquals
// treats both as sequences, so the comparison is unaffected.
function copySetting(v: unknown): unknown {
  if (ArrayBuffer.isView(v)) {
    return Array.from(v as unknown as ArrayLike<number>)
  }
  if (Array.isArray(v)) return v.map(copySetting)
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v)) out[k] = copySetting(v[k])
    return out
  }
  return v
}

/** Copy every settings group of a model-like object. */
export function snapshotSettings(
  model: Record<SettingsGroupName, Record<string, unknown>>,
): SettingsSnapshot {
  const out = {} as SettingsSnapshot
  for (const g of SETTINGS_GROUPS) {
    out[g] = copySetting(model[g] ?? {}) as Record<string, unknown>
  }
  return out
}

function diffKeys(
  property: (key: string) => string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  out: SettingsChange[],
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    const b = before[key]
    const a = after[key]
    if (isPlainObject(b) && isPlainObject(a)) {
      // Nested settings object (ui.graph): its keys have their own setters.
      const parent = property(key)
      diffKeys((sub) => `${parent}${capitalise(sub)}`, b, a, out)
      continue
    }
    if (!settingEquals(b, a)) out.push({ property: property(key), value: a })
  }
}

/**
 * The `change` events whose setters would have produced the difference between
 * two snapshots, one per changed key, in group order. The value is the live
 * (after) value.
 */
export function settingsChangeEvents(
  before: SettingsSnapshot,
  after: SettingsSnapshot,
): SettingsChange[] {
  const out: SettingsChange[] = []
  for (const g of SETTINGS_GROUPS) {
    diffKeys((key) => changePropertyName(g, key), before[g], after[g], out)
  }
  return out
}
