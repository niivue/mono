# demo-ext-dcm2niix

Demo app for [`@niivue/nv-ext-dcm2niix`](../../packages/nv-ext-dcm2niix) — convert a folder of DICOM files to NIfTI in the browser via the dcm2niix WASM build, then view the result with NiiVue. No data leaves the browser.

Three input paths are wired up:

1. **Folder picker** — `<input type="file" webkitdirectory>`.
2. **Drag-and-drop** — drop a folder of DICOMs onto the header.
3. **Demo manifest** — fetches a public DICOM series listed in a newline-delimited manifest, then runs the same conversion pipeline.

## Getting Started

```bash
bun install                       # From monorepo root
bunx nx dev demo-ext-dcm2niix     # Start dev server (port 8086)
```

## Build

```bash
bunx nx build demo-ext-dcm2niix
```

## Part of the [NiiVue](https://github.com/niivue) ecosystem
