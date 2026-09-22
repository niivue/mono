// Registry id generation: every channel of every source must survive into the
// registry under a unique id, whatever the channel names sanitize to and
// however many sources collide after sanitization.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { VolumeAdapter } from '../src/adapters/nifti.ts'
import { buildEntries, Registry, uniqueChannelId } from '../src/registry.ts'

let tmpDir = ''

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-ids-'))
})

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

/** An in-memory multi-channel adapter: geometry is fixed, channels vary. */
function fakeAdapter(channelNames: string[]): VolumeAdapter {
  return {
    format: 'fake',
    canHandle: () => true,
    probe: async () => ({
      shape: [2, 2, 2],
      dtype: 'uint8',
      spacing: [1, 1, 1],
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    }),
    load: async () => {
      throw new Error('not needed')
    },
    probeChannels: async () =>
      channelNames.map((name, index) => ({ index, name })),
  }
}

describe('uniqueChannelId', () => {
  test('prefers the sanitized name, then the index, then a suffix', () => {
    const used = new Set<string>()
    expect(uniqueChannelId('base', 'DNA raw', 0, used)).toBe('base_DNA_raw')
    used.add('base_DNA_raw')
    expect(uniqueChannelId('base', 'DNA_raw', 1, used)).toBe('base_c1')
    used.add('base_c1')
    // A channel NAMED like the fallback, whose fallback is also taken.
    used.add('base_c2')
    expect(uniqueChannelId('base', 'c2', 2, used)).toBe('base_c2_2')
  })
})

describe('buildEntries channel ids', () => {
  test('two names that sanitize identically both survive', async () => {
    const entries = await buildEntries(
      fakeAdapter(['DNA raw', 'DNA_raw']),
      '/fake',
      'base',
    )
    expect(entries.map((e) => e.id)).toEqual(['base_DNA_raw', 'base_c1'])
    expect(entries.map((e) => e.channel)).toEqual([0, 1])
  })

  test('three or more colliding names all get distinct ids', async () => {
    // Space, slash and question mark all sanitize to `_`, so every name lands
    // on `s_a_b` and only the first keeps it.
    const entries = await buildEntries(
      fakeAdapter(['a b', 'a_b', 'a/b', 'a?b']),
      '/fake',
      's',
    )
    expect(entries.map((e) => e.id)).toEqual(['s_a_b', 's_c1', 's_c2', 's_c3'])
    // Every channel index is preserved against its entry.
    expect(entries.map((e) => e.channel)).toEqual([0, 1, 2, 3])
  })

  test('a channel named like the index fallback cannot displace it', async () => {
    // Channel 0 is literally named `c1`, squatting on channel 1's fallback id.
    // Channel 1 duplicates the name, so it needs that very fallback and must
    // move to the numeric suffix; channel 2 duplicates it again.
    const entries = await buildEntries(
      fakeAdapter(['c1', 'c1', 'c1', 'c2']),
      '/fake',
      'p',
    )
    const ids = entries.map((e) => e.id)
    expect(new Set(ids).size).toBe(4)
    expect(ids[0]).toBe('p_c1')
    expect(ids[1]).toBe('p_c1_2')
    expect(ids[2]).toBe('p_c2')
    // Channel 3's name `c2` is now taken by channel 2's fallback.
    expect(ids[3]).toBe('p_c3')
  })
})

// Zarr v2 czyx store with named omero channels, minimal enough to hand-write.
async function writeMultiChannelZarr(
  dir: string,
  channelNames: string[],
): Promise<void> {
  const C = channelNames.length
  const [Z, Y, X] = [2, 2, 2]
  await fs.mkdir(path.join(dir, '0'), { recursive: true })
  await fs.writeFile(
    path.join(dir, '.zgroup'),
    JSON.stringify({ zarr_format: 2 }),
  )
  await fs.writeFile(
    path.join(dir, '.zattrs'),
    JSON.stringify({
      multiscales: [
        {
          version: '0.4',
          axes: [
            { name: 'c', type: 'channel' },
            { name: 'z', type: 'space' },
            { name: 'y', type: 'space' },
            { name: 'x', type: 'space' },
          ],
          datasets: [
            {
              path: '0',
              coordinateTransformations: [
                { type: 'scale', scale: [1, 1, 1, 1] },
              ],
            },
          ],
        },
      ],
      omero: { channels: channelNames.map((label) => ({ label })) },
    }),
  )
  await fs.writeFile(
    path.join(dir, '0', '.zarray'),
    JSON.stringify({
      zarr_format: 2,
      shape: [C, Z, Y, X],
      chunks: [C, Z, Y, X],
      dtype: '|u1',
      compressor: null,
      fill_value: 0,
      order: 'C',
      filters: null,
    }),
  )
  await fs.writeFile(
    path.join(dir, '0', '0.0.0.0'),
    new Uint8Array(C * Z * Y * X),
  )
}

describe('cross-source id collisions', () => {
  test('two sources that sanitize identically both keep every channel', async () => {
    const dir = path.join(tmpDir, 'cross')
    // `multi a.zarr` and `multi_a.zarr` sanitize to the same base id.
    await writeMultiChannelZarr(path.join(dir, 'multi a.zarr'), ['ch0', 'ch1'])
    await writeMultiChannelZarr(path.join(dir, 'multi_a.zarr'), ['ch0', 'ch1'])
    const reg = new Registry()
    await reg.scan(dir)

    const ids = [...reg.entries.keys()]
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
    // Both sources' channels are present: two entries per source path.
    const bySource = new Map<string, number>()
    for (const entry of reg.entries.values()) {
      bySource.set(entry.source, (bySource.get(entry.source) ?? 0) + 1)
    }
    expect([...bySource.values()]).toEqual([2, 2])
    // The demo groups entries by dataset. IDs alone are not enough: distinct
    // sources that sanitize alike must not become one mixed channel set.
    const byDataset = new Map<string, number>()
    for (const entry of reg.entries.values()) {
      byDataset.set(entry.dataset, (byDataset.get(entry.dataset) ?? 0) + 1)
    }
    expect([...byDataset.values()]).toEqual([2, 2])
  })
})
