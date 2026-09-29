/**
 * An animation made through the MCP tools alone: the loaded volume tiled
 * into bricks and spread apart in the render view. Each atlas region is
 * labelled in turn, and the camera moves only when that label changes. It
 * looks inward through the centroid's nearest tissue face in that brick;
 * surrounding bricks never affect the chosen direction. Every frame is a `screenshot` of
 * the page, so what the film shows is what an agent driving the same tools
 * would see.
 *
 * Each label follows its region's brick while the other bricks fade, and the
 * volume is drawn with the gradient-lit silhouette shader.
 *
 * Run the demo (`bunx nx dev demo-mcp`), bring the page's tab to the front
 * (a background tab is given no animation frames), then:
 *
 *   bunx nx run demo-mcp:exploded-labels
 *   bun scripts/exploded-labels.ts --frames 480 --regions Insula_L,Thalamus_R
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
  'Frontal_Sup_L',
  'Parietal_Inf_R',
  'Putamen_R',
  'Cerebelum_6_L',
]

function options(argv: string[]): Options {
  const opts: Options = {
    url: process.env.NV_MCP_URL ?? 'http://127.0.0.1:4242/mcp',
    out: join('out', 'exploded-labels'),
    // Twenty seconds lets the camera reach each centroid-facing view, then
    // hold long enough for its label to read.
    frames: 480,
    fps: 24,
    width: 1024,
    grid: 3,
    spread: 1.6,
    elevation: 15,
    regions: DEFAULT_REGIONS,
    dim: 0.25,
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

interface DrawnLabel {
  brick?: number
  mm?: [number, number, number]
}

interface LabelsResult {
  labels: DrawnLabel[]
}

interface Camera {
  azimuth: number
  elevation: number
}

interface WhereResult {
  camera?: Camera
}

interface VolumeDetails {
  dims?: number[]
  affine?: number[][]
}

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

/** The JSON body after a tool's short spoken lead. */
function details<T>(content: Content[]): T {
  const text = content.find((item) => item.type === 'text')?.text
  if (!text) throw new Error('Tool response contained no text details.')
  const start = text.indexOf('{')
  if (start < 0) throw new Error('Tool response contained no JSON details.')
  return JSON.parse(text.slice(start)) as T
}

/** The voxel coordinates of a world-mm point, or null for a malformed affine. */
function voxelAt(
  mm: readonly number[],
  affine: number[][],
): [number, number, number] | null {
  if (affine.length < 3 || affine.some((row) => row.length < 4)) return null
  const [[a, b, c, tx], [d, e, f, ty], [g, h, j, tz]] = affine
  if (
    [a, b, c, tx, d, e, f, ty, g, h, j, tz].some(
      (value) => value === undefined || !Number.isFinite(value),
    )
  ) {
    return null
  }
  const determinant =
    a * (e * j - f * h) - b * (d * j - f * g) + c * (d * h - e * g)
  if (Math.abs(determinant) < 1e-10) return null
  const x = mm[0] - tx
  const y = mm[1] - ty
  const z = mm[2] - tz
  return [
    ((e * j - f * h) * x + (c * h - b * j) * y + (b * f - c * e) * z) /
      determinant,
    ((f * g - d * j) * x + (a * j - c * g) * y + (c * d - a * f) * z) /
      determinant,
    ((d * h - e * g) * x + (b * g - a * h) * y + (a * e - b * d) * z) /
      determinant,
  ]
}

/**
 * Looks inward through the centroid's nearest physical tissue face. The
 * decision uses only this ROI's brick bounds, never the location of another
 * brick; a closer face on the back side therefore wins as well.
 */
function cameraForLabel(
  label: DrawnLabel | undefined,
  volume: VolumeDetails,
  grid: number,
  fallbackElevation: number,
): Camera {
  if (!label?.mm || !volume.dims || !volume.affine) {
    return { azimuth: 0, elevation: fallbackElevation }
  }
  const voxel = voxelAt(label.mm, volume.affine)
  if (!voxel || volume.dims.length < 3) {
    return { azimuth: 0, elevation: fallbackElevation }
  }
  let axis = -1
  let direction = 0
  let nearest = Number.POSITIVE_INFINITY
  for (let i = 0; i < 3; i++) {
    const dim = volume.dims[i]
    const scale = Math.hypot(
      volume.affine[0]?.[i] ?? 0,
      volume.affine[1]?.[i] ?? 0,
      volume.affine[2]?.[i] ?? 0,
    )
    if (!Number.isFinite(dim) || dim <= 1 || scale <= 0) continue
    const cellStride = Math.ceil(dim / grid)
    const cell =
      label.brick === undefined
        ? undefined
        : i === 0
          ? label.brick % grid
          : i === 1
            ? Math.floor(label.brick / grid) % grid
            : Math.floor(label.brick / (grid * grid))
    // Labels normally include their chunk. Without it, use the volume's own
    // tissue bounds rather than inferring a direction from any other brick.
    const lowVoxel = cell === undefined ? 0 : cell * cellStride
    const highVoxel =
      cell === undefined ? dim - 1 : Math.min(lowVoxel + cellStride, dim) - 1
    const low = (voxel[i] - lowVoxel) * scale
    const high = (highVoxel - voxel[i]) * scale
    if (low < nearest) {
      axis = i
      direction = 1
      nearest = low
    }
    if (high < nearest) {
      axis = i
      direction = -1
      nearest = high
    }
  }
  if (axis < 0) return { azimuth: 0, elevation: fallbackElevation }
  const view = [0, 0, 0]
  view[axis] = direction
  return {
    azimuth: ((Math.atan2(view[0], view[1]) * 180) / Math.PI + 360) % 360,
    elevation: (-Math.asin(view[2]) * 180) / Math.PI,
  }
}

/** The slow, eased turn from one camera bearing to the next. */
function betweenCameras(from: Camera, to: Camera, t: number): Camera {
  const eased = smooth(t)
  const azimuthDelta = ((to.azimuth - from.azimuth + 540) % 360) - 180
  return {
    azimuth: (from.azimuth + azimuthDelta * eased + 360) % 360,
    elevation: from.elevation + (to.elevation - from.elevation) * eased,
  }
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
  let camera = details<WhereResult>(where).camera ?? {
    azimuth: 0,
    elevation: opts.elevation,
  }
  const volume = details<VolumeDetails>(
    await call(client, 'describe_volume', { affine: true, stats: false }),
  )

  await call(client, 'set_view', { slice: 'render' })
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
  const turnFrames = Math.max(1, Math.floor((perRegion * 2) / 3))
  let spreadShown = 1
  let regionShown = -1
  let turnStarted = -turnFrames
  let turnFrom = camera
  let turnTo = camera
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
      const label = details<LabelsResult>(drawn).labels[0]
      turnFrom = turnTo
      turnTo = cameraForLabel(label, volume, opts.grid, opts.elevation)
      turnStarted = i
      regionShown = region
    }
    const turnFrame = i - turnStarted
    if (turnFrame < turnFrames) {
      camera = betweenCameras(turnFrom, turnTo, (turnFrame + 1) / turnFrames)
      await call(client, 'set_camera', { ...camera })
    }
    const shot = await call(client, 'screenshot', { max_width: opts.width })
    const image = shot.find((c) => c.type === 'image')
    if (!image?.data) throw new Error('screenshot returned no image')
    const name = `frame-${`${i}`.padStart(digits, '0')}.png`
    await writeFile(join(opts.out, name), Buffer.from(image.data, 'base64'))
    if (i % 10 === 0) console.log(`frame ${i + 1} of ${opts.frames}`)
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
