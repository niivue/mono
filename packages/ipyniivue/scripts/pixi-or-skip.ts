// Run a command under `pixi run -e <env>` (default `dev`; pass `-e <env>`
// first to pick another) when pixi is on PATH; otherwise skip it with a notice
// and succeed (exit 0). Cross-platform (Bun) replacement for the former sh
// wrapper so `nx run-many` doesn't fail on Windows / POSIX-shell-less setups
// for TypeScript-only contributors.
//
// Why: ipyniivue is the only Python project, and its lint/typecheck/test/build/
// smoke targets wrap Python tools (ruff/mypy/pytest/hatchling/jupyter) in pixi.
// CI installs pixi via setup-pixi, so the Python checks still run and enforce
// there — this skip only triggers when pixi is absent.
const argv = Bun.argv.slice(2)
const [env, args] = argv[0] === '-e' ? [argv[1], argv.slice(2)] : ['dev', argv]

if (Bun.which('pixi')) {
  const proc = Bun.spawnSync(['pixi', 'run', '-e', env, ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  process.exit(proc.exitCode)
}
console.log(`ipyniivue: pixi not found on PATH; skipping: ${args.join(' ')}`)
