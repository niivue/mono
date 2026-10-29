/**
 * Static registry of the built-in volume transform modules in this directory,
 * keyed by path relative to it. Both the main-thread registry (`index.ts`) and
 * the transform worker read this, so a transform registered here runs in the
 * worker. A new transform must be added here; `src/registry.test.ts` fails when a
 * file in this directory is missing from the registry.
 *
 * A transform must not import runtime values from `./index`: that would pull
 * `index.ts` (and its inline worker) into the worker bundle and create an
 * import cycle. The type-only import below is erased.
 */
import type { VolumeTransform } from './index'

export const transformModules: Record<string, VolumeTransform> = {}
