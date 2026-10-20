import { afterAll, describe, expect, it } from 'bun:test'

import { startServer } from './http'

describe('the status page', () => {
  const running = startServer({ port: 0, log: () => {} })
  afterAll(() => running.stop())

  /** The status page, asked for under the Host header given. */
  async function status(hostHeader: string): Promise<[number, string]> {
    const response = await fetch(
      new Request(`http://127.0.0.1:${running.port}/`, {
        headers: { host: hostHeader },
      }),
    )
    return [response.status, await response.text()]
  }

  it('answers this server by its own address', async () => {
    const [code, text] = await status(`127.0.0.1:${running.port}`)
    expect(code).toBe(200)
    expect(text).toContain('tabs (* answers)')
  })

  it('refuses a Host that is not this server, as a rebound name sends', async () => {
    const [code, text] = await status(`attacker.example:${running.port}`)
    expect(code).toBe(403)
    expect(text).not.toContain('tabs')
  })
})
