/**
 * What every tool is answered with.
 *
 * A `ToolContext` is what a tool handler has to work with: the bridge, and
 * `answer`, which puts a call to a page and shapes the reply. The reply is
 * a line to say and then the details as JSON, and when the answering tab
 * has reloaded since the last call the line says so first, with what the
 * scene was showing before, so an agent does not read a fresh scene as
 * the one it left. `TAB_ARG` is the argument that names the tab a call
 * goes to; every tool a page answers spreads it into its schema.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { TAB_PARAM, type TabState } from '../protocol'
import type { Bridge, ResetReport, TabInfo } from './bridge'

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface ToolReply {
  content: Content[]
  isError?: boolean
  [key: string]: unknown
}

/**
 * The argument that names the tab a call goes to, for every tool a page
 * answers. An extension spreads it into its own schemas and passes the
 * value as `tab` to `context.answer`.
 */
export const TAB_ARG = {
  tab: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The id of the tab to ask, from list_tabs or new_tab. Without it, the tab chosen with ' +
        'use_tab answers, or the only one, or the one that answered last.',
    ),
}

/** What a tool handler has to work with. */
export interface ToolContext {
  bridge: Bridge
  /** Where the page is, for `new_tab` to give an address that opens one; unset when not known. */
  pageUrl?: string
  /**
   * Puts `method` to the answering tab, or to the tab `options.tab` names,
   * and shapes the reply: `lead` gives a line to say above the JSON,
   * `image` picks a picture out of the result, which goes as an image
   * block and is left out of the JSON. A thrown error, from the page or
   * the bridge, becomes an error reply.
   */
  answer(
    method: string,
    params?: Record<string, unknown>,
    options?: AnswerOptions,
  ): Promise<ToolReply>
  reply(result: unknown, lead?: string): ToolReply
  failure(error: unknown): ToolReply
}

export interface ReplyShape {
  lead?: (result: unknown, tab: TabInfo) => string | undefined
  /** The picture in the result; the result's `data` and `mimeType` then stay out of the text. */
  image?: (result: unknown) => { data: string; mimeType: string } | undefined
  /** Put the answering tab into the JSON. */
  withTab?: boolean
}

export interface AnswerOptions extends ReplyShape {
  /** The id of the tab to ask, as `TAB_ARG` takes it; the answering tab otherwise. */
  tab?: string
}

/** Something that adds tools to the server: the app's own, over the core's. */
export interface Extension {
  name: string
  register(server: McpServer, context: ToolContext): void
}

export function reply(result: unknown, lead?: string): ToolReply {
  const text = JSON.stringify(result, null, 2)
  return { content: [{ type: 'text', text: lead ? `${lead}\n${text}` : text }] }
}

export function failure(error: unknown): ToolReply {
  const text = error instanceof Error ? error.message : String(error)
  return { isError: true, content: [{ type: 'text', text }] }
}

/** A context over this bridge. */
export function toolContext(
  bridge: Bridge,
  options: { pageUrl?: string } = {},
): ToolContext {
  return {
    bridge,
    ...(options.pageUrl === undefined ? {} : { pageUrl: options.pageUrl }),
    reply,
    failure,
    async answer(method, params = {}, options = {}) {
      try {
        const { result, tab, reloaded } = await bridge.call(
          method,
          params,
          options.tab,
        )
        const lines: string[] = []
        if (reloaded) lines.push(reloadNotice(tab, reloaded))
        const lead = options.lead?.(result, tab)
        if (lead) lines.push(lead)
        let payload = result
        if (isRecord(result) && (options.withTab || reloaded)) {
          payload = {
            ...(options.withTab
              ? { tab: { id: tab.id, title: tab.title } }
              : {}),
            ...result,
            ...(reloaded ? { reloaded } : {}),
          }
        }
        // The picture goes once, as an image block: with it in the text
        // too, a reply would be twice the size and the JSON unreadable.
        const image = options.image?.(result)
        if (image && isRecord(payload)) {
          const { data: _data, mimeType: _mimeType, ...rest } = payload
          payload = rest
        }
        const out = reply(payload, lines.length ? lines.join('\n') : undefined)
        if (image)
          out.content.push({
            type: 'image',
            data: image.data,
            mimeType: image.mimeType,
          })
        return out
      } catch (error) {
        return failure(error)
      }
    },
  }
}

/** The line that says a tab started over, and what changed. */
export function reloadNotice(tab: TabInfo, reset: ResetReport): string {
  const changes = describeChanges(reset.before, reset.after)
  const when = new Date(reset.reloadedAt).toISOString()
  const head = `Note: the tab "${tab.title}" reloaded at ${when}, since the last call, so its scene started over.`
  return changes.length
    ? `${head} Changed: ${changes.join('; ')}.`
    : `${head} Nothing it reported has changed.`
}

function describeChanges(
  before: TabState | null,
  after: TabState | null,
): string[] {
  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ])
  const changes: string[] = []
  for (const key of keys) {
    const was = brief(key, before?.[key])
    const now = brief(key, after?.[key])
    if (was !== now) changes.push(`${key} was ${was}, now ${now}`)
  }
  return changes
}

function brief(key: string, value: unknown): string {
  if (value === undefined || value === null) return 'unset'
  if (key === 'plane' && isRecord(value) && typeof value.name === 'string')
    return value.name
  if (key === 'crosshair' && isRecord(value) && Array.isArray(value.mm)) {
    return `[${(value.mm as number[]).map((n) => Math.round(n)).join(', ')}] mm`
  }
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The address that opens the page as the tab `id`, or null without a page address. */
export function tabAddress(
  pageUrl: string | undefined,
  id: string,
): string | null {
  if (!pageUrl) return null
  try {
    const url = new URL(pageUrl)
    url.searchParams.set(TAB_PARAM, id)
    return url.href
  } catch {
    return null
  }
}
