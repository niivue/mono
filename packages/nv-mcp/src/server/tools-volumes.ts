/**
 * The tools on volumes beyond loading and drawing them: stepping the
 * crosshair a voxel at a time, deriving a volume from another, removing
 * and reordering, and the statistics and geometry of one.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { named, registerSimple, VOLUME_ARG } from './args'
import { TAB_ARG, type ToolContext } from './context'

export const VOLUME_SCHEMAS = {
  nudge_crosshair: {
    ...TAB_ARG,
    vox: z
      .array(z.number().int())
      .length(3)
      .describe(
        "How many voxels to step along the base volume's i, j and k axes, negative to go back.",
      ),
  },
  transform_volume: {
    ...TAB_ARG,
    volume: VOLUME_ARG.optional().describe(
      'The volume to derive from: its index as where_am_i lists them, or its name. The base otherwise.',
    ),
    name: z
      .string()
      .min(1)
      .describe('The transform, as capabilities lists volumeTransforms.'),
    options: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "The transform's options, as capabilities describes them for it.",
      ),
    replace: z
      .boolean()
      .optional()
      .describe(
        'Whether the source volume is removed once the result is added. Kept otherwise.',
      ),
  },
  update_volume_data: {
    ...TAB_ARG,
    volume: VOLUME_ARG.optional().describe(
      'The volume to write into: its index as where_am_i lists them, or its name. The base otherwise.',
    ),
    values: z
      .array(z.number())
      .optional()
      .describe(
        "The new voxel values, raw: in the volume's own datatype and voxel order, before scl_slope " +
          'and scl_inter, a value per channel for RGB or RGBA. Either every frame or the frame shown. ' +
          'A call is capped at 4 MB, so send a large volume with `url` instead.',
      ),
    url: z
      .string()
      .min(1)
      .optional()
      .describe(
        'An address the page can fetch the same raw values from, as little-endian bytes in the ' +
          "volume's datatype, gzipped or not.",
      ),
    from_volume: VOLUME_ARG.optional().describe(
      'Copy the raw values of this other volume, which must have the same voxel count.',
    ),
    auto_window: z
      .boolean()
      .optional()
      .describe(
        "Recompute cal_min and cal_max from the new values. The volume's window is kept otherwise.",
      ),
  },
  remove_volume: {
    ...TAB_ARG,
    volume: VOLUME_ARG.optional(),
    all: z.boolean().optional().describe('Remove every volume instead of one.'),
  },
  reorder_volume: {
    ...TAB_ARG,
    volume: VOLUME_ARG,
    move: z
      .enum(['up', 'down', 'top', 'bottom'])
      .describe(
        'Where to move it in the stack: up or down one place, or to the top or bottom. The bottom is the base.',
      ),
  },
  describe_volume: {
    ...TAB_ARG,
    volume: VOLUME_ARG.optional(),
    stats: z
      .boolean()
      .optional()
      .describe(
        'Whether to compute the voxel statistics: count, mean, deviation, extremes, and the same over ' +
          'the non-zero voxels, with the volume in cubic millimetres and millilitres. On otherwise.',
      ),
    mask: VOLUME_ARG.optional().describe(
      'Restrict the statistics to the voxels where this other volume is non-zero, or, with `mask_labels`, ' +
        'to the voxels where it holds one of those labels (one region of an atlas or segmentation).',
    ),
    mask_labels: z
      .array(z.number())
      .optional()
      .describe(
        'The labels to count within: with `mask`, values of the mask volume (0 included); with `drawing`, ' +
          'pen values of the drawing.',
      ),
    drawing: z
      .boolean()
      .optional()
      .describe('Restrict the statistics to the voxels the drawing covers.'),
    affine: z
      .boolean()
      .optional()
      .describe(
        "Report the volume's affine, its 4 by 4 voxel-to-world matrix, too.",
      ),
  },
} as const

export function registerVolumeTools(
  server: McpServer,
  context: ToolContext,
): void {
  registerSimple(server, context, 'nudge_crosshair', {
    title: 'Step the crosshair by voxels',
    description:
      "Moves the crosshair a whole number of voxels along each of the base volume's axes, from " +
      'where it is now, and reports where it lands as where_am_i does.',
    inputSchema: VOLUME_SCHEMAS.nudge_crosshair,
    lead: (r) => {
      const said = (r as { description?: string })?.description
      return said ? `Moved to ${said}` : undefined
    },
  })

  registerSimple(server, context, 'transform_volume', {
    title: 'Derive a volume',
    description:
      'Runs one of the registered volume transforms (capabilities lists them, with their ' +
      'options) on a loaded volume and adds the result as a new volume on top of the stack, ' +
      'removing the source when `replace` is set. Reports the new volume as where_am_i lists them.',
    inputSchema: VOLUME_SCHEMAS.transform_volume,
    lead: named('volume', 'Added'),
  })

  registerSimple(server, context, 'update_volume_data', {
    title: 'Write new voxel values',
    description:
      "Replaces a loaded volume's voxel values in place, keeping its header, colormap and window, " +
      'from exactly one of `values`, `url` or `from_volume`. Takes every frame or only the frame ' +
      'shown. A volume drawn in bricks (set_volume chunk_grid) is refused. Reports the volume afterwards, ' +
      'or says it was removed while the values were written.',
    inputSchema: VOLUME_SCHEMAS.update_volume_data,
    lead: named('volume', 'Wrote new values into'),
  })

  registerSimple(server, context, 'remove_volume', {
    title: 'Remove a volume',
    description:
      'Unloads one volume, by index or name, or every volume with `all`. Reports the volumes that remain.',
    inputSchema: VOLUME_SCHEMAS.remove_volume,
  })

  registerSimple(server, context, 'reorder_volume', {
    title: 'Reorder the volumes',
    description:
      'Moves a volume up or down the stack, or to its top or bottom. The bottom volume is the base ' +
      'that sets the space; the others are drawn over it in order. Reports the new order.',
    inputSchema: VOLUME_SCHEMAS.reorder_volume,
  })

  registerSimple(server, context, 'describe_volume', {
    title: 'Describe a volume',
    description:
      'Reports one volume in full: how it is drawn, its dimensions, its label table when it has ' +
      'one, its voxel statistics (over the whole volume, or within a mask volume, its labels, or ' +
      'the drawing), and its affine when asked.',
    inputSchema: VOLUME_SCHEMAS.describe_volume,
    readOnly: true,
    lead: named('volume', 'Described'),
  })
}
