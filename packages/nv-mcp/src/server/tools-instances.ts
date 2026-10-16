/**
 * The instances tool: lays out a global 3D scene, several volumes placed,
 * scaled and turned in one world and seen by the global camera, or tiles
 * the canvas, through NiiVue's setInstances.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { registerSimple, triple, VOLUME_ARG } from './args'
import { TAB_ARG, type ToolContext } from './context'

/** The most instances one call lays out; the page holds to the same. */
const MAX_INSTANCES = 100

/** The global camera, as set_camera's `global` and set_instances' `camera` take it. */
export const GLOBAL_CAMERA_ARG = z.object({
  position: triple(
    'Where the camera is, in scene units: the units instance positions are in.',
  ),
  yaw: z
    .number()
    .optional()
    .describe(
      'Degrees the camera turns left (negative) or right (positive) from looking down -z. 0 otherwise.',
    ),
  pitch: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe('Degrees the camera looks up (positive) or down. 0 otherwise.'),
  fov: z
    .number()
    .gt(0)
    .lt(180)
    .optional()
    .describe('The vertical field of view, degrees. 55 otherwise.'),
  near: z
    .number()
    .positive()
    .optional()
    .describe('The nearest distance drawn. 0.1 otherwise.'),
  far: z
    .number()
    .positive()
    .optional()
    .describe('The farthest distance drawn. 900 otherwise.'),
})

const INSTANCE_ARG = z.strictObject({
  id: z
    .string()
    .min(1)
    .optional()
    .describe('A name for it, unique in the list. "instance <n>" otherwise.'),
  volume: VOLUME_ARG.optional().describe(
    'Which loaded volume it draws: an index as where_am_i lists them, or a name. The base otherwise. ' +
      'Copies of one file each need their own name (add_overlay takes one).',
  ),
  space: z
    .enum(['global3d', 'canvas'])
    .optional()
    .describe(
      'global3d: rendered in one shared 3D scene the global camera looks at. canvas: a tile of the ' +
        'canvas, drawn as the usual render. global3d otherwise, unless only bounds are given.',
    ),
  position: triple(
    'global3d: where its centre sits, in scene units. [0, 0, 0] otherwise.',
  ).optional(),
  scale: z
    .union([z.number().positive(), z.array(z.number().positive()).length(3)])
    .optional()
    .describe(
      'global3d: how wide it is in scene units (its longest side spans this), or [x, y, z]. 1 otherwise.',
    ),
  orientation: triple(
    'global3d: its rotation about x, then y, then z, in degrees.',
  ).optional(),
  bounds: z
    .array(z.number().min(0).max(1))
    .length(4)
    .optional()
    .describe(
      'canvas: the tile, [x1, y1, x2, y2] as fractions of the canvas from the lower left. The whole canvas otherwise.',
    ),
})

export const INSTANCE_SCHEMAS = {
  set_instances: {
    ...TAB_ARG,
    instances: z
      .array(INSTANCE_ARG)
      .min(1)
      .max(MAX_INSTANCES)
      .optional()
      .describe(
        'What to draw, replacing any instances set before. Each is a global3d volume placed in the scene or a canvas tile.',
      ),
    camera: GLOBAL_CAMERA_ARG.optional().describe(
      'Place the global camera that looks at the global3d instances, in the same call.',
    ),
    clear: z
      .boolean()
      .optional()
      .describe('Drop the instances and go back to the usual layout.'),
  },
} as const

export function registerInstanceTools(
  server: McpServer,
  context: ToolContext,
): void {
  registerSimple(server, context, 'set_instances', {
    title: 'Lay out a 3D scene of volumes, or tile the canvas',
    description:
      'Replaces what NiiVue draws with a list of instances. A global3d instance renders a loaded ' +
      'volume in one shared 3D scene at a `position`, `scale` and `orientation`, seen by the global ' +
      'camera (`camera` here, or set_camera `global`); scene units are free, and a volume of scale 1 ' +
      'is one unit across, its centre at its position. The camera starts at [0, 0, 32] looking down ' +
      '-z with y up. A canvas instance is a tile of the canvas drawn as the usual render. Several instances may ' +
      'draw the same volume, so one load can be shown many times; distinct copies need distinct ' +
      'names. `clear` goes back to the usual layout. Reports the instances and camera as set.',
    inputSchema: INSTANCE_SCHEMAS.set_instances,
    lead: (result) => {
      const n = (result as { instances?: unknown[] })?.instances?.length ?? 0
      return n
        ? `Drawing ${n} instance${n === 1 ? '' : 's'}.`
        : 'Back to the usual layout.'
    },
  })
}
