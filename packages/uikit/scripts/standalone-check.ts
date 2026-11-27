// Proves @niivue/uikit stands alone: pack it, install it into an empty
// project WITHOUT @niivue/niivue, typecheck code using the root and controls
// entries against the emitted declarations, and import both at runtime.
// Run after `nx build uikit`: bun scripts/standalone-check.ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pkg = join(import.meta.dir, '..')
const dir = mkdtempSync(join(tmpdir(), 'uikit-standalone-'))
const run = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0)
    throw new Error(`${cmd.join(' ')} failed:\n${r.stdout}${r.stderr}`)
  return r.stdout.toString()
}
const tgz = run(['bun', 'pm', 'pack', '--destination', dir, '--quiet'], pkg)
  .trim()
  .split('\n')
  .pop() as string
writeFileSync(join(dir, 'package.json'), '{"type":"module","private":true}')
// The WebGPU types are a peer, as for @niivue/niivue.
run(
  [
    'bun',
    'add',
    join(dir, tgz.replace(/^.*\//, '')),
    'typescript@5',
    '@webgpu/types',
  ],
  dir,
)
writeFileSync(
  join(dir, 'check.ts'),
  `import { buildRuler, UIKitRulerOverlay, type UIKitOverlayFrame } from '@niivue/uikit'
import { UIKitButtonOverlay } from '@niivue/uikit/controls'
const ruler = buildRuler({ a: [0, 0], b: [100, 0], length: 10, units: 'mm', sizePx: 12 })
const draw = (f: UIKitOverlayFrame) => f.dpr
// One string, so a coloured terminal (FORCE_COLOR under Nx) cannot style it.
console.log([ruler.lines.length > 0, typeof UIKitRulerOverlay, typeof UIKitButtonOverlay, typeof draw].join(' '))
`,
)
writeFileSync(
  join(dir, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      noEmit: true,
      types: [],
      lib: ['ESNext', 'DOM'],
    },
    files: ['check.ts'],
  }),
)
run(['bunx', 'tsc', '-p', '.'], dir)
const out = run(['bun', 'check.ts'], dir).trim()
if (out !== 'true function function function') throw new Error(out)
console.log(`uikit stands alone (no @niivue/niivue): ${dir}`)
