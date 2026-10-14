/**
 * Schema pieces the tool modules share, and the one-line way most tools
 * are registered: the schema's `tab` goes to the bridge and the rest of
 * the arguments go to the page's handler of the same name.
 */

import { z } from 'zod'

/** Which volume a tool means: its index as where_am_i lists them, or its name. */
export const VOLUME_ARG = z
  .union([z.number().int().min(0), z.string().min(1)])
  .describe(
    'Which volume: its index as where_am_i lists them (0 is the base), or its name.',
  )

/** A point, three numbers. */
export function triple(description: string) {
  return z.array(z.number()).length(3).describe(description)
}
