# demo-ext-niimath

Demo app for [`@niivue/nv-ext-niimath`](../../packages/nv-ext-niimath) — build a niimath pipeline (`-s 3 -thr 0.5 -bin`, etc.), drag-reorder the steps, and run it entirely in the browser via the niimath WASM build. No backend, no data leaves the page.

Same UI shell as [`demo-ext-fullstack`](../demo-ext-fullstack), but with the server replaced by an in-browser Web Worker — handy if you want to compare the two transports side by side.

## Getting Started

```bash
bun install                       # From monorepo root
bunx nx dev demo-ext-niimath      # Start dev server (port 8089)
```

The dev server proxies the shared `@niivue/dev-images` sample volumes (mni152, FA, spmMotor, etc.), so you can pick a built-in volume from the Image tab without any setup. You can also upload your own NIfTI from disk via the file picker on the same tab.

## Build

```bash
bunx nx build demo-ext-niimath
```

## What's wired up

- **Image tab** — pick a built-in sample volume (loads on selection) or upload your own NIfTI. Save the currently-displayed volume to disk.
- **Processing tab** — pick niimath operators from the catalog, drag-reorder the resulting pipeline cards, edit numeric arguments inline. The generated `niimath` command is shown live above the Run button (click to copy).
- **History tab** — recent runs (capped at 20) with their args, duration, and a Reload-result button.
- **Apply result as input** — by default each Run shows the result as a *preview* without overwriting the working source, so reordering steps re-runs against the same input. Click Apply when you want to chain.

## Part of the [NiiVue](https://github.com/niivue) ecosystem
