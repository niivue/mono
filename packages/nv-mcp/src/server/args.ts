/**
 * Schema pieces the tool modules share, and the one-line way most tools
 * are registered: the schema's `tab` goes to the bridge and the rest of
 * the arguments go to the page's handler of the same name.
 */

import { z } from 'zod'

/** A point, three numbers. */
export function triple(description: string) {
  return z.array(z.number()).length(3).describe(description)
}
