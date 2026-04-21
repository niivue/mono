/**
 * Volume Transform Registry
 *
 * Auto-discovers transform modules from this directory using import.meta.glob.
 * Each transform module should export:
 *   - name: string (unique identifier)
 *   - description: string (human-readable description)
 *   - apply: async function(hdr, img, options?) => { hdr, img }
 *   - options?: OptionField[] (self-describing option definitions for UI)
 *   - resultDefaults?: { colormap?, opacity? } (suggested display defaults for output)
 */

import type { NIFTI1, NIFTI2, TypedVoxelArray } from "@/NVTypes"
import { NVWorker } from "@/workers/NVWorker"
import TransformWorker from "@/workers/transform.worker?worker&inline"

/**
 * Base options that can be passed to transform functions.
 * Each transform may define its own specific options interface extending this.
 */
export type TransformOptions = {
  [key: string]: unknown
}

/**
 * Describes a single configurable option for a transform plugin.
 */
export interface OptionField {
  /** Option key (matches the property name in the transform's options interface) */
  name: string
  /** Display label for UI */
  label: string
  /** Input type */
  type: "checkbox" | "select"
  /** Default value */
  default: boolean | number | string
  /** Available choices (for 'select' type) */
  options?: (number | string)[]
}

/**
 * Suggested display defaults for the output volume.
 */
export interface ResultDefaults {
  colormap?: string
  opacity?: number
}

/**
 * Interface for a volume transform module.
 */
export interface VolumeTransform {
  /** Unique name for this transform */
  name: string
  /** Human-readable description */
  description: string
  /** Self-describing option definitions for UI generation */
  options?: OptionField[]
  /** Suggested display defaults for the output volume */
  resultDefaults?: ResultDefaults
  /** Apply the transform to raw NIFTI data */
  apply: (
    hdr: NIFTI1 | NIFTI2,
    img: TypedVoxelArray | ArrayBuffer,
    options?: TransformOptions,
  ) => Promise<{ hdr: NIFTI1 | NIFTI2; img: TypedVoxelArray }>
}

/**
 * Transform metadata exposed to consumers (controller, UI).
 */
export interface TransformInfo {
  name: string
  description: string
  options: OptionField[]
  resultDefaults?: ResultDefaults
}

// Auto-discover transform modules (excludes index.ts)
const modules = import.meta.glob<VolumeTransform>("./*.ts", { eager: true })

// Build registry
const transformsByName = new Map<string, VolumeTransform>()
// Track which transforms are built-in (discoverable by the worker via import.meta.glob)
const builtinNames = new Set<string>()

for (const [path, mod] of Object.entries(modules)) {
  // Skip index.ts
  if (path === "./index.ts") continue

  if (mod.name && typeof mod.apply === "function") {
    transformsByName.set(mod.name, mod)
    builtinNames.add(mod.name)
  }
}

/**
 * Get list of available transform names.
 */
export function transformNames(): string[] {
  return Array.from(transformsByName.keys()).sort()
}

/**
 * Get a transform by name.
 */
export function getTransform(name: string): VolumeTransform | undefined {
  return transformsByName.get(name)
}

/**
 * Get metadata for a specific transform (name, description, options, resultDefaults).
 */
export function getTransformInfo(name: string): TransformInfo | undefined {
  const t = transformsByName.get(name)
  if (!t) return undefined
  return {
    name: t.name,
    description: t.description,
    options: t.options ?? [],
    resultDefaults: t.resultDefaults,
  }
}

/**
 * Get metadata for all registered transforms.
 */
export function getTransformInfos(): TransformInfo[] {
  return transformNames().map((n) => getTransformInfo(n)!)
}

// ---------------------------------------------------------------------------
// Worker bridge (lazy, with direct-call fallback)
// ---------------------------------------------------------------------------

let bridge: NVWorker | null = null

function getBridge(): NVWorker | null {
  if (!NVWorker.isSupported()) return null
  if (!bridge) {
    bridge = new NVWorker(() => new TransformWorker())
  }
  return bridge
}

/**
 * Apply a named transform to volume data.
 * Executes in a Web Worker when available, falling back to direct execution.
 */
export async function applyTransform(
  name: string,
  hdr: NIFTI1 | NIFTI2,
  img: TypedVoxelArray | ArrayBuffer,
  options?: TransformOptions,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: TypedVoxelArray }> {
  const transform = transformsByName.get(name)
  if (!transform) {
    throw new Error(`Unknown volume transform: ${name}`)
  }
  // External (registered at runtime) transforms manage their own workers,
  // so call apply() directly. Built-in transforms use the shared worker.
  if (!builtinNames.has(name)) {
    return transform.apply(hdr, img, options)
  }
  const b = getBridge()
  if (b) {
    // NIFTI class instances have non-cloneable function properties;
    // JSON round-trip produces a plain data-only object safe for postMessage.
    const plainHdr = JSON.parse(JSON.stringify(hdr))
    return b.execute<{ hdr: NIFTI1 | NIFTI2; img: TypedVoxelArray }>({
      name,
      hdr: plainHdr,
      img,
      options,
    })
  }
  // Fallback: direct execution (no Worker support)
  return transform.apply(hdr, img, options)
}

/**
 * Register an external volume transform at runtime.
 * This allows external packages to add transforms without being bundled into core.
 */
export function registerTransform(transform: VolumeTransform): void {
  if (transformsByName.has(transform.name)) {
    throw new Error(`Transform "${transform.name}" already registered`)
  }
  transformsByName.set(transform.name, transform)
}

/**
 * Terminate the transform worker. Safe to call if no worker was created.
 */
export function terminate(): void {
  if (bridge) {
    bridge.terminate()
    bridge = null
  }
}
