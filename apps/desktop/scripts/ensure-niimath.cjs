const fs = require('fs')
const path = require('path')
const https = require('https')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const binariesDir = path.join(root, 'src-tauri', 'binaries')
const force = process.argv.includes('--force') || process.env.NIIMATH_FORCE === '1'

const targets = {
  'darwin-arm64': {
    triple: 'aarch64-apple-darwin',
    zip: 'niimath_macos.zip',
    exe: 'niimath'
  },
  'darwin-x64': {
    triple: 'x86_64-apple-darwin',
    zip: 'niimath_macos.zip',
    exe: 'niimath'
  },
  'linux-x64': {
    triple: 'x86_64-unknown-linux-gnu',
    zip: 'niimath_lnx.zip',
    exe: 'niimath'
  },
  'linux-arm64': {
    triple: 'aarch64-unknown-linux-gnu',
    zip: 'niimath_lnx.zip',
    exe: 'niimath'
  },
  'win32-x64': {
    triple: 'x86_64-pc-windows-msvc',
    zip: 'niimath_win.zip',
    exe: 'niimath.exe'
  },
  'win32-arm64': {
    triple: 'aarch64-pc-windows-msvc',
    zip: 'niimath_win.zip',
    exe: 'niimath.exe'
  }
}

const target = targets[`${process.platform}-${process.arch}`]

if (!target) {
  console.log(`No niimath binary mapping for ${process.platform}-${process.arch}; skipping.`)
  process.exit(0)
}

fs.mkdirSync(binariesDir, { recursive: true })

const executableName = process.platform === 'win32' ? `niimath-${target.triple}.exe` : `niimath-${target.triple}`
const executablePath = path.join(binariesDir, executableName)
const metadataPath = path.join(binariesDir, `niimath-${target.triple}.json`)

if (!force && fs.existsSync(executablePath)) {
  console.log(`niimath sidecar already present at ${executablePath}`)
  process.exit(0)
}

function request(url, headers = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url)
    const req = https.get(
      requestUrl,
      {
        headers: {
          'User-Agent': 'neurovue-ensure-niimath',
          ...headers
        }
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (redirects <= 0) {
            reject(new Error(`Too many redirects while fetching ${url}`))
            return
          }
          resolve(request(new URL(res.headers.location, requestUrl).toString(), headers, redirects - 1))
          return
        }

        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`Request failed with status ${res.statusCode} for ${url}`))
          return
        }

        resolve(res)
      }
    )

    req.on('error', reject)
  })
}

async function getLatestTag() {
  if (process.env.NIIMATH_RELEASE_TAG) return process.env.NIIMATH_RELEASE_TAG

  const res = await request('https://api.github.com/repos/rordenlab/niimath/releases/latest', {
    Accept: 'application/vnd.github.v3+json'
  })

  let body = ''
  for await (const chunk of res) body += chunk

  const payload = JSON.parse(body)
  if (!payload.tag_name) throw new Error('Latest niimath release did not include tag_name.')
  return payload.tag_name
}

async function download(url, destination) {
  const res = await request(url)
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination)
    res.pipe(file)
    file.on('finish', resolve)
    file.on('error', reject)
    res.on('error', reject)
  })
}

function extractZip(zipPath, extractDir) {
  fs.rmSync(extractDir, { force: true, recursive: true })
  fs.mkdirSync(extractDir, { recursive: true })

  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${escapePowerShell(zipPath)}' -DestinationPath '${escapePowerShell(extractDir)}' -Force`
      ],
      { stdio: 'inherit' }
    )
    if (result.status !== 0) throw new Error('PowerShell Expand-Archive failed.')
    return
  }

  const result = spawnSync('unzip', ['-oq', zipPath, '-d', extractDir], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('unzip failed. Install unzip or provide src-tauri/binaries manually.')
}

function escapePowerShell(value) {
  return value.replace(/'/g, "''")
}

function findExecutable(dir, exe) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })

  for (const entry of entries) {
    const candidate = path.join(dir, entry.name)
    if (entry.isFile() && entry.name === exe) return candidate
    if (entry.isDirectory()) {
      const nested = findExecutable(candidate, exe)
      if (nested) return nested
    }
  }

  return null
}

async function main() {
  const tag = await getLatestTag()
  const zipPath = path.join(binariesDir, target.zip)
  const extractDir = path.join(binariesDir, `.niimath-${target.triple}`)
  const downloadUrl = `https://github.com/rordenlab/niimath/releases/download/${tag}/${target.zip}`

  console.log(`Downloading niimath ${tag} for ${target.triple}`)
  await download(downloadUrl, zipPath)
  extractZip(zipPath, extractDir)

  const extractedExecutable = findExecutable(extractDir, target.exe)
  if (!extractedExecutable) throw new Error(`Could not find ${target.exe} in ${target.zip}.`)

  fs.copyFileSync(extractedExecutable, executablePath)
  if (process.platform !== 'win32') fs.chmodSync(executablePath, 0o755)

  fs.writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        tool: 'niimath',
        release: tag,
        target: target.triple,
        asset: target.zip,
        source: downloadUrl,
        stagedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  )

  fs.rmSync(zipPath, { force: true })
  fs.rmSync(extractDir, { force: true, recursive: true })
  console.log(`niimath sidecar ready at ${executablePath}`)
}

main().catch((error) => {
  console.error(`Failed to prepare niimath: ${error.message}`)
  process.exit(1)
})
