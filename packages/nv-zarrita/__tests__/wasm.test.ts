// zarrita-wasm: the wasm decode path must give exactly the same results as
// zarrita.js's own codecs, on the main thread and in workers.
import * as path from 'node:path'
import * as url from 'node:url'
import FileSystemStore from '@zarrita/storage/fs'
import { afterAll, describe, expect, it } from 'vitest'
import * as zarr from '../src/index.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const roots = ['v2', 'v3'].map((v) =>
  path.resolve(__dirname, `../fixtures/${v}/data.zarr`),
)

async function listArrays(root: string): Promise<string[]> {
  const fs = await import('node:fs/promises')
  const out: string[] = []
  for (const name of await fs.readdir(root)) {
    const p = path.join(root, name)
    if ((await fs.stat(p)).isDirectory()) out.push(name)
  }
  return out.sort()
}

type Mode = 'js' | 'main' | 'workers' | 'shared-main' | 'shared-workers'

function setMode(mode: Mode) {
  zarr.configureWasm({ gzip: 'wasm' }) // exercise wasm for gzip fixtures too
  zarr.configureWasm(
    mode === 'js'
      ? { enabled: false, sharedOutput: false }
      : mode === 'main'
        ? { enabled: true, workers: 0, sharedOutput: false }
        : mode === 'workers'
          ? {
              enabled: true,
              workers: 2,
              minWorkerBytes: 0,
              sharedOutput: false,
            }
          : mode === 'shared-main'
            ? { enabled: true, workers: 0, sharedOutput: true }
            : {
                enabled: true,
                workers: 2,
                minWorkerBytes: 0,
                sharedOutput: true,
              },
  )
}

/** Read `chunk` back as plain values in C order, whatever its strides. */
function logicalValues(chunk: {
  data: unknown
  shape: number[]
  stride: number[]
}) {
  const data = chunk.data as ArrayLike<unknown> & {
    get?: (i: number) => unknown
  }
  const values: unknown[] = []
  const n = chunk.shape.reduce((a, b) => a * b, 1)
  const idx = new Array(chunk.shape.length).fill(0)
  for (let i = 0; i < n; i++) {
    let off = 0
    for (let k = 0; k < idx.length; k++) off += idx[k] * chunk.stride[k]
    const v = data.get ? data.get(off) : data[off]
    // Compare bit patterns so NaN payloads and -0 must match exactly.
    values.push(
      typeof v === 'number'
        ? Array.from(new Uint8Array(new Float64Array([v]).buffer)).join(',')
        : v,
    )
    for (let k = idx.length - 1; k >= 0; k--) {
      if (++idx[k] < chunk.shape[k]) break
      idx[k] = 0
    }
  }
  return values
}

async function readAll(mode: Mode) {
  setMode(mode)
  const results: Record<string, unknown> = {}
  for (const root of roots) {
    const store = new FileSystemStore(root)
    for (const name of await listArrays(root)) {
      let node:
        | zarr.Array<zarr.DataType, FileSystemStore>
        | zarr.Group<FileSystemStore>
      try {
        node = await zarr.open(zarr.root(store).resolve(name))
      } catch {
        continue
      }
      if (!(node instanceof zarr.Array)) continue
      const key = `${path.basename(path.dirname(root))}/${name}`
      try {
        const chunk = await zarr.get(node)
        const values = logicalValues(chunk)
        results[key] = { shape: chunk.shape, values }
      } catch (e) {
        results[key] = { error: (e as Error).name }
      }
    }
  }
  return results
}

describe('wasm decode path', () => {
  afterAll(() => {
    zarr.configureWasm({
      enabled: true,
      workers: 2,
      minWorkerBytes: 64 * 1024,
      sharedOutput: false,
    })
    zarr.terminateWasmWorkers()
  })

  it('matches zarrita.js codecs on every fixture (main thread and workers)', async () => {
    const js = await readAll('js')
    expect(Object.keys(js).length).toBeGreaterThan(60)
    for (const mode of [
      'main',
      'workers',
      'shared-main',
      'shared-workers',
    ] as const) {
      expect(await readAll(mode), mode).toStrictEqual(js)
    }
  })

  it('matches zarrita.js on random selections in every mode', async () => {
    // Deterministic pseudo-random selections over every N-d fixture array.
    let seed = 1
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const cases: {
      root: string
      name: string
      sel: (number | zarr.Slice | null)[]
    }[] = []
    for (const root of roots) {
      for (const name of await listArrays(root)) {
        let node: unknown
        try {
          node = await zarr.open(
            zarr.root(new FileSystemStore(root)).resolve(name),
          )
        } catch {
          continue
        }
        if (!(node instanceof zarr.Array) || node.shape.length < 1) continue
        for (let t = 0; t < 6; t++) {
          const sel = node.shape.map((len: number) => {
            const r = rand(4)
            if (r === 0) return null
            if (r === 1) return rand(len)
            const a = rand(len)
            const b = a + 1 + rand(len - a)
            return zarr.slice(a, b, r === 3 ? 1 + rand(3) : 1)
          })
          cases.push({ root, name, sel })
        }
      }
    }
    expect(cases.length).toBeGreaterThan(200)
    const run = async (mode: Mode) => {
      setMode(mode)
      const out: unknown[] = []
      for (const c of cases) {
        const arr = (await zarr.open(
          zarr.root(new FileSystemStore(c.root)).resolve(c.name),
        )) as zarr.Array<zarr.DataType, FileSystemStore>
        try {
          const r = await zarr.get(arr, c.sel)
          out.push(
            typeof r === 'object' && r !== null && 'shape' in r
              ? { shape: r.shape, values: logicalValues(r) }
              : { scalar: logicalValues({ data: [r], shape: [], stride: [] }) },
          )
        } catch (e) {
          out.push({ error: (e as Error).name })
        }
      }
      return out
    }
    const js = await run('js')
    for (const mode of [
      'main',
      'workers',
      'shared-main',
      'shared-workers',
    ] as const) {
      expect(await run(mode), mode).toStrictEqual(js)
    }
  })

  it('returns SharedArrayBuffer-backed data with sharedOutput', async () => {
    setMode('shared-workers')
    const store = new FileSystemStore(roots[1])
    const arr = await zarr.open.v3(zarr.root(store).resolve('3d.chunked.i2'), {
      kind: 'array',
    })
    const res = await zarr.get(arr)
    expect((res.data as Int16Array).buffer).toBeInstanceOf(SharedArrayBuffer)
    setMode('workers')
    const res2 = await zarr.get(arr)
    expect((res2.data as Int16Array).buffer).toBeInstanceOf(ArrayBuffer)
    // Sharded arrays take the same path (inner chunks written in place).
    setMode('shared-workers')
    const sharded = await zarr.open.v3(
      zarr.root(store).resolve('3d.chunked.compressed.sharded.i2'),
      { kind: 'array' },
    )
    expect(
      ((await zarr.get(sharded)).data as Int16Array).buffer,
    ).toBeInstanceOf(SharedArrayBuffer)
    setMode('workers')
    const res3 = await zarr.get(arr, null, { useSharedArrayBuffer: true })
    expect((res3.data as Int16Array).buffer).toBeInstanceOf(SharedArrayBuffer)
    expect(Array.from(res3.data)).toStrictEqual(Array.from(res2.data))
  })

  it('is really used for compressed arrays', async () => {
    const store = new FileSystemStore(roots[1])
    const arr = await zarr.open.v3(
      zarr.root(store).resolve('1d.contiguous.blosc.i2'),
      {
        kind: 'array',
      },
    )
    // A wasm URL that can't load makes the wasm path fail loudly.
    zarr.configureWasm({
      enabled: true,
      workers: 0,
      wasmUrl: 'file:///nonexistent/zarrita.wasm',
    })
    await expect(zarr.get(arr)).rejects.toThrow()
    zarr.configureWasm({
      wasmUrl: new URL('../src/wasm/zarrita.wasm', import.meta.url),
    })
    await expect(zarr.get(arr)).resolves.toBeDefined()
  })

  it('decodes gzip natively unless the wasm module is already loaded', async () => {
    const store = new FileSystemStore(roots[1])
    const open = (name: string) =>
      zarr.open.v3(zarr.root(store).resolve(name), { kind: 'array' })
    const gzip = await open('1d.contiguous.gzip.i2')
    const blosc = await open('1d.contiguous.blosc.i2')
    const good = new URL('../src/wasm/zarrita.wasm', import.meta.url)
    const bad = 'file:///nonexistent/zarrita.wasm'
    zarr.configureWasm({ enabled: true, workers: 0 })
    try {
      // A wasm URL that can't load shows which path each read takes.
      zarr.configureWasm({ wasmUrl: bad, gzip: 'auto' })
      await expect(zarr.get(gzip)).resolves.toBeDefined() // native: no download
      await expect(zarr.get(blosc)).rejects.toThrow() // needs wasm
      zarr.configureWasm({ wasmUrl: bad, gzip: 'wasm' })
      await expect(zarr.get(gzip)).rejects.toThrow()
      zarr.configureWasm({ wasmUrl: bad, gzip: 'native' })
      await expect(zarr.get(gzip)).resolves.toBeDefined()
      // Once the module is loaded, "auto" reuses it for gzip.
      zarr.configureWasm({ wasmUrl: good, gzip: 'auto' })
      await zarr.get(blosc)
      zarr.configureWasm({ gzip: 'auto' })
      const viaWasm = await zarr.get(gzip)
      zarr.configureWasm({ gzip: 'native' })
      expect(Array.from(viaWasm.data)).toStrictEqual(
        Array.from((await zarr.get(gzip)).data),
      )
    } finally {
      zarr.configureWasm({ wasmUrl: good, gzip: 'auto' })
    }
  })

  it('works where SharedArrayBuffer is undefined (non-isolated pages)', async () => {
    const store = new FileSystemStore(roots[1])
    const arr = await zarr.open.v3(zarr.root(store).resolve('3d.chunked.i2'), {
      kind: 'array',
    })
    setMode('workers')
    const expected = Array.from((await zarr.get(arr)).data as Int16Array)
    const g = globalThis as { SharedArrayBuffer?: unknown }
    const saved = g.SharedArrayBuffer
    delete g.SharedArrayBuffer
    try {
      for (const mode of ['main', 'workers', 'shared-workers'] as const) {
        setMode(mode) // sharedOutput is ignored without SharedArrayBuffer
        expect(
          Array.from((await zarr.get(arr)).data as Int16Array),
          mode,
        ).toStrictEqual(expected)
      }
      expect(new zarr.BoolArray([true, false]).get(0)).toBe(true)
    } finally {
      g.SharedArrayBuffer = saved
    }
  })

  it('reports corrupt chunks as decode errors, without falling back', async () => {
    const fs = await import('node:fs/promises')
    const store = new FileSystemStore(roots[1])
    const corrupting = {
      async get(key: `/${string}`) {
        const bytes = await store.get(key)
        if (!bytes || !key.includes('/c/')) return bytes
        return bytes.slice(0, Math.floor(bytes.length / 2)) // truncated chunk
      },
    }
    void fs
    for (const name of [
      '1d.contiguous.blosc.i2',
      '1d.contiguous.zstd.i2',
      '1d.contiguous.gzip.i2',
    ]) {
      const arr = await zarr.open
        .v3(zarr.root(corrupting).resolve(name), { kind: 'array' })
        .catch(() => null)
      if (!arr) continue // fixture not present in this format
      for (const mode of ['main', 'workers', 'shared-workers'] as const) {
        setMode(mode)
        const err = await zarr.get(arr).then(
          () => null,
          (e: unknown) => e as Error,
        )
        expect(err, `${name} ${mode}`).toBeInstanceOf(zarr.CodecPipelineError)
        expect(String(err?.cause ?? err), `${name} ${mode}`).toMatch(
          /corrupt chunk data/,
        )
      }
    }
  })

  it('decodes chunks handed over as views into larger buffers', async () => {
    // Range coalescing and sharding return subarrays of a bigger buffer.
    // Workers must get exactly the view's bytes, and the caller's buffer
    // must not be detached by the transfer.
    const store = new FileSystemStore(roots[1])
    const views: Uint8Array[] = []
    const viewing = {
      async get(key: `/${string}`) {
        const bytes = await store.get(key)
        if (!bytes || !key.includes('/c/')) return bytes
        const big = new Uint8Array(bytes.length + 64).fill(0xab) // garbage around it
        big.set(bytes, 32)
        // A Node Buffer view: its .slice() is a view too, unlike Uint8Array's.
        const view = Buffer.from(big.buffer, 32, bytes.length)
        views.push(view)
        return view
      },
    }
    for (const name of [
      '3d.chunked.i2',
      '1d.contiguous.blosc.i2',
      '1d.contiguous.gzip.i2',
      '3d.chunked.mixed.i2.F',
    ]) {
      setMode('js')
      const plain = await zarr.open.v3(zarr.root(store).resolve(name), {
        kind: 'array',
      })
      const expected = logicalValues(await zarr.get(plain))
      for (const mode of ['main', 'workers', 'shared-workers'] as const) {
        setMode(mode)
        const arr = await zarr.open.v3(zarr.root(viewing).resolve(name), {
          kind: 'array',
        })
        expect(
          logicalValues(await zarr.get(arr)),
          `${name} ${mode}`,
        ).toStrictEqual(expected)
      }
    }
    expect(views.length).toBeGreaterThan(0)
    for (const v of views) expect(v.buffer.byteLength).toBeGreaterThan(0) // not detached
  })

  it('leaves codecs overridden in the registry to zarrita.js', async () => {
    const store = new FileSystemStore(roots[1])
    const arr = await zarr.open.v3(
      zarr.root(store).resolve('1d.contiguous.gzip.i2'),
      {
        kind: 'array',
      },
    )
    const original = zarr.registry.get('gzip')
    if (!original) throw new Error('gzip codec missing from registry')
    let calls = 0
    zarr.registry.set('gzip', async () => {
      const Codec = await original()
      return {
        ...Codec,
        fromConfig(
          config: unknown,
          meta: Parameters<typeof Codec.fromConfig>[1],
        ) {
          const codec = Codec.fromConfig(config, meta) as {
            decode(b: Uint8Array): Promise<Uint8Array>
          }
          return Object.assign(
            Object.create(Object.getPrototypeOf(codec)),
            codec,
            {
              kind: 'bytes_to_bytes',
              decode: (b: Uint8Array) => {
                calls++
                return codec.decode(b)
              },
            },
          )
        },
      }
    })
    try {
      zarr.configureWasm({ enabled: true, workers: 0 })
      const reopened = await zarr.open.v3(arr, { kind: 'array' })
      await zarr.get(reopened)
      expect(calls).toBeGreaterThan(0)
    } finally {
      zarr.registry.set('gzip', original)
    }
  })
})
