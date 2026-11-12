import { expect, test } from 'bun:test'
import NiiVue, {
  type ChunkedVolumeSource,
  type DocumentSourceResolver,
  NiiDataType,
  type VolumeFrameSource,
} from '@/index'
import { captureWarnings, documentFile } from '@/testing/headless'
import { channelVolumeFile } from '@/volume/channelVolumeFile'

// VOL-02: lazy-time document restore through the host's resolveSource.

const SHAPE: [number, number, number] = [8, 8, 8]

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i++)
    await new Promise((r) => setImmediate(r))
  if (!ok()) throw new Error('timed out')
}

function chunkedSource(
  opts: { frames?: number; revision?: string; disposed?: string[] } = {},
): ChunkedVolumeSource {
  return {
    levels: [{ level: 0, shape: SHAPE, spacing: [1, 1, 1] }],
    datatypeCode: NiiDataType.DT_UINT8,
    frames: opts.frames ?? 3,
    revision: opts.revision,
    async fetchChunk({ texDims, frame = 0 }) {
      return new Uint8Array(texDims[0] * texDims[1] * texDims[2]).fill(
        10 + frame,
      )
    },
    dispose: () => opts.disposed?.push(opts.revision ?? 'source'),
  }
}

const DESCRIPTOR = {
  kind: 'test-zarr',
  url: 'https://user:pw@example.org/store.zarr?X-Amz-Signature=abc#frag',
  params: {
    channel: 1,
    token: 'secret',
    level: 0,
    keyframe: 2,
    next: 'https://example.org/x?X-Amz-Signature=abc',
  },
}

async function savedStreamed(revision = 'r1'): Promise<Uint8Array> {
  const nv = new NiiVue({ backend: 'webgl2' })
  const chunked = await nv.loadChunkedVolume(chunkedSource({ revision }), {
    coarseFloor: false,
    descriptor: DESCRIPTOR,
    calMin: 5,
    calMax: 50,
    name: 'stream',
  })
  await chunked.setFrame(2)
  return nv.serializeDocument({ format: 'json' })
}

test('a streamed volume saves its descriptor, frame and window, never credentials', async () => {
  const text = new TextDecoder().decode(await savedStreamed())
  for (const secret of ['abc', 'secret', 'X-Amz', 'pw@', 'frag', 'token'])
    expect(text).not.toContain(secret)
  const doc = JSON.parse(text)
  expect(doc.volumes[0].source).toEqual({
    descriptor: {
      kind: 'test-zarr',
      url: 'https://example.org/store.zarr',
      params: { channel: 1, level: 0, keyframe: 2 },
      revision: 'r1',
    },
    frame: 2,
  })
  expect(doc.volumes[0].url).toBeUndefined()
})

test('restore reopens the source through the host and shows the saved frame', async () => {
  const seen: unknown[] = []
  const resolveSource: DocumentSourceResolver = (d, ctx) => {
    seen.push({ d, streamed: ctx.streamed })
    return chunkedSource({ revision: 'r1' })
  }
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadDocument(documentFile(await savedStreamed()), { resolveSource })
  expect(seen).toEqual([
    {
      d: {
        kind: 'test-zarr',
        url: 'https://example.org/store.zarr',
        params: { channel: 1, level: 0, keyframe: 2 },
        revision: 'r1',
      },
      streamed: true,
    },
  ])
  const vol = nv.volumes[0]
  expect(vol.name).toBe('stream')
  expect(nv.getFrame4D(vol.id ?? '')).toBe(2)
  expect([vol.calMin, vol.calMax]).toEqual([5, 50])
  // Saving again keeps the descriptor.
  const again = JSON.parse(
    new TextDecoder().decode(nv.serializeDocument({ format: 'json' })),
  )
  expect(again.volumes[0].source.frame).toBe(2)
})

test('missing source: no resolver, null, or a throw skips the streamed volume with a warning', async () => {
  const bytes = await savedStreamed()
  for (const resolveSource of [
    undefined,
    () => null,
    () => {
      throw new Error('offline')
    },
  ] as (DocumentSourceResolver | undefined)[]) {
    const warn = captureWarnings()
    const nv = new NiiVue({ backend: 'webgl2' })
    try {
      await nv.loadDocument(documentFile(bytes), { resolveSource })
    } finally {
      warn.restore()
    }
    expect(nv.volumes.length).toBe(0)
    expect(warn.messages.join('\n')).toContain('not restored')
  }
})

test('a changed source revision warns and clamps the frame to the new count', async () => {
  const warn = captureWarnings()
  const nv = new NiiVue({ backend: 'webgl2' })
  try {
    await nv.loadDocument(documentFile(await savedStreamed('r1')), {
      resolveSource: () => chunkedSource({ revision: 'r2', frames: 2 }),
    })
  } finally {
    warn.restore()
  }
  expect(warn.messages.join('\n')).toContain('revision r1 -> r2')
  expect(nv.getFrame4D(nv.volumes[0].id ?? '')).toBe(1)
  const again = JSON.parse(
    new TextDecoder().decode(nv.serializeDocument({ format: 'json' })),
  )
  expect(again.volumes[0].source.descriptor.revision).toBe('r2')
})

test('a newer document replaces a pending restore, which disposes its source', async () => {
  const streamed = await savedStreamed()
  const plain = new NiiVue({ backend: 'webgl2' })
  await plain.loadVolumes([
    {
      url: channelVolumeFile(
        [2, 2, 2],
        [1, 1, 1],
        NiiDataType.DT_UINT8,
        new Uint8Array(8).fill(7),
        'plain',
      ),
    },
  ])
  const plainDoc = plain.serializeDocument()
  const disposed: string[] = []
  let release: () => void = () => {}
  let signal: AbortSignal | undefined
  const nv = new NiiVue({ backend: 'webgl2' })
  const first = nv.loadDocument(documentFile(streamed), {
    resolveSource: async (_d, ctx) => {
      signal = ctx.signal
      await new Promise<void>((r) => {
        release = r
      })
      return chunkedSource({ revision: 'r1', disposed })
    },
  })
  await until(() => signal !== undefined)
  await nv.loadDocument(documentFile(plainDoc))
  // The resolver ignores its signal, yet the superseded load finishes.
  await first
  expect(signal?.aborted).toBe(true)
  release()
  await until(() => disposed.length > 0)
  expect(disposed).toEqual(['r1'])
  expect(nv.volumes.map((v) => v.name)).toEqual(['plain.nii'])
})

// A whole lazy volume: the shown frame is embedded, the source reattached.

const N = 8
function frameSource(
  descriptor = DESCRIPTOR,
  revision = 'r1',
  loads: number[] = [],
): VolumeFrameSource {
  return {
    count: 5,
    frame: 0,
    group: {},
    descriptor,
    revision,
    load: async (t) => {
      loads.push(t)
      return new Uint8Array(N).fill(100 + t)
    },
  }
}

async function savedLazy(): Promise<Uint8Array> {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([
    {
      url: channelVolumeFile(
        [2, 2, 2],
        [1, 1, 1],
        NiiDataType.DT_UINT8,
        new Uint8Array(N).fill(100),
        'lazy',
      ),
      frameSource: frameSource(),
    },
  ])
  await nv.setFrame4D('lazy.nii', 3)
  return nv.serializeDocument()
}

test('a lazy volume restores its embedded frame and reattaches the source', async () => {
  const bytes = await savedLazy()
  const loads: number[] = []
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadDocument(documentFile(bytes), {
    resolveSource: (_d, ctx) =>
      ctx.streamed ? null : frameSource(DESCRIPTOR, 'r1', loads),
  })
  expect(nv.volumes[0].img?.[0]).toBe(103)
  expect(nv.getFrame4D('lazy.nii')).toBe(3)
  expect(loads).toEqual([]) // same revision: the embedded frame is current
  await nv.setFrame4D('lazy.nii', 4)
  expect(nv.volumes[0].img?.[0]).toBe(104)
})

test('a lazy volume refetches its shown frame when the revision moved, and stays static offline', async () => {
  const bytes = await savedLazy()
  const loads: number[] = []
  const warn = captureWarnings()
  const moved = new NiiVue({ backend: 'webgl2' })
  const offline = new NiiVue({ backend: 'webgl2' })
  try {
    await moved.loadDocument(documentFile(bytes), {
      resolveSource: () => ({
        ...frameSource(DESCRIPTOR, 'r2', loads),
        load: async (t: number) => {
          loads.push(t)
          return new Uint8Array(N).fill(200 + t)
        },
      }),
    })
    await offline.loadDocument(documentFile(bytes), {
      resolveSource: () => {
        throw new Error('offline')
      },
    })
  } finally {
    warn.restore()
  }
  expect(loads).toEqual([3])
  expect(moved.volumes[0].img?.[0]).toBe(203)
  expect(offline.volumes[0].img?.[0]).toBe(103)
  expect(offline.volumes[0].frameSource).toBeUndefined()
})

test('a streamed volume that fails to open is skipped; the rest of the document loads', async () => {
  const bytes = await savedStreamed()
  const disposed: string[] = []
  const warn = captureWarnings()
  const nv = new NiiVue({ backend: 'webgl2' })
  try {
    await nv.loadDocument(documentFile(bytes), {
      resolveSource: () => ({
        ...chunkedSource({ revision: 'r1', disposed }),
        levels: [],
      }),
    })
  } finally {
    warn.restore()
  }
  expect(nv.volumes.length).toBe(0)
  expect(disposed).toEqual(['r1'])
  expect(warn.messages.join('\n')).toContain('not restored')
})

test('restore keeps every saved display field of a streamed volume', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadChunkedVolume(chunkedSource({ revision: 'r1' }), {
    coarseFloor: false,
    descriptor: DESCRIPTOR,
    calMin: 5,
    calMax: 50,
  })
  await nv.setVolume(0, {
    isColormapInverted: true,
    colormapType: 1,
    isLegendVisible: false,
    visible: false,
  })
  const bytes = nv.serializeDocument()
  const back = new NiiVue({ backend: 'webgl2' })
  await back.loadDocument(documentFile(bytes), {
    resolveSource: () => chunkedSource({ revision: 'r1' }),
  })
  const v = back.volumes[0]
  expect([
    v.isColormapInverted,
    v.colormapType,
    v.isLegendVisible,
    v.visible,
  ]).toEqual([true, 1, false, false])
})

test('loadVolumes supersedes a document still restoring', async () => {
  const streamed = await savedStreamed()
  let release: (() => void) | null = null
  let disposed = 0
  const nv = new NiiVue({ backend: 'webgl2' })
  const restoring = nv.loadDocument(documentFile(streamed), {
    resolveSource: async () => {
      await new Promise<void>((r) => {
        release = r
      })
      return { ...chunkedSource({ revision: 'r1' }), dispose: () => disposed++ }
    },
  })
  await until(() => release !== null)
  await nv.loadVolumes([
    {
      url: channelVolumeFile(
        [2, 2, 2],
        [1, 1, 1],
        NiiDataType.DT_UINT8,
        new Uint8Array(8).fill(7),
        'plain',
      ),
    },
  ])
  await restoring
  ;(release as unknown as () => void)()
  await until(() => disposed > 0)
  expect(nv.volumes.map((v) => v.name)).toEqual(['plain.nii'])
})

test('a superseded document drops the meshes it added late', async () => {
  const root = new URL('../../dev-images/images', import.meta.url).pathname
  let open: () => void = () => {}
  const gate = new Promise<void>((r) => {
    open = r
  })
  let onRequest: () => void = () => {}
  const requested = new Promise<void>((r) => {
    onRequest = r
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      onRequest()
      await gate
      return new Response(Bun.file(root + new URL(req.url).pathname))
    },
  })
  try {
    const doc = JSON.stringify({
      version: 11,
      meshes: [{ url: new URL('/meshes/CIT168.mz3', server.url).href }],
    })
    const plainDoc = new NiiVue({ backend: 'webgl2' }).serializeDocument()
    const nv = new NiiVue({ backend: 'webgl2' })
    const first = nv.loadDocument(documentFile(doc, 'mesh.json'))
    await requested
    await nv.loadDocument(documentFile(plainDoc))
    open()
    await first
    expect(nv.meshes.length).toBe(0)
  } finally {
    server.stop(true)
  }
})

test('credential params are matched by word and stripped from saved URLs; keyframe and design are kept', async () => {
  const { savedDescriptor, isCredentialParam } = await import(
    '@/documentSources'
  )
  for (const bad of [
    'token',
    'access_token',
    'X-Amz-Signature',
    'x-goog-credential',
    'Key-Pair-Id',
    'apiKey',
    'api_key',
    'accessKey',
    'clientSecret',
    'passwd',
    'sig',
    'sessionId',
    'Authorization',
    'jwt',
    'JWT',
    'pwd',
    'pass',
    'bearer',
    'cookie',
    'hdnts',
    'GoogleAccessId',
    'Policy',
    'header',
    'jsessionid',
  ])
    expect([bad, isCredentialParam(bad)]).toEqual([bad, true])
  for (const ok of ['keyframe', 'design', 'channel', 'level', 'signal'])
    expect([ok, isCredentialParam(ok)]).toEqual([ok, false])
  // A relative URL keeps no query and a scheme URL that does not parse no user info.
  expect(savedDescriptor({ kind: 'k', url: 'stores/a.zarr?sig=1#x' }).url).toBe(
    'stores/a.zarr',
  )
  expect(savedDescriptor({ kind: 'k', url: 'http://u:p@[bad/x?y' }).url).toBe(
    'http://[bad/x',
  )
  // Bearer values, protocol-relative user info and path session ids.
  const d = savedDescriptor({
    kind: 'k',
    url: '//user:pw@host/a.zarr;jsessionid=XYZ',
    params: {
      channel: 1,
      note: 'Bearer abc',
      other: 'bearer\tabc',
      mirror: '//alice:secret@cdn.example.org/a',
      spaced: '  Bearer abc123',
    },
  })
  expect(d).toEqual({ kind: 'k', url: '//host/a.zarr', params: { channel: 1 } })
  expect(
    savedDescriptor({ kind: 'k', url: 'https://h/a;JSESSIONID=1/b.zarr' }).url,
  ).toBe('https://h/a/b.zarr')
})

test('a malformed source cannot fail a load after the scene is cleared', async () => {
  const doc = JSON.parse(new TextDecoder().decode(await savedStreamed()))
  doc.volumes[0].source = { descriptor: { kind: 7 }, frame: 2 }
  const lazy = JSON.parse(new TextDecoder().decode(await savedStreamed()))
    .volumes[0]
  lazy.source.frame = 'two'
  doc.volumes.push(lazy)
  const warn = captureWarnings()
  const nv = new NiiVue({ backend: 'webgl2' })
  try {
    await nv.loadDocument(documentFile(JSON.stringify(doc), 'doc.json'), {
      resolveSource: () => chunkedSource({ revision: 'r1' }),
    })
  } finally {
    warn.restore()
  }
  const text = warn.messages.join('\n')
  expect(text).toContain('malformed source')
  expect(text).toContain('showing frame 0')
  expect(nv.volumes.length).toBe(1)
  expect(nv.getFrame4D(nv.volumes[0].id ?? '')).toBe(0)
})

test('a streamed first volume that is not restored does not hand its drawing to the next volume', async () => {
  const src = new NiiVue({ backend: 'webgl2' })
  await src.loadChunkedVolume(chunkedSource({ revision: 'r1' }), {
    coarseFloor: false,
    descriptor: DESCRIPTOR,
    name: 'stream',
  })
  await src.addVolume(
    await (async () => {
      const other = new NiiVue({ backend: 'webgl2' })
      await other.loadVolumes([
        {
          url: channelVolumeFile(
            SHAPE,
            [1, 1, 1],
            NiiDataType.DT_UINT8,
            new Uint8Array(512).fill(1),
            'next',
          ),
        },
      ])
      return other.volumes[0]
    })(),
  )
  src.createEmptyDrawing()
  const dv = src.drawingVolume
  if (!dv?.img) throw new Error('no drawing')
  dv.img.fill(7)
  const bytes = await src.serializeDocument()
  const warn = captureWarnings()
  const nv = new NiiVue({ backend: 'webgl2' })
  try {
    await nv.loadDocument(documentFile(bytes), { resolveSource: () => null })
  } finally {
    warn.restore()
  }
  expect(nv.volumes.map((v) => v.name)).toEqual(['next.nii'])
  expect(nv.drawingVolume).toBeNull()
  expect(warn.messages.join('\n')).toContain('drawing is not loaded')
})

test('a resolver that supersedes its document synchronously does not hold the old restore', async () => {
  const streamed = await savedStreamed()
  const nv = new NiiVue({ backend: 'webgl2' })
  let next: Promise<unknown> = Promise.resolve()
  const first = nv.loadDocument(documentFile(streamed), {
    resolveSource: () => {
      next = nv.loadDocument(documentFile(streamed), {
        resolveSource: () => chunkedSource({ revision: 'r1' }),
      })
      return new Promise<null>(() => {})
    },
  })
  const settled = await Promise.race([
    first.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 200)),
  ])
  await next
  expect(settled).toBe(true)
})

test('a source of the wrong kind is disposed', async () => {
  const disposed: string[] = []
  const lazy = new NiiVue({ backend: 'webgl2' })
  await lazy.loadDocument(documentFile(await savedLazy()), {
    resolveSource: () => chunkedSource({ revision: 'lazy', disposed }),
  })
  const streamed = new NiiVue({ backend: 'webgl2' })
  await streamed.loadDocument(documentFile(await savedStreamed()), {
    resolveSource: () => ({
      ...frameSource(),
      dispose: () => disposed.push('streamed'),
    }),
  })
  expect(disposed).toEqual(['lazy', 'streamed'])
})

test('a lazy restore superseded during its revision refresh disposes its source', async () => {
  const bytes = await savedLazy()
  let disposed = 0
  const nv = new NiiVue({ backend: 'webgl2' })
  let next: Promise<unknown> = Promise.resolve()
  const first = nv.loadDocument(documentFile(bytes), {
    resolveSource: () => ({
      ...frameSource(DESCRIPTOR, 'r2'),
      load: async () => {
        next = nv.loadDocument(documentFile(bytes))
        return new Uint8Array(N)
      },
      dispose: () => disposed++,
    }),
  })
  await first
  await next
  expect(disposed).toBe(1)
})
