// Entry point for the IIIF Volumetric Server.
//
// Serves:
//   - IIIF Image API 3.0 endpoints for 2D slices through a volume
//     /iiif/image/{id}/{axis}/{slice}/info.json
//     /iiif/image/{id}/{axis}/{slice}/{region}/{size}/{rotation}/{quality}.{format}
//   - IIIF Presentation API 4.0 alpha (draft 3D) manifests
//     /iiif/presentation/{id}/manifest
//   - Raw volume bytes (for clients that want to render the volume client-side)
//     /volumes/{id}/raw

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import cors from 'cors'
import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
} from 'express'
import morgan from 'morgan'

import { registry } from './registry.ts'
import { mountDesktopRoutes } from './routes/desktopRoutes.ts'
import { mountImageApi } from './routes/imageApi.ts'
import { mountPresentationApi } from './routes/presentationApi.ts'
import { mountVolumeRoutes } from './routes/volumeRoutes.ts'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT) || 8080
const HOST = process.env.HOST || '127.0.0.1'
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://${HOST}:${PORT}`
const FIXTURES_DIR =
  process.env.FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures')

interface NiivuegpuPackage {
  name: string
  root: string | null
  mounted: boolean
}

interface NiivuegpuDeps {
  nodeModules: string | null
  packages: NiivuegpuPackage[]
  mounted: boolean
}

const NIIVUEGPU_DIST = resolveNiivuegpuDist()
const NIIVUEGPU_DEPS = resolveNiivuegpuDeps(NIIVUEGPU_DIST)

function resolveNiivuegpuDist(): string | null {
  const candidates = [
    process.env.NIIVUEGPU_DIST,
    path.resolve(__dirname, '..', 'niivuegpu', 'dist'),
    path.resolve(__dirname, '..', '..', 'niivuegpu', 'dist'),
    path.resolve(process.env.HOME || '', 'Dev', 'niivuegpu', 'dist'),
  ].filter((p): p is string => Boolean(p))
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c
    } catch (_) {
      /* not present */
    }
  }
  return null
}

function resolveNiivuegpuDeps(distDir: string | null): NiivuegpuDeps {
  const packageNames = [
    'gl-matrix',
    'cbor-x',
    'nifti-reader-js',
    'fflate',
    'earcut',
    'clipper2-ts',
  ]
  const nodeModules =
    process.env.NIIVUEGPU_NODE_MODULES ||
    (distDir ? path.resolve(distDir, '..', 'node_modules') : null)
  const packages: NiivuegpuPackage[] = packageNames.map((name) => {
    const root = nodeModules ? path.join(nodeModules, name) : null
    let mounted = false
    if (root) {
      try {
        mounted = fs.statSync(root).isDirectory()
      } catch (_) {
        mounted = false
      }
    }
    return { name, root, mounted }
  })
  return {
    nodeModules,
    packages,
    mounted: packages.every((pkg) => pkg.mounted),
  }
}

async function main(): Promise<void> {
  await registry.scan(FIXTURES_DIR)
  console.log(
    `Loaded ${registry.size()} volume(s) from ${FIXTURES_DIR}:\n` +
      registry
        .list()
        .map(
          (v) =>
            `  - ${v.id} (${v.format}, ${v.shape.join('x')}, dtype=${v.dtype})`,
        )
        .join('\n'),
  )

  const app = express()
  app.locals.publicBaseUrl = PUBLIC_BASE_URL

  app.use(cors())
  app.use(morgan('tiny'))
  app.use(express.static(path.resolve(__dirname, '..', 'public')))

  if (NIIVUEGPU_DIST) {
    console.log(`Mounting niivuegpu dist from ${NIIVUEGPU_DIST}`)
    app.use(
      '/vendor/niivuegpu',
      express.static(NIIVUEGPU_DIST, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.js')) {
            res.set('Content-Type', 'text/javascript')
          }
          if (filePath.endsWith('.wasm')) {
            res.set('Content-Type', 'application/wasm')
          }
        },
      }),
    )
    app.locals.niivuegpuMounted = true
  } else {
    console.warn(
      'niivuegpu dist not found. Set NIIVUEGPU_DIST or place a built dist/ next to the server. The 3D viewer page will show a setup message until it is available.',
    )
    app.locals.niivuegpuMounted = false
  }

  if (NIIVUEGPU_DEPS.nodeModules) {
    for (const pkg of NIIVUEGPU_DEPS.packages) {
      if (!pkg.mounted || !pkg.root) continue
      app.use(
        `/vendor/niivuegpu-deps/${pkg.name}`,
        express.static(pkg.root, {
          setHeaders: (res, filePath) => {
            if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
              res.set('Content-Type', 'text/javascript')
            }
          },
        }),
      )
    }
    if (NIIVUEGPU_DEPS.mounted) {
      console.log(
        `Mounting niivuegpu browser deps from ${NIIVUEGPU_DEPS.nodeModules}`,
      )
    } else {
      const missing = NIIVUEGPU_DEPS.packages
        .filter((pkg) => !pkg.mounted)
        .map((pkg) => pkg.name)
        .join(', ')
      console.warn(
        `niivuegpu browser deps incomplete under ${NIIVUEGPU_DEPS.nodeModules}: ${missing}`,
      )
    }
  }

  app.get('/api', (_req: Request, res: Response) => {
    res.json({
      service: 'iiif-volumetric-server',
      version: '0.1.0',
      spec: {
        imageApi: 'https://iiif.io/api/image/3.0/',
        presentationApi:
          'https://preview.iiif.io/api/prezi-4/presentation/4.0/ (alpha, includes draft 3D)',
      },
      niivuegpu: {
        mounted: app.locals.niivuegpuMounted,
        dist: NIIVUEGPU_DIST,
        depsMounted: NIIVUEGPU_DEPS.mounted,
        nodeModules: NIIVUEGPU_DEPS.nodeModules,
        deps: NIIVUEGPU_DEPS.packages.map((pkg) => ({
          name: pkg.name,
          mounted: pkg.mounted,
          path: pkg.root,
        })),
      },
      desktop: `${PUBLIC_BASE_URL}/iiif/desktop/neuro/manifest`,
      volumes: registry.list().map((v) => ({
        id: v.id,
        format: v.format,
        shape: v.shape,
        dtype: v.dtype,
        levels: v.levels,
        manifest: `${PUBLIC_BASE_URL}/iiif/presentation/${v.id}/manifest`,
        raw: `${PUBLIC_BASE_URL}/volumes/${v.id}/raw`,
        slices: {
          axial: `${PUBLIC_BASE_URL}/iiif/image/${v.id}/axial/${Math.floor(v.shape[2] / 2)}/info.json`,
          coronal: `${PUBLIC_BASE_URL}/iiif/image/${v.id}/coronal/${Math.floor(v.shape[1] / 2)}/info.json`,
          sagittal: `${PUBLIC_BASE_URL}/iiif/image/${v.id}/sagittal/${Math.floor(v.shape[0] / 2)}/info.json`,
        },
      })),
    })
  })

  mountImageApi(app, registry)
  mountPresentationApi(app, registry)
  mountDesktopRoutes(app, registry)
  mountVolumeRoutes(app, registry)

  app.post(
    '/dev/save-screenshot',
    express.raw({ type: 'image/png', limit: '20mb' }),
    async (req: Request, res: Response) => {
      try {
        const { default: fsPromises } = await import('node:fs/promises')
        const dir = path.resolve(__dirname, '..', 'fixtures', 'screenshots')
        await fsPromises.mkdir(dir, { recursive: true })
        const name = `screenshot-${Date.now()}.png`
        const full = path.join(dir, name)
        await fsPromises.writeFile(full, req.body as Buffer)
        res.json({ path: full, bytes: (req.body as Buffer).length })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        res.status(500).json({ error: message })
      }
    },
  )

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error(err)
    const status =
      err && typeof err === 'object' && 'status' in err
        ? Number((err as { status?: unknown }).status) || 500
        : 500
    const message =
      err instanceof Error
        ? err.message
        : String(err) || 'Internal Server Error'
    res.status(status).json({ error: message })
  }
  app.use(errorHandler)

  app.listen(PORT, HOST, () => {
    console.log(`IIIF volumetric server listening at ${PUBLIC_BASE_URL}`)
  })
}

main().catch((err) => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
