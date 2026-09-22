## 0.1.0-rc.0 (2026-09-02)

### Features

- **uikit:** add a crosshair widget with optional graduations ([1cba564](https://github.com/niivue/mono/commit/1cba564))
- **nv-ohif:** unify Length onto the annotation system ([cd0509c](https://github.com/niivue/mono/commit/cd0509c))
- Bidirectional measurement (two perpendicular axes) end to end ([0064166](https://github.com/niivue/mono/commit/0064166))
- **uikit:** annotation overlay renderer (ellipse/rect/circle/line/arrow) ([70fe22a](https://github.com/niivue/mono/commit/70fe22a))
- **uikit:** make @niivue/uikit publishable and depend on it from nv-ohif ([ebc8ca0](https://github.com/niivue/mono/commit/ebc8ca0))
- **uikit:** drop the ruler arrowheads (end caps mark the extent) ([85b5b09](https://github.com/niivue/mono/commit/85b5b09))
- **uikit:** long perpendicular end caps marking the ruler's start and end ([798d0ef](https://github.com/niivue/mono/commit/798d0ef))
- **uikit:** larger default ruler label size (22 -> 36 px) ([43c9457](https://github.com/niivue/mono/commit/43c9457))
- **nv-ohif:** UIKit ruler on the WSI viewport with physical-unit measurement ([3fec150](https://github.com/niivue/mono/commit/3fec150))
- **uikit:** auto-contrast font outlines (SDF expansion) ([2896b44](https://github.com/niivue/mono/commit/2896b44))
- **uikit:** font-size slider for the WSI ruler demo ([490f2ee](https://github.com/niivue/mono/commit/490f2ee))
- measure WSI slides in real physical units (um/mm) ([d030a76](https://github.com/niivue/mono/commit/d030a76))
- **uikit:** source the WSI demo tissue from the test-images repo ([953cf01](https://github.com/niivue/mono/commit/953cf01))
- **uikit:** load real tissue slides in the WSI ruler demo ([cf18345](https://github.com/niivue/mono/commit/cf18345))
- **uikit:** ruler on the WSI viewer + no-depth WebGPU passes ([cfabdb5](https://github.com/niivue/mono/commit/cfabdb5))
- **uikit:** volume + slide ruler demos with real measurement ([90cdabe](https://github.com/niivue/mono/commit/90cdabe))
- **uikit:** ruler widget with readability guard + demo ([555edc5](https://github.com/niivue/mono/commit/555edc5))
- **uikit:** transformed MSDF text renderer on both backends ([56317c8](https://github.com/niivue/mono/commit/56317c8))
- **uikit:** line renderer on both backends + overlay-hook proof ([2ca8aab](https://github.com/niivue/mono/commit/2ca8aab))
- **uikit:** scaffold @niivue/uikit package with line primitives ([1dce813](https://github.com/niivue/mono/commit/1dce813))

### Fixes

- **uikit:** place ROI labels below the box, stack lines, render spaces ([77f6809](https://github.com/niivue/mono/commit/77f6809))
- **uikit:** space-separate annotation label parts ([#3](https://github.com/niivue/mono/issues/3))
- address second-review findings on the ruler/WSI fixes ([d1027c6](https://github.com/niivue/mono/commit/d1027c6))
- **uikit:** WebGPU text renderer draws each run's own vertices/uniform (review finding 1) ([b408440](https://github.com/niivue/mono/commit/b408440))
- **niivue,uikit:** shrink arrowheads on short lines so buildTerminatedLine can't invert (review finding 2) ([9b3de35](https://github.com/niivue/mono/commit/9b3de35))
- **uikit:** lift the length label clear of the graduation numbers ([b3ff6a3](https://github.com/niivue/mono/commit/b3ff6a3))
- **uikit:** thin ruler graduation numbers so they never collide ([0c1ef0f](https://github.com/niivue/mono/commit/0c1ef0f))
- **uikit:** draw font outlines as an offset halo, not SDF expansion ([552263a](https://github.com/niivue/mono/commit/552263a))
- **uikit:** correct glyph texture V mapping (text was mirrored) ([c0215bf](https://github.com/niivue/mono/commit/c0215bf))

### Performance

- **uikit,nv-ohif:** cache ruler layout + reuse GL line scratch (review findings 8/10) ([#8](https://github.com/niivue/mono/issues/8), [#10](https://github.com/niivue/mono/issues/10), [#9](https://github.com/niivue/mono/issues/9))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.13

### Thank You

- Chris Drake
- Claude Fable 5
- Claude Opus 5