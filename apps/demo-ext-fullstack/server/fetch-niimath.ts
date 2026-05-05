/**
 * Download the niimath binary for the host platform from the latest GitHub release.
 *
 * Usage:
 *   bun server/fetch-niimath.ts            # latest release
 *   bun server/fetch-niimath.ts v1.0.20250804  # specific tag
 *
 * Writes to apps/demo-ext-fullstack/server/bin/niimath{,.exe}.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'rordenlab/niimath'

type Asset = { name: string; browser_download_url: string }
type Release = { tag_name: string; assets: Asset[] }

const __dirname = dirname(fileURLToPath(import.meta.url))
const binDir = resolve(__dirname, 'bin')

function pickAssetName(): string {
  switch (process.platform) {
    case 'darwin':
      return 'niimath_macos.zip'
    case 'linux':
      return 'niimath_lnx.zip'
    case 'win32':
      return 'niimath_win.zip'
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}

function binaryName(): string {
  return process.platform === 'win32' ? 'niimath.exe' : 'niimath'
}

async function fetchRelease(tag: string | undefined): Promise<Release> {
  const url = tag
    ? `https://api.github.com/repos/${REPO}/releases/tags/${tag}`
    : `https://api.github.com/repos/${REPO}/releases/latest`
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`)
  }
  return res.json() as Promise<Release>
}

async function unzipTo(zipPath: string, destDir: string): Promise<void> {
  // macOS/Linux ship `unzip`; Windows ships `tar` (with libarchive) which
  // can extract zips. Pick whichever is present.
  const cmd =
    process.platform === 'win32'
      ? { bin: 'tar', args: ['-xf', zipPath, '-C', destDir] }
      : { bin: 'unzip', args: ['-o', zipPath, '-d', destDir] }
  await new Promise<void>((resolveP, rejectP) => {
    const child = spawn(cmd.bin, cmd.args, { stdio: 'inherit' })
    child.on('error', rejectP)
    child.on('exit', (code) => {
      if (code === 0) resolveP()
      else rejectP(new Error(`${cmd.bin} exited with ${code}`))
    })
  })
}

async function main(): Promise<void> {
  const tag = process.argv[2]
  const release = await fetchRelease(tag)
  const wantedName = pickAssetName()
  const asset = release.assets.find((a) => a.name === wantedName)
  if (!asset) {
    throw new Error(
      `Asset ${wantedName} not found in release ${release.tag_name}`,
    )
  }

  mkdirSync(binDir, { recursive: true })
  const zipPath = join(binDir, asset.name)
  console.log(`Downloading ${asset.name} from ${release.tag_name}...`)
  const dl = await fetch(asset.browser_download_url)
  if (!dl.ok) throw new Error(`Download failed: ${dl.status}`)
  await Bun.write(zipPath, dl)

  console.log(`Extracting to ${binDir}...`)
  await unzipTo(zipPath, binDir)
  unlinkSync(zipPath)

  const binPath = join(binDir, binaryName())
  if (!existsSync(binPath)) {
    throw new Error(`Expected ${binPath} after extraction, not found`)
  }
  if (process.platform !== 'win32') {
    // chmod +x — extracted files from `unzip` should already preserve
    // permissions, but be defensive.
    const { chmodSync } = await import('node:fs')
    chmodSync(binPath, 0o755)
  }
  console.log(`Installed ${binPath}`)

  // Drop a tiny manifest so the server can show what it has.
  const manifest = {
    tag: release.tag_name,
    asset: asset.name,
    platform: process.platform,
    installedAt: new Date().toISOString(),
  }
  await Bun.write(
    join(binDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  )
}

// If invoked as a script (not imported), run main().
if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

export function niimathBinaryPath(): string {
  return join(binDir, binaryName())
}

export function niimathManifest(): { tag: string; installedAt: string } | null {
  const path = join(binDir, 'manifest.json')
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}
