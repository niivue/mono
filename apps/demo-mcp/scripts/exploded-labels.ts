/**
 * An animation made through the MCP tools alone: the loaded volume tiled
 * into bricks and spread apart in the render view, turning a full circle,
 * while atlas regions are labelled one at a time with a line to each
 * region's centroid. Every frame is a `screenshot` of the page, so what the
 * film shows is what an agent driving the same tools would see.
 *
 * Each label outlines the brick holding its region and fades the other
 * bricks, and the volume is drawn with the gradient-lit silhouette shader.
 *
 * Run the demo (`bunx nx dev demo-mcp`), bring the page's tab to the front
 * (a background tab is given no animation frames), then:
 *
 *   bunx nx run demo-mcp:exploded-labels
 *   bun scripts/exploded-labels.ts --frames 240 --regions Insula_L,Thalamus_R
 *   bun scripts/exploded-labels.ts --tab 3bd9771f   # when several tabs are open
 *
 * Frames land in `out/exploded-labels/` as PNGs, and ffmpeg, when it is on
 * the PATH, joins them into `exploded-labels.mp4` beside them.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

interface Options {
  url: string
  out: string
  frames: number
  fps: number
  width: number
  grid: number
  spread: number
  elevation: number
  regions: string[]
  /** Opacity of the bricks holding no label. */
  dim: number
  restore: boolean
  tab?: string
}

/** Regions spread over the brain, so the labels visit every brick. */
const DEFAULT_REGIONS = [
  'Precentral_L',
  'Hippocampus_R',
  'Insula_L',
  'Thalamus_R',
  'Occipital_Sup_L',
  'Cerebelum_Crus1_R',
  'Caudate_L',
  'Temporal_Sup_R',
]

function options(argv: string[]): Options {
  const opts: Options = {
    url: process.env.NV_MCP_URL ?? 'http://127.0.0.1:4242/mcp',
    out: join('out', 'exploded-labels'),
    frames: 240,
    fps: 30,
    width: 1024,
    grid: 3,
    spread: 1.6,
    elevation: 15,
    regions: DEFAULT_REGIONS,
    dim: 0.25,
    restore: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    const num = () => {
      const n = Number(value)
      if (!Number.isFinite(n)) throw new Error(`${flag} needs a number`)
      i++
      return n
    }
    switch (flag) {
      case '--url':
        opts.url = value
        i++
        break
      case '--out':
        opts.out = value
        i++
        break
      case '--frames':
        opts.frames = num()
        break
      case '--fps':
        opts.fps = num()
        break
      case '--width':
        opts.width = num()
        break
      case '--grid':
        opts.grid = num()
        break
      case '--spread':
        opts.spread = num()
        break
      case '--elevation':
        opts.elevation = num()
        break
      case '--regions':
        opts.regions = value
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
        i++
        break
      case '--dim':
        opts.dim = num()
        break
      case '--keep':
        opts.restore = false
        break
      case '--tab':
        opts.tab = argv[i + 1]
        i++
        break
      default:
        throw new Error(`Unknown option ${flag}`)
    }
  }
  return opts
}

type Content = { type: string; text?: string; data?: string }

/** The tab every call goes to, when one was named. */
let tabArg: Record<string, string> = {}

/** Calls a tool and returns its content, failing on a refusal. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Content[]> {
  const result = await client.callTool({
    name,
    arguments: { ...tabArg, ...args },
  })
  const content = result.content as Content[]
  if (result.isError) {
    throw new Error(`${name} refused: ${content[0]?.text ?? 'no reason'}`)
  }
  return content
}

/** Eases 0..1 in and out, for the spread to open without a jolt. */
function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

async function main(): Promise<void> {
  const opts = options(process.argv.slice(2))
  if (opts.regions.length === 0) throw new Error('No regions to label.')
  if (opts.tab) tabArg = { tab: opts.tab }
  await mkdir(opts.out, { recursive: true })

  const client = new Client({ name: 'exploded-labels', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(opts.url)))

  const where = await call(client, 'where_am_i')
  console.log(where[0]?.text?.split('\n')[0])

  await call(client, 'set_view', { slice: 'render' })
  await call(client, 'set_camera', { azimuth: 0, elevation: opts.elevation })
  // The gradient shader: each surface lit by its gradient through the matcap,
  // with the faces seen edge-on thinned to a rim. Gradient opacity stays at
  // zero: it fades every voxel by its gradient's size, which empties a brick
  // of the smooth tissue that makes it read as a solid block.
  await call(client, 'set_options', {
    options: {
      volumeIllumination: 0.7,
      volumeGradientOpacity: 0,
      volumeSilhouette: 0.3,
      crosshairWidth: 0,
    },
  })
  await call(client, 'set_volume', {
    chunk_grid: [opts.grid, opts.grid, opts.grid],
    spread: 1,
  })

  // The spread opens over the first fifth of the film and stays open.
  const opening = Math.max(1, Math.floor(opts.frames / 5))
  const perRegion = opts.frames / opts.regions.length
  let spreadShown = 1
  let regionShown = -1
  const digits = `${opts.frames}`.length
  for (let i = 0; i < opts.frames; i++) {
    const spread = 1 + (opts.spread - 1) * smooth(Math.min(1, i / opening))
    if (Math.abs(spread - spreadShown) > 1e-3) {
      await call(client, 'set_volume', { spread })
      spreadShown = spread
    }
    const region = Math.min(opts.regions.length - 1, Math.floor(i / perRegion))
    if (region !== regionShown) {
      const drawn = await call(client, 'set_labels', {
        labels: [{ region: opts.regions[region] }],
        dim_others: opts.dim,
      })
      console.log(drawn[0]?.text?.split('\n')[0], opts.regions[region])
      regionShown = region
    }
    await call(client, 'set_camera', {
      azimuth: (360 * i) / opts.frames,
      elevation: opts.elevation,
    })
    const shot = await call(client, 'screenshot', { max_width: opts.width })
    const image = shot.find((c) => c.type === 'image')
    if (!image?.data) throw new Error('screenshot returned no image')
    const name = `frame-${`${i}`.padStart(digits, '0')}.png`
    await writeFile(join(opts.out, name), Buffer.from(image.data, 'base64'))
    if (i % 10 === 0) console.log(`frame ${i + 1} of ${opts.frames}`)
  }

  if (opts.restore) {
    await call(client, 'set_labels', { clear: true })
    await call(client, 'set_volume', { chunk_grid: null })
    await call(client, 'set_options', {
      options: {
        volumeIllumination: 0,
        volumeGradientOpacity: 0,
        volumeSilhouette: 0,
        crosshairWidth: 2,
      },
    })
  }
  await client.close()

  const film = join(opts.out, 'exploded-labels.mp4')
  const ffmpeg = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-framerate',
      `${opts.fps}`,
      '-i',
      join(opts.out, `frame-%0${digits}d.png`),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      film,
    ],
    { stdio: 'inherit' },
  )
  if (ffmpeg.error) {
    console.log(
      `ffmpeg not found; the frames are in ${opts.out}. Join them with:\n` +
        `  ffmpeg -framerate ${opts.fps} -i ${join(opts.out, `frame-%0${digits}d.png`)} -c:v libx264 -pix_fmt yuv420p ${film}`,
    )
  } else if (ffmpeg.status !== 0) {
    throw new Error(`ffmpeg exited with ${ffmpeg.status}`)
  } else {
    console.log(`Wrote ${film}`)
  }
}

await main()
