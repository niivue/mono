// Run a command under `pixi run -e dev` when pixi is on PATH; otherwise skip it
// with a notice and succeed (exit 0). Cross-platform (Bun) replacement for the
// former sh wrapper so `nx run-many` doesn't fail on Windows / POSIX-shell-less
// setups for TypeScript-only contributors.
//
// Why: ipyniivue is the only Python project, and its lint/typecheck/test/build/
// smoke targets wrap Python tools (ruff/mypy/pytest/hatchling) in pixi. CI
// installs pixi via setup-pixi, so the Python checks still run and enforce
// there — this skip only triggers when pixi is absent.
const args = Bun.argv.slice(2)

if (Bun.which('pixi')) {
  const proc = Bun.spawnSync(['pixi', 'run', '-e', 'dev', ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  process.exit(proc.exitCode)
}
console.log(`ipyniivue: pixi not found on PATH; skipping: ${args.join(' ')}`)
