/**
 * The animate tool: NiiVue's animateTo, a smooth move from the scene as
 * it is to a target state of the camera, the 2D pan and zoom, the
 * crosshair, the clip planes, and each volume's window, opacity and 4D
 * frame or mesh's opacity.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { MESH_ARG, registerSimple, triple, VOLUME_ARG } from './args'
import { TAB_ARG, type ToolContext } from './context'

/**
 * The longest transition a call may ask for, in milliseconds: with the
 * page's grace for a stalled transition it stays inside the bridge's
 * 15 second wait for an answer.
 */
const MAX_ANIMATION_MS = 10000

export const ANIMATE_SCHEMAS = {
  animate: {
    ...TAB_ARG,
    azimuth: z
      .number()
      .optional()
      .describe('The render camera azimuth to end at, in degrees.'),
    elevation: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe('The render camera elevation to end at, -90 to 90 degrees.'),
    zoom: z
      .number()
      .positive()
      .optional()
      .describe("The render's zoom to end at, NiiVue's scaleMultiplier."),
    render_pan: z
      .array(z.number())
      .length(2)
      .optional()
      .describe('The render pan to end at, [x, y].'),
    pan_2d: z
      .array(z.number())
      .length(4)
      .optional()
      .describe(
        "The 2D slices' pan and zoom to end at, NiiVue's [x, y, z, zoom] with x, y and z in millimetres.",
      ),
    crosshair_mm: triple(
      'Where the crosshair ends, in world millimetres.',
    ).optional(),
    clip_planes: z
      .array(
        z.strictObject({
          index: z
            .number()
            .int()
            .min(0)
            .max(5)
            .optional()
            .describe('Which clip plane, 0 to 5. 0 when not given.'),
          depth: z
            .number()
            .min(-2)
            .max(2)
            .optional()
            .describe(
              "The depth to end at, in NiiVue's fraction units as set_clip_plane takes it; beyond 1.8 either way cuts nothing, so moving there slides the cut off.",
            ),
          azimuth: z.number().optional().describe('The azimuth to end at.'),
          elevation: z
            .number()
            .min(-90)
            .max(90)
            .optional()
            .describe('The elevation to end at.'),
        }),
      )
      .max(6)
      .optional()
      .describe(
        'Clip planes to move. What a plane leaves out stays where it is; a plane that cuts nothing yet needs all three.',
      ),
    volumes: z
      .array(
        z.strictObject({
          volume: VOLUME_ARG.optional(),
          cal_min: z.number().optional().describe('The window low to end at.'),
          cal_max: z.number().optional().describe('The window high to end at.'),
          opacity: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe('The opacity to end at, 0 to 1.'),
          frame: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              'The 4D frame to end at, from 0; the frames between are shown in turn.',
            ),
        }),
      )
      .optional()
      .describe(
        'Volumes to change. The base volume when `volume` is left out.',
      ),
    meshes: z
      .array(
        z.strictObject({
          mesh: MESH_ARG.optional(),
          opacity: z
            .number()
            .min(0)
            .max(1)
            .describe('The opacity to end at, 0 to 1.'),
        }),
      )
      .optional()
      .describe('Meshes to fade. The first mesh when `mesh` is left out.'),
    duration_ms: z
      .number()
      .min(0)
      .max(MAX_ANIMATION_MS)
      .optional()
      .describe(
        `How long the move takes, 0 to ${MAX_ANIMATION_MS} milliseconds; 0 jumps straight there. 500 when not given.`,
      ),
    easing: z
      .enum(['linear', 'easeIn', 'easeOut', 'easeInOut'])
      .optional()
      .describe('The pace of the move. easeInOut when not given.'),
    angles: z
      .enum(['shortest', 'literal'])
      .optional()
      .describe(
        'shortest (the default) turns the short way round, so 350 to 10 moves 20 degrees; literal moves through the numbers as given, so 0 to 360 is a full turn.',
      ),
    interrupt_on_input: z
      .boolean()
      .optional()
      .describe(
        'Stop when the person presses on or scrolls the canvas. True when not given.',
      ),
    wait: z
      .boolean()
      .optional()
      .describe(
        'Answer once the move ends (the default), or as soon as it starts.',
      ),
    stop: z
      .boolean()
      .optional()
      .describe(
        'Stop the move under way where it is, in place of starting one.',
      ),
  },
} as const

/** The line an animate answer leads with. */
function animateLead(result: unknown): string | undefined {
  const r = result as {
    stopped?: boolean
    started?: boolean
    reason?: string
    elapsedMs?: number
    failed?: string[]
  }
  if (r?.stopped !== undefined)
    return r.stopped ? 'Stopped the move.' : 'Nothing was moving.'
  if (r?.started) return 'Started the move.'
  if (typeof r?.reason !== 'string') return undefined
  const ms = Math.round(r.elapsedMs ?? 0)
  switch (r.reason) {
    case 'finished':
      return `Finished the move in ${ms} ms.`
    case 'stalled':
      return 'The page drew no frames (a hidden tab?), so the scene jumped to the target.'
    case 'input':
      return `The person took over after ${ms} ms; the move stopped there.`
    case 'failed':
      return `NiiVue could not land ${r.failed?.length ? r.failed.join(', ') : 'part of the move'}; the scene is short of the target there.`
    default:
      return `The move ended (${r.reason}) after ${ms} ms, short of the target.`
  }
}

export function registerAnimateTools(
  server: McpServer,
  context: ToolContext,
): void {
  registerSimple(server, context, 'animate', {
    title: 'Animate to a scene state',
    description:
      'Moves the scene smoothly to a target: the render camera, its zoom and pan, the 2D pan and ' +
      'zoom, the crosshair, the clip planes, and each volume window, opacity and 4D frame or mesh ' +
      'opacity. Only what is given moves. Starting a move ends the one under way; `stop` ends it ' +
      'where it is. Reports how the move ended and the camera, cut and crosshair afterwards.',
    inputSchema: ANIMATE_SCHEMAS.animate,
    lead: animateLead,
  })
}
