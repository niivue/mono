/**
 * Packed-consumer smoke test for @niivue/niivue.
 *
 * Packs the current dist, installs it into a throwaway Vite project, runs
 * `vite optimize --force` to trigger dependency pre-bundling, and asserts
 * that no `import.meta.url` asset references leak into the pre-bundled
 * chunks. That pattern breaks at runtime because Vite relocates the JS into
 * `node_modules/.vite/deps/` without copying the referenced asset files.
 *
 * This test exists because workspace:* symlinked packages skip Vite's
 * optimizeDeps step, so in-repo dev and test flows cannot reproduce the
 * regression that hit external consumers in v1.0.0-rc.1. See
 * https://github.com/niivue/mono/issues/10.
 *
 * Run with: bun run scripts/smoke-test-packed.ts
 * Requires network access (installs vite into a temp directory).
 */
import { execSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NIIVUE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'niivue-smoke-'))
let keepTmp = false

function log(msg: string) {
  console.log(`[smoke] ${msg}`)
}

function run(cmd: string, cwd: string) {
  execSync(cmd, { cwd, stdio: 'inherit' })
}

function fail(msg: string): never {
  keepTmp = true
  console.error(`[smoke] FAIL: ${msg}`)
  console.error(`[smoke] tmp dir kept for inspection: ${tmp}`)
  process.exit(1)
}

try {
  log(`working directory: ${tmp}`)

  // 1. Pack the current @niivue/niivue build into the tmp dir.
  // `bun pm pack --quiet` prints the absolute path of the resulting tarball.
  log('packing @niivue/niivue')
  const packOutput = execSync(
    `bun pm pack --quiet --destination ${JSON.stringify(tmp)}`,
    { cwd: NIIVUE_ROOT, encoding: 'utf8' },
  )
  const tgzPath = packOutput.trim().split(/\r?\n/).pop()
  if (!tgzPath) fail('bun pm pack produced no output')

  // 2. Scaffold a minimal Vite consumer. Copy the tarball into the consumer
  // directory so we can reference it with a relative `file:` specifier;
  // bun interprets `file:` paths relative to the package.json location.
  const consumer = join(tmp, 'consumer')
  mkdirSync(consumer)
  const localTgz = `niivue.tgz`
  copyFileSync(tgzPath, join(consumer, localTgz))

  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify(
      {
        name: 'niivue-smoke-consumer',
        private: true,
        type: 'module',
        dependencies: {
          '@niivue/niivue': `file:./${localTgz}`,
        },
        devDependencies: {
          vite: '^7.0.0',
        },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    join(consumer, 'vite.config.js'),
    "import { defineConfig } from 'vite'\nexport default defineConfig({})\n",
  )
  writeFileSync(
    join(consumer, 'index.html'),
    '<!DOCTYPE html><html><body><script type="module" src="/main.js"></script></body></html>\n',
  )
  // Import the font atlas entry: that pulls in the shared chunk that
  // previously held `new URL('assets/Ubuntu.png', import.meta.url)`.
  writeFileSync(
    join(consumer, 'main.js'),
    "import { ubuntu } from '@niivue/niivue/assets/fonts'\nconsole.log(ubuntu.atlasUrl.slice(0, 32))\n",
  )

  // 3. Install.
  log('installing vite and packed niivue tarball')
  run('bun install --no-save', consumer)

  // 4. Force Vite's optimizeDeps pre-bundling.
  log('running vite optimize --force')
  run('bunx vite optimize --force', consumer)

  // 5. Inspect .vite/deps/ for the regression signature.
  const depsDir = join(consumer, 'node_modules', '.vite', 'deps')
  const depsFiles = readdirSync(depsDir).filter((f) => f.endsWith('.js'))
  if (depsFiles.length === 0) fail('no pre-bundled files found in .vite/deps/')

  const offenders: string[] = []
  let sawFontDataUrl = false
  const assetUrlPattern =
    /new URL\(\s*["'][^"']+\.(png|jpe?g)["']\s*,\s*import\.meta\.url\s*\)/i
  for (const file of depsFiles) {
    const content = readFileSync(join(depsDir, file), 'utf8')
    if (assetUrlPattern.test(content)) offenders.push(file)
    // PNG magic bytes base64-encoded always start with "iVBOR".
    if (content.includes('data:image/png;base64,iVBOR')) sawFontDataUrl = true
  }

  if (offenders.length > 0) {
    fail(
      `found new URL(..., import.meta.url) asset references in pre-bundled deps: ${offenders.join(', ')}`,
    )
  }
  if (!sawFontDataUrl) {
    fail(
      'did not find inlined Ubuntu font atlas data URL in any pre-bundled dep file',
    )
  }

  log('PASS: no import.meta.url asset references in pre-bundled deps')
  log('PASS: Ubuntu font atlas present as data URL')
} finally {
  if (!keepTmp) {
    rmSync(tmp, { recursive: true, force: true })
  }
}
