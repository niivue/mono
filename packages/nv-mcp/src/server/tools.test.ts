import { describe, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import type { TabState } from '../protocol'
import { type AppSocket, Bridge } from './bridge'
import { type Extension, reloadNotice } from './context'
import { buildServer, CORE_SCHEMAS } from './tools'

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

async function connect(
  bridge: Bridge,
  extensions: Extension[] = [],
  pageUrl?: string,
) {
  const server = buildServer({ bridge, extensions, pageUrl })
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
  it('lists every core tool with the arguments each one takes', async () => {
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
    // Every tool a page answers takes the tab to ask; the others do not.
    for (const name of Object.keys(CORE_SCHEMAS)) {
      const asksAPage = !['list_tabs', 'use_tab', 'new_tab'].includes(name)
      expect([name, properties(name).includes('tab')]).toEqual([
        name,
        asksAPage,
      ])
    }
    expect(required('new_tab')).toEqual([])
    expect(byName.new_tab.annotations?.readOnlyHint).toBe(true)
  })

  it('refuses arguments outside the schema as a tool error, before any tab is asked', async () => {
    const client = await connect(new Bridge())
    const refused = async (name: string, args: Record<string, unknown>) => {
      const reply = await client.callTool({ name, arguments: args })
      expect(reply.isError).toBe(true)
      return text(reply)
    }
    expect(await refused('use_tab', {})).toMatch(/id/)
  })
})

describe('core tools over the bridge', () => {
  it('lists tabs, lets one be chosen, and refuses an unknown id in words', async () => {
    const bridge = new Bridge()
    echoTab(bridge, 't1', 'one')
    echoTab(bridge, 't2', 'two')
    const client = await connect(bridge)
    const listed = json(
      await client.callTool({ name: 'list_tabs', arguments: {} }),
    ) as { tabs: Array<{ id: string; bound: boolean }> }
    expect(listed.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    const chosen = await client.callTool({
      name: 'use_tab',
      arguments: { id: 't2' },
    })
    expect(text(chosen)).toMatch(/^Driving "two"\./)
    const missing = await client.callTool({
      name: 'use_tab',
      arguments: { id: 't9' },
    })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toMatch(/No connected tab has the id "t9"/)
  })

  it('makes up a tab id and the address that opens the page as that tab', async () => {
    const bridge = new Bridge()
    const client = await connect(bridge, [], 'http://localhost:8091/?agent')
    const made = await client.callTool({ name: 'new_tab', arguments: {} })
    const { id, url } = json(made) as { id: string; url: string }
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(url).toBe(`http://localhost:8091/?agent=&tab=${id}`)
    expect(text(made)).toMatch(
      new RegExp(
        `^Open ${url.replace(/[?]/g, '\\?')} to connect a tab with the id ${id}\\.\n`,
      ),
    )
    const again = json(
      await client.callTool({ name: 'new_tab', arguments: {} }),
    ) as { id: string }
    expect(again.id).not.toBe(id)
  })

  it('gives the id alone, and says where to put it, when the page address is not known', async () => {
    const client = await connect(new Bridge())
    const made = await client.callTool({ name: 'new_tab', arguments: {} })
    const body = json(made) as { id: string; url?: string }
    expect(body.url).toBeUndefined()
    expect(text(made)).toMatch(
      new RegExp(`^Open the page with \\?tab=${body.id} in its address`),
    )
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
