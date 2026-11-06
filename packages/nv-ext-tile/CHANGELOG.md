## 1.0.0-rc.21 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.109

## 1.0.0-rc.20 (2026-11-06)

### Features

- **nv-ext-wsi,demo-ext-wsi:** ICC colour management for DICOM-WSI and TIFF ([70ff4595](https://github.com/niivue/mono/commit/70ff4595))
- **nv-ext-wsi:** hosted DICOM-WSI manifests from the index ([a1ccadbb](https://github.com/niivue/mono/commit/a1ccadbb))
- **nv-ext-wsi:** export the DICOM-WSI index; registerDcm2niixDecoders ([a109ae88](https://github.com/niivue/mono/commit/a109ae88))
- **nv-ext-wsi:** index local DICOM-WSI folders and read their tiles ([0f7c7327](https://github.com/niivue/mono/commit/0f7c7327))

### Fixes

- **nv-ext-wsi:** dispose cancels a TIFF's deferred ICC profile read ([bafb3e95](https://github.com/niivue/mono/commit/bafb3e95))
- **nv-ext-wsi,demo-ext-wsi:** a host ICC transform wins; status shows a profile that is off ([642efbb1](https://github.com/niivue/mono/commit/642efbb1))
- **nv-ext-wsi:** implicit frame order only for TILED_FULL or unpositioned files ([55d7f695](https://github.com/niivue/mono/commit/55d7f695))
- **nv-ext-wsi:** bound derived paths and slide levels; bucket frames once ([6804d182](https://github.com/niivue/mono/commit/6804d182))
- **nv-ext-wsi:** place implicit planes in um; bound planes and tile maps ([cdf28942](https://github.com/niivue/mono/commit/cdf28942))
- **nv-ext-wsi,demo-ext-wsi:** rank stated focal planes across a slide's levels ([e9cf277b](https://github.com/niivue/mono/commit/e9cf277b))
- **nv-ext-wsi,demo-ext-wsi:** rank focal planes; linear nesting test ([6c30eca1](https://github.com/niivue/mono/commit/6c30eca1))
- **nv-ext-wsi,demo-ext-wsi:** external review fixes ([#581](https://github.com/niivue/mono/issues/581))
- **nv-ext-wsi:** bound slides per instance; walk a BOT whose last entry misses ([e2c2008c](https://github.com/niivue/mono/commit/e2c2008c))
- **nv-ext-wsi:** URL-encode file names in hosted manifests ([60b78aaa](https://github.com/niivue/mono/commit/60b78aaa))
- **nv-ext-wsi:** harden the DICOM-WSI index against hostile files; simplify ([33f0ff04](https://github.com/niivue/mono/commit/33f0ff04))
- **nv-ext-wsi:** show DICOM-WSI row 0 at the top ([e5635865](https://github.com/niivue/mono/commit/e5635865))

### Performance

- **nv-ext-wsi:** build tile maps on open, not at indexing ([fa6c51a3](https://github.com/niivue/mono/commit/fa6c51a3))
- **nv-ext-wsi:** faster DICOM-WSI index walks; DICOMDIR is not-tiled ([7c02ec0e](https://github.com/niivue/mono/commit/7c02ec0e))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.108

### Thank You

- neurolabusc

## 1.0.0-rc.19 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.107

## 1.0.0-rc.18 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.106

## 1.0.0-rc.17 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.105

## 1.0.0-rc.16 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.104

## 1.0.0-rc.15 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.103

## 1.0.0-rc.14 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.102

## 1.0.0-rc.13 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.101

## 1.0.0-rc.12 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.100

## 1.0.0-rc.11 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.99

## 1.0.0-rc.10 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.98

## 1.0.0-rc.9 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.97

## 1.0.0-rc.8 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.96

## 1.0.0-rc.7 (2026-11-06)

### Features

- ⚠️  **nv-ext-wsi:** rename @niivue/nv-ext-tiff to @niivue/nv-ext-wsi ([14e8bbfc](https://github.com/niivue/mono/commit/14e8bbfc))

### Breaking Changes

- **nv-ext-wsi:** rename @niivue/nv-ext-tiff to @niivue/nv-ext-wsi  ([14e8bbfc](https://github.com/niivue/mono/commit/14e8bbfc))
  install @niivue/nv-ext-wsi instead of @niivue/nv-ext-tiff.

### Updated Dependencies

- Updated niivue to 1.0.0-rc.95

### Thank You

- neurolabusc

## 1.0.0-rc.6 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.94

## 1.0.0-rc.5 (2026-11-05)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.93

## 1.0.0-rc.4 (2026-11-05)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.92

## 1.0.0-rc.3 (2026-11-05)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.91

## 1.0.0-rc.2 (2026-11-05)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.90

## 1.0.0-rc.1 (2026-11-05)

### Features

- **nv-ext-tiff:** stream tiled/pyramidal TIFF and SVS slides via geotiff ([#179](https://github.com/niivue/mono/issues/179))

### Fixes

- **nv-ext-tiff:** keep the alpha channel of RGBA tiles ([8132df4d](https://github.com/niivue/mono/commit/8132df4d))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.89

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc