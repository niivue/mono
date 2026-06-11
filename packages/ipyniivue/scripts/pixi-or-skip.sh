#!/usr/bin/env sh
# Run a command under `pixi run -e dev` when pixi is on PATH; otherwise skip it
# with a notice and succeed (exit 0).
#
# Why: ipyniivue is the only Python project, and its lint/typecheck/test/build/
# smoke targets wrap Python tools (ruff/mypy/pytest/hatchling) in pixi. A
# TypeScript-only contributor without pixi would otherwise see `nx run-many`
# hard-fail on ipyniivue with `pixi: command not found`, masking the real result
# of the TS projects. CI installs pixi via setup-pixi, so there the Python checks
# still run and enforce normally — this skip only triggers when pixi is absent.
if command -v pixi >/dev/null 2>&1; then
  exec pixi run -e dev "$@"
fi
echo "ipyniivue: pixi not found on PATH; skipping: $*"
exit 0
