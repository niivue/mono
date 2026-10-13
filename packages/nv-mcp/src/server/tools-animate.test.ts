import { describe, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { type AppSocket, Bridge } from './bridge'
import { buildServer } from './tools'

/** A tab that answers every call with `result`. */
function tab(bridge: Bridge, result: unknown) {
  const socket: AppSocket = {
    send(text: string) {
      const request = JSON.parse(text) as { id?: number }
      if (request.id === undefined) return
      queueMicrotask(() =>
        bridge.receive(socket, JSON.stringify({ id: request.id, result })),
      )
    },
  }
  bridge.attach(socket)
  bridge.receive(
    socket,
    JSON.stringify({ hello: { id: 't1', title: 'one', url: 'http://x' } }),
  )
}

async function lead(result: unknown): Promise<string> {
  const bridge = new Bridge()
  tab(bridge, result)
  const server = buildServer({ bridge, extensions: [] })
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  await server.connect(serverEnd)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientEnd)
  const reply = await client.callTool({
    name: 'animate',
    arguments: { azimuth: 10 },
  })
  const [first] = reply.content as Array<{ type: string; text?: string }>
  return first.text?.split('\n')[0] ?? ''
}

describe('animate lead', () => {
  it('names the parts NiiVue could not land', async () => {
    expect(
      await lead({
        completed: false,
        reason: 'failed',
        elapsedMs: 500,
        failed: ['azimuth', 'volumes[1]'],
      }),
    ).toBe(
      'NiiVue could not land azimuth, volumes[1]; the scene is short of the target there.',
    )
    expect(
      await lead({ completed: true, reason: 'finished', elapsedMs: 500 }),
    ).toBe('Finished the move in 500 ms.')
  })
})
