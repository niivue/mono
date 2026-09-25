import { describe, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import type { TabState } from '../protocol'
import { type AppSocket, Bridge, NO_APP } from './bridge'
import {
  buildServer,
  CORE_SCHEMAS,
  type Extension,
  reloadNotice,
} from './tools'

const state = (extra: Partial<TabState> = {}): TabState => ({
  volume: 'mni152.nii.gz',
  crosshair: { mm: [0, 0, 0] },
  plane: { name: 'off', depth: 2, azimuth: 0, elevation: 0 },
  ...extra,
})

/** A tab on the bridge that answers every call by echoing the method and params. */
function echoTab(
  bridge: Bridge,
  id: string,
  title: string,
  tabState = state(),
): AppSocket {
  const socket: AppSocket = {
    send(text: string) {
      const request = JSON.parse(text) as {
        id: number
        method: string
        params: Record<string, unknown>
      }
      const result =
        request.method === 'screenshot'
          ? {
              data: 'iVBORw0KGgo=',
              mimeType: 'image/png',
              width: 12,
              height: 8,
            }
          : {
              method: request.method,
              params: request.params,
              description: 'somewhere',
            }
      queueMicrotask(() =>
        bridge.receive(
          socket,
          JSON.stringify({
            id: request.id,
            result,
            state: tabState,
            tab: { title, url: 'http://x' },
          }),
        ),
      )
    },
  }
  bridge.attach(socket)
  bridge.receive(
    socket,
    JSON.stringify({ hello: { id, title, url: 'http://x', state: tabState } }),
  )
  return socket
}

async function connect(bridge: Bridge, extensions: Extension[] = []) {
  const server = buildServer({ bridge, extensions })
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  await server.connect(serverEnd)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientEnd)
  return client
}

const text = (reply: Awaited<ReturnType<Client['callTool']>>): string =>
  (reply.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')

const json = (reply: Awaited<ReturnType<Client['callTool']>>): unknown => {
  const body = text(reply)
  return JSON.parse(
    body.slice(body.indexOf('\n{') + 1 || body.indexOf('\n[') + 1 || 0),
  )
}

describe('core tool schemas', () => {
  it('lists the nine core tools with the arguments each one takes', async () => {
    const client = await connect(new Bridge())
    const { tools } = await client.listTools()
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    expect(Object.keys(byName).sort()).toEqual(Object.keys(CORE_SCHEMAS).sort())
    const required = (name: string) =>
      (byName[name].inputSchema as { required?: string[] }).required ?? []
    const properties = (name: string) =>
      Object.keys(
        (byName[name].inputSchema as { properties?: object }).properties ?? {},
      )
    expect(required('use_tab')).toEqual(['id'])
    expect(required('load_volume')).toEqual(['url'])
    expect(properties('load_volume').sort()).toEqual([
      'colormap',
      'mni',
      'name',
      'url',
    ])
    expect(required('go_to_region')).toEqual(['region'])
    expect(required('set_clip_plane')).toEqual(['plane'])
    expect(required('set_camera').sort()).toEqual(['azimuth', 'elevation'])
    expect(required('list_regions')).toEqual([])
    expect(required('where_am_i')).toEqual([])
    expect(required('screenshot')).toEqual([])
    expect(byName.where_am_i.annotations?.readOnlyHint).toBe(true)
    expect(byName.go_to_region.annotations?.readOnlyHint).toBeUndefined()
  })

  it('offers the six sides, the slice names and current or off as plane names', async () => {
    const client = await connect(new Bridge())
    const { tools } = await client.listTools()
    const enumOf = (tool: string, field: string) => {
      const found = tools.find((t) => t.name === tool)
      if (!found) throw new Error(`no tool ${tool}`)
      const schema = found.inputSchema as {
        properties: Record<string, { enum?: string[] }>
      }
      return (schema.properties[field].enum ?? []).sort()
    }
    expect(enumOf('go_to_region', 'plane')).toEqual(
      [
        'current',
        'left',
        'right',
        'posterior',
        'anterior',
        'inferior',
        'superior',
        'coronal',
        'sagittal',
        'axial',
        'transverse',
        'horizontal',
      ].sort(),
    )
    expect(enumOf('set_clip_plane', 'plane')).toEqual(
      [
        'off',
        'left',
        'right',
        'posterior',
        'anterior',
        'inferior',
        'superior',
        'coronal',
        'sagittal',
        'axial',
        'transverse',
        'horizontal',
      ].sort(),
    )
  })

  it('refuses arguments outside the schema as a tool error, before any tab is asked', async () => {
    const client = await connect(new Bridge())
    const refused = async (name: string, args: Record<string, unknown>) => {
      const reply = await client.callTool({ name, arguments: args })
      expect(reply.isError).toBe(true)
      return text(reply)
    }
    expect(await refused('use_tab', {})).toMatch(/id/)
    expect(await refused('set_camera', { azimuth: 0, elevation: 120 })).toMatch(
      /elevation/,
    )
    expect(
      await refused('go_to_region', { region: 'Insula_L', plane: 'diagonal' }),
    ).toMatch(/plane/)
    expect(await refused('screenshot', { max_width: 10 })).toMatch(/max_width/)
    expect(
      await refused('set_clip_plane', { plane: 'left', depth: 3 }),
    ).toMatch(/depth/)
  })
})

describe('core tools over the bridge', () => {
  it('says what to open when no tab is connected, as a tool error not a protocol one', async () => {
    const client = await connect(new Bridge())
    const reply = await client.callTool({ name: 'where_am_i', arguments: {} })
    expect(reply.isError).toBe(true)
    expect(text(reply)).toBe(NO_APP)
    const tabs = await client.callTool({ name: 'list_tabs', arguments: {} })
    expect(tabs.isError).toBeUndefined()
    expect(json(tabs)).toEqual({ tabs: [] })
  })

  it('forwards each call to the tab and names the tab in where_am_i', async () => {
    const bridge = new Bridge()
    echoTab(bridge, 't1', 'brainsonify')
    const client = await connect(bridge)
    const where = await client.callTool({ name: 'where_am_i', arguments: {} })
    expect(json(where)).toMatchObject({
      tab: { id: 't1', title: 'brainsonify' },
      method: 'where_am_i',
    })
    const go = await client.callTool({
      name: 'go_to_region',
      arguments: { region: 'Insula_L', plane: 'left' },
    })
    expect(text(go)).toMatch(/^Moved to somewhere\n/)
    expect(json(go)).toMatchObject({
      method: 'go_to_region',
      params: { region: 'Insula_L', plane: 'left' },
    })
    const cut = await client.callTool({
      name: 'set_clip_plane',
      arguments: { plane: 'right', depth: 0.2 },
    })
    expect(json(cut)).toMatchObject({ params: { plane: 'right', depth: 0.2 } })
    const load = await client.callTool({
      name: 'load_volume',
      arguments: { url: 'http://x/vol.nii.gz', mni: true },
    })
    expect(json(load)).toMatchObject({
      params: { url: 'http://x/vol.nii.gz', mni: true },
    })
  })

  it('returns the screenshot as image content beside the text', async () => {
    const bridge = new Bridge()
    echoTab(bridge, 't1', 'one')
    const client = await connect(bridge)
    const shot = await client.callTool({
      name: 'screenshot',
      arguments: { max_width: 640 },
    })
    const content = shot.content as Array<{
      type: string
      data?: string
      mimeType?: string
      text?: string
    }>
    expect(content.map((c) => c.type)).toEqual(['text', 'image'])
    expect(content[1]).toMatchObject({
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
    })
    expect(content[0].text).toMatch(/^12×8 pixels\./)
  })

  it('lists tabs, lets one be chosen, and refuses an unknown id in words', async () => {
    const bridge = new Bridge()
    echoTab(bridge, 't1', 'one')
    echoTab(bridge, 't2', 'two')
    const client = await connect(bridge)
    const listed = json(
      await client.callTool({ name: 'list_tabs', arguments: {} }),
    ) as { tabs: Array<{ id: string; bound: boolean }> }
    expect(listed.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    const refused = await client.callTool({ name: 'where_am_i', arguments: {} })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/2 tabs are connected/)
    const chosen = await client.callTool({
      name: 'use_tab',
      arguments: { id: 't2' },
    })
    expect(text(chosen)).toMatch(/^Driving "two"\./)
    expect(
      json(await client.callTool({ name: 'where_am_i', arguments: {} })),
    ).toMatchObject({ tab: { id: 't2' } })
    const missing = await client.callTool({
      name: 'use_tab',
      arguments: { id: 't9' },
    })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toMatch(/No connected tab has the id "t9"/)
  })

  it('leads the first reply after a reload with what the scene was showing', async () => {
    const bridge = new Bridge({ now: () => Date.UTC(2026, 8, 24, 1, 2, 3) })
    const before = state({
      crosshair: { mm: [-38.4, -21.6, 5.2] },
      plane: { name: 'left', depth: 0, azimuth: 270, elevation: 0 },
      sounding: true,
    })
    const first = echoTab(bridge, 't1', 'one', before)
    const client = await connect(bridge)
    await client.callTool({ name: 'where_am_i', arguments: {} })
    bridge.detach(first)
    echoTab(bridge, 't1', 'one', state({ sounding: false }))
    const after = await client.callTool({ name: 'list_regions', arguments: {} })
    expect(text(after)).toMatch(
      /^Note: the tab "one" reloaded at 2026-09-24T01:02:03.000Z, since the last call, so its scene started over\. Changed: crosshair was \[-38, -22, 5\] mm, now \[0, 0, 0\] mm; plane was left, now off; sounding was true, now false\.\n/,
    )
    expect(json(after)).toMatchObject({
      reloaded: { before, reloadedAt: Date.UTC(2026, 8, 24, 1, 2, 3) },
    })
    expect(
      text(await client.callTool({ name: 'list_regions', arguments: {} })),
    ).not.toMatch(/^Note/)
  })

  it('lets an extension add tools over the same context', async () => {
    const bridge = new Bridge()
    echoTab(bridge, 't1', 'one')
    const extension: Extension = {
      name: 'test',
      register(server, context) {
        server.registerTool(
          'ping',
          { description: 'ping', inputSchema: {} },
          async () => context.answer('ping', {}, { lead: () => 'pong' }),
        )
      },
    }
    const client = await connect(bridge, [extension])
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('ping')
    const reply = await client.callTool({ name: 'ping', arguments: {} })
    expect(text(reply)).toMatch(/^pong\n/)
    expect(json(reply)).toMatchObject({ method: 'ping' })
  })
})

describe('reloadNotice', () => {
  it('says when nothing it tracks changed', () => {
    const tab = { id: 't', title: 'one', url: '', connectedAt: 0 }
    expect(
      reloadNotice(tab, { reloadedAt: 0, before: state(), after: state() }),
    ).toMatch(/Nothing it reported has changed\.$/)
    expect(
      reloadNotice(tab, { reloadedAt: 0, before: null, after: state() }),
    ).toMatch(/volume was unset, now mni152\.nii\.gz/)
  })
})
