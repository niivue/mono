/**
 * The server end to end: `startServer` on a free port, pages over real
 * sockets (without a browser: see testing/fake-page.ts), and a real MCP
 * client over HTTP calling every core tool, plus one an extension adds.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'

import { type FakePage, fakePage } from '../testing/fake-page'
import { type RunningServer, startServer } from './http'
import type { Extension } from './tools'

const CORE_TOOLS = [
  'list_tabs',
  'use_tab',
  'load_volume',
  'add_overlay',
  'where_am_i',
  'list_regions',
  'go_to_region',
  'go_to_point',
  'set_clip_plane',
  'set_camera',
  'screenshot',
]

/** The smallest extension: one tool, answered by the page's `set_light` handler. */
const light: Extension = {
  name: 'light',
  register(server, context) {
    server.registerTool(
      'set_light',
      {
        title: 'Turn the light',
        description: 'Turns the page light on or off.',
        inputSchema: { on: z.boolean() },
      },
      async (params) =>
        context.answer('set_light', params, {
          lead: (r) =>
            `Light ${(r as { light: boolean }).light ? 'on' : 'off'}.`,
        }),
    )
  },
}

async function until<T>(
  what: string,
  check: () => Promise<T | null | false | undefined>,
  ms = 10000,
): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const got = await check()
    if (got) return got
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** Millimetres as the page hands them back: a frac-to-mm round trip, so within a hair. */
const mm = (...values: number[]) => values.map((v) => expect.closeTo(v, 3))

type Reply = Awaited<ReturnType<Client['callTool']>>
const text = (reply: Reply): string =>
  (reply.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n')
const json = (reply: Reply): Record<string, unknown> => {
  const body = text(reply)
  const starts = body.startsWith('{') || body.startsWith('[')
  const at = Math.min(
    ...['\n{', '\n['].map((m) => body.indexOf(m)).filter((i) => i >= 0),
    starts ? 0 : Number.POSITIVE_INFINITY,
  )
  return JSON.parse(at === 0 ? body : body.slice(at + 1)) as Record<
    string,
    unknown
  >
}

describe('the server, end to end', () => {
  let server: RunningServer
  let client: Client
  const pages = new Map<string, FakePage>()
  const logged: string[] = []

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args })
  const tabs = async () =>
    (
      json(await call('list_tabs')) as {
        tabs: Array<{ id: string; title: string; bound: boolean }>
      }
    ).tabs

  const openPage = async (id: string, title: string) => {
    pages.get(id)?.close()
    pages.set(id, fakePage({ url: server.appUrl, id, title }))
    await until(`tab ${id}`, async () =>
      (await tabs()).some((tab) => tab.id === id),
    )
  }
  const closePage = async (id: string) => {
    pages.get(id)?.close()
    pages.delete(id)
    await until(
      `tab ${id} to go`,
      async () => !(await tabs()).some((tab) => tab.id === id),
    )
  }

  beforeAll(async () => {
    server = startServer({
      name: 'test',
      port: 0,
      extensions: [light],
      bridge: { noTabHint: 'Open the test page.' },
      log: (line) => logged.push(line),
    })
    client = new Client({ name: 'integration', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  })

  afterAll(async () => {
    await client?.close().catch(() => {})
    for (const page of pages.values()) page.close()
    server?.stop()
  })

  it('serves a status page and logs where it listens', async () => {
    const status = await (
      await fetch(`http://${server.host}:${server.port}/`)
    ).text()
    expect(status).toMatch(/^test MCP server\n/)
    expect(status).toContain(`mcp endpoint: ${server.url}`)
    expect(logged[0]).toBe(`test MCP server on ${server.url}`)
    expect(
      (await fetch(`http://${server.host}:${server.port}/nope`)).status,
    ).toBe(404)
  })

  it('lists the core tools and the extension tool', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...CORE_TOOLS, 'set_light'].sort(),
    )
  })

  it('says what to open while no page is connected', async () => {
    expect(await tabs()).toEqual([])
    const reply = await call('where_am_i')
    expect(reply.isError).toBe(true)
    expect(text(reply)).toBe('No NiiVue tab is connected. Open the test page.')
    expect(text(await call('list_tabs'))).toMatch(
      /^No NiiVue tab is connected\. Open the test page\./,
    )
  })

  it('drives one page through every tool', async () => {
    await openPage('t1', 'first tab')
    expect(await tabs()).toMatchObject([
      { id: 't1', title: 'first tab', bound: true },
    ])
    expect(logged.at(-1)).toBe('tab connected: t1 "first tab"')

    const before = await call('where_am_i')
    expect(json(before)).toMatchObject({
      tab: { id: 't1', title: 'first tab' },
      volume: null,
    })

    const loaded = await call('load_volume', {
      url: 'https://example.test/mni152.nii.gz',
    })
    expect(loaded.isError).toBeUndefined()
    expect(text(loaded)).toMatch(/^Loaded mni152\.nii\.gz\./)
    expect(json(loaded)).toMatchObject({
      name: 'mni152.nii.gz',
      mni: true,
      bounds: { mm: { min: [-100, -100, -100], max: [100, 100, 100] } },
    })
    const failed = await call('load_volume', {
      url: 'https://example.test/missing.nii.gz',
    })
    expect(failed.isError).toBe(true)
    expect(text(failed)).toMatch(/could not be loaded: 404/)

    const overlaid = await call('add_overlay', {
      url: 'https://example.test/zstat.nii.gz',
      colormap: 'red',
    })
    expect(overlaid.isError).toBeUndefined()
    expect(json(overlaid)).toMatchObject({
      volumes: [
        { index: 0, name: 'mni152.nii.gz' },
        { index: 1, name: 'zstat.nii.gz', colormap: 'red', opacity: 0.7 },
      ],
    })

    const regions = json(
      await call('list_regions', { query: 'insula' }),
    ) as unknown as Array<{ label: string }>
    expect(regions.map((r) => r.label)).toEqual(['Insula_L', 'Insula_R'])

    const ambiguous = await call('go_to_region', { region: 'insula' })
    expect(ambiguous.isError).toBe(true)
    expect(text(ambiguous)).toMatch(/could mean 2 regions/)

    const went = await call('go_to_region', {
      region: 'left insula',
      plane: 'left',
    })
    expect(went.isError).toBeUndefined()
    expect(text(went)).toMatch(/^Moved to left insula at -36, 6, 2 mm\./)
    expect(json(went)).toMatchObject({
      region: { label: 'Insula_L' },
      plane: { name: 'left', azimuth: 270 },
      camera: { azimuth: 90, elevation: 0 },
      snapped: false,
    })

    const here = json(await call('where_am_i'))
    expect(here).toMatchObject({
      tab: { id: 't1' },
      crosshair: { mm: mm(-36, 6, 2) },
      plane: { name: 'left' },
      light: false,
    })

    const cut = json(
      await call('set_clip_plane', { plane: 'axial', depth: 0.3, face: false }),
    )
    expect(cut).toMatchObject({
      plane: { name: 'superior', depth: 0.3, azimuth: 0, elevation: 90 },
      camera: { azimuth: 90, elevation: 0 },
    })
    const off = json(await call('set_clip_plane', { plane: 'off' }))
    expect(off).toMatchObject({ plane: { name: 'off' } })

    const turned = json(
      await call('set_camera', { azimuth: 45, elevation: -20 }),
    )
    expect(turned).toMatchObject({ camera: { azimuth: 45, elevation: -20 } })

    const point = json(
      await call('go_to_point', { mm: [10, 20, 30], plane: 'anterior' }),
    )
    expect(point).toMatchObject({
      landed: { mm: mm(10, 20, 30), frac: [0.55, 0.6, 0.65] },
      plane: { name: 'anterior' },
    })

    const shot = await call('screenshot', { max_width: 800 })
    const content = shot.content as Array<{
      type: string
      mimeType?: string
      data?: string
    }>
    expect(content.map((c) => c.type)).toEqual(['text', 'image'])
    expect(content[1].mimeType).toBe('image/png')
    expect(content[1].data?.startsWith('iVBORw0KGgo')).toBe(true)
    expect(json(shot)).toMatchObject({ width: 320, height: 240 })

    expect(text(await call('set_light', { on: true }))).toMatch(/^Light on\./)
    expect(json(await call('set_light', { on: true }))).toEqual({ light: true })
    expect(json(await call('where_am_i'))).toMatchObject({ light: true })
  }, 20000)

  it('asks which tab when two are open, then drives the chosen one', async () => {
    await openPage('t2', 'second tab')
    // The first tab answered last, so it keeps answering.
    expect(json(await call('where_am_i'))).toMatchObject({ tab: { id: 't1' } })
    expect(await tabs()).toMatchObject([
      { id: 't1', bound: true },
      { id: 't2', bound: false },
    ])

    const chosen = await call('use_tab', { id: 't2' })
    expect(text(chosen)).toMatch(/^Driving "second tab"\./)
    expect(json(await call('where_am_i'))).toMatchObject({
      tab: { id: 't2', title: 'second tab' },
      volume: null,
    })
    expect(await tabs()).toMatchObject([
      { id: 't1', bound: false },
      { id: 't2', bound: true },
    ])

    const missing = await call('use_tab', { id: 'nope' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toMatch(/No connected tab has the id "nope"/)

    await closePage('t1')
    await closePage('t2')
    // The bridge gives a gone tab a few seconds to come back from a reload
    // before it says so; that wait is this test's five seconds.
    const gone = await call('where_am_i')
    expect(gone.isError).toBe(true)
    expect(text(gone)).toMatch(
      /chosen with use_tab \(t2\) is no longer connected/,
    )
  }, 20000)

  it('answers calls to one tab in the order they were made, one at a time', async () => {
    await openPage('t2', 'second tab')
    const load = call('load_volume', {
      url: 'https://example.test/mni152.nii.gz',
    })
    const go = call('go_to_region', { region: 'left insula', plane: 'left' })
    const here = call('where_am_i')
    const [loaded, went, where] = await Promise.all([load, go, here])
    expect(loaded.isError).toBeUndefined()
    expect(went.isError).toBeUndefined()
    expect(json(where)).toMatchObject({
      volume: 'mni152.nii.gz',
      crosshair: { mm: mm(-36, 6, 2) },
      plane: { name: 'left' },
    })
    await closePage('t2')
  }, 20000)

  it('refuses the socket to a page from a foreign origin and takes one from loopback', async () => {
    const opened = (origin: string) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(server.appUrl, {
          headers: { origin },
        } as unknown as string[])
        ws.onopen = () => {
          ws.close()
          resolve(true)
        }
        ws.onerror = () => resolve(false)
      })
    expect(await opened('https://evil.example')).toBe(false)
    expect(logged.at(-1)).toBe('refused a socket from https://evil.example')
    expect(await opened('http://localhost:8091')).toBe(true)
    expect(await opened('http://[::1]:5173')).toBe(true)
    expect(await opened(`http://${server.host}:${server.port}`)).toBe(true)
  })

  it('refuses an MCP request whose Host header does not name this server', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })
    const post = (host: string) =>
      fetch(server.url, {
        method: 'POST',
        headers: {
          host,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body,
      })
    const rebound = await post('niivue.attacker.example')
    expect(rebound.status).toBe(403)
    expect(await rebound.text()).toMatch(/Invalid Host header/)
    const own = await post(`localhost:${server.port}`)
    expect(own.status).toBe(200)
  })

  it('re-binds a reloaded tab by id and reports the reset once', async () => {
    await openPage('t3', 'third tab')
    await call('load_volume', { url: 'https://example.test/mni152.nii.gz' })
    await call('go_to_region', { region: 'Precentral_L', plane: 'superior' })
    await call('set_light', { on: true })
    expect(json(await call('where_am_i'))).toMatchObject({
      crosshair: { mm: mm(-40, -6, 50) },
      light: true,
    })

    // A reload: the same id on a new connection.
    await closePage('t3')
    await openPage('t3', 'third tab')

    const after = await call('where_am_i')
    expect(after.isError).toBeUndefined()
    expect(text(after)).toMatch(
      /^Note: the tab "third tab" reloaded at .* so its scene started over\. Changed: volume was mni152\.nii\.gz, now unset; crosshair was \[-40, -6, 50\] mm, now unset; plane was superior, now unset; light was true, now false\./,
    )
    expect(json(after)).toMatchObject({
      tab: { id: 't3' },
      volume: null,
      reloaded: {
        before: { volume: 'mni152.nii.gz', light: true },
        after: { volume: null },
      },
    })
    expect(text(await call('where_am_i'))).not.toMatch(/^Note/)
    await closePage('t3')
  }, 20000)

  it('gives a duplicated tab its own id and keeps the original answering', async () => {
    await openPage('t4', 'fourth tab')
    expect(json(await call('where_am_i'))).toMatchObject({ tab: { id: 't4' } })
    // A duplicate: a fresh page whose copied sessionStorage says t4.
    const copy = fakePage({ url: server.appUrl, id: 't4', title: 'fourth tab' })
    await until('the copy to be welcomed', async () =>
      (await tabs()).some((tab) => tab.id === 't4-2'),
    )
    expect(copy.client.id).toBe('t4-2')
    expect(await tabs()).toMatchObject([
      { id: 't4', title: 'fourth tab', bound: true },
      { id: 't4-2', title: 'fourth tab', bound: false },
    ])
    expect(json(await call('where_am_i'))).toMatchObject({ tab: { id: 't4' } })
    await call('use_tab', { id: 't4-2' })
    const answer = await call('where_am_i')
    expect(text(answer)).not.toMatch(/^Note/)
    expect(json(answer)).toMatchObject({ tab: { id: 't4-2' } })
    copy.close()
    await closePage('t4')
    await until('the copy to go', async () => (await tabs()).length === 0)
  })
})
