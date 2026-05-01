## 1.0.0-rc.4 (2026-05-01)

### Features

- extract NiiVue <-> WKWebView bridge into reusable packages ([4a929a1](https://github.com/niivue/mono/commit/4a929a1))
- **nv-ext-dcm2niix:** add DICOM-to-NIfTI extension and demo ([04a3898](https://github.com/niivue/mono/commit/04a3898))

### Fixes

- **niivue:** extend default drawing colormap to 8 colors ([#8](https://github.com/niivue/mono/issues/8))
- **niivue:** tolerate VTK files missing the title line ([c4d9b49](https://github.com/niivue/mono/commit/c4d9b49))
- **ipyniivue:** suppress JupyterLab cell context menu on canvas right-click ([a58bd8c](https://github.com/niivue/mono/commit/a58bd8c))

### Thank You

- Claude Opus 4.7 (1M context)
- neurolabusc
- Taylor Hanayik @hanayik

## 1.0.0-rc.3 (2026-04-27)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.2 (2026-04-27)

### Features

- add vox.torso.html link to examples index page ([280c831](https://github.com/niivue/mono/commit/280c831))
- **niivue:** drawing matcap lighting and bench modularization ([d0e6e7f](https://github.com/niivue/mono/commit/d0e6e7f))
- **niivue:** drawing labels, loadDrawing fix, and render bench harness ([3334824](https://github.com/niivue/mono/commit/3334824))
- **medgfx:** add native macOS/iOS app with embedded NiiVue web view ([38d7a70](https://github.com/niivue/mono/commit/38d7a70))

### Fixes

- **niivue:** inline asset images as base64 data URIs in lib build ([#10](https://github.com/niivue/mono/issues/10))

### Thank You

- Claude Opus 4.7 (1M context)
- hanayik @hanayik
- neurolabusc
- Taylor Hanayik @hanayik

## 1.0.0-rc.1 (2026-04-22)

### 🚀 Features

- **niivue:** add custom layout support ([26f23c5](https://github.com/niivue/mono/commit/26f23c5))

### 🩹 Fixes

- **ci:** use bunx --bun to force Bun runtime for vite commands ([19e1df2](https://github.com/niivue/mono/commit/19e1df2))
- **ci:** use bunx for vite commands and resolve typecheck errors ([6e637db](https://github.com/niivue/mono/commit/6e637db))
- **niivue:** preserve aspect ratio in custom layout tiles ([aa418c8](https://github.com/niivue/mono/commit/aa418c8))
- **nv-react:** update to new niivue API and switch dev server to Vite ([5c90bc4](https://github.com/niivue/mono/commit/5c90bc4))
- **niivue:** resolve TypeScript strict null check errors across codebase ([f3936c3](https://github.com/niivue/mono/commit/f3936c3))

### ❤️ Thank You

- Taylor Hanayik @hanayik