# NiiVue Monorepo

Monorepo for the [NiiVue](https://github.com/niivue) ecosystem — browser-based medical image visualization.

## Packages

| Package | Description |
|---|---|
| [`@niivue/niivue`](packages/niivue) | Core WebGPU/WebGL2 medical image viewer |
| [`@niivue/nvreact`](packages/nv-react) | React bindings for NiiVue |
| [`@niivue/nv-ext-drawing`](packages/nv-ext-drawing) | Drawing interpolation and segmentation tools |
| [`@niivue/nv-ext-image-processing`](packages/nv-ext-image-processing) | Image processing (Otsu thresholding, haze removal, etc.) |
| [`@niivue/nv-ext-save-html`](packages/nv-ext-save-html) | Export a NiiVue scene as a self-contained HTML file |
| [`@niivue/dev-images`](packages/dev-images) | Shared test volumes, meshes, and tractography files (Git LFS) |

## Apps

| App | Description |
|---|---|
| [`demo-ext-drawing`](apps/demo-ext-drawing) | Demo app for the drawing extension |
| [`demo-ext-image-processing`](apps/demo-ext-image-processing) | Demo app for the image processing extension |
| [`demo-ext-save-html`](apps/demo-ext-save-html) | Demo app for the save-to-HTML extension |

## Getting Started

```bash
bun install                # Install all dependencies
bunx nx build <project>    # Build a single project (builds deps first)
bunx nx run-many -t build  # Build all projects
bunx nx run-many -t test   # Run all tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed setup, tooling, and development instructions.
