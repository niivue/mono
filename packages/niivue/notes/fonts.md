# Fonts

NiiVue renders text with MSDF (multi-channel signed distance field) atlases: a
`.json` metrics file + `.png` atlas pair.

Only `ubuntu` (ASCII plus µ ° ± ² ³) is bundled. Its files live once, in
`packages/uikit/src/fonts/`; uikit inlines them (`UBUNTU_FONT_METRICS`,
`UBUNTU_FONT_ATLAS`) and core's `src/assets/fonts/ubuntu.ts` builds the default
font from them, so a rebuilt atlas reaches both packages. Community atlases — including CJK-capable fonts like Poem —
live at [niivue/fonts](https://github.com/niivue/fonts) and are fetched on
demand via `setFontFromUrl` (see `examples/font.html`).

## Swapping fonts at runtime

Use `nv1.setFont(font)` for a bundled, in-memory atlas. Use
`nv1.setFontFromUrl({ atlas, metrics })` to fetch a PNG+JSON pair from URLs —
the options-object signature prevents silently transposing the two URLs. Both
rebuild the view because the atlas texture is GPU-owned. Remote atlases go
through `applyCORS()` in `src/NVLoader.ts`, so the host must send
`Access-Control-Allow-Origin`.

## Regenerating an atlas

New atlases can be built with [msdfgen](https://github.com/chlumsky/msdfgen).
For example, a minimal CJK showcase using the open-source
[Noto Sans Simplified Chinese](https://fonts.google.com/noto/specimen/Noto+Sans+SC?preview.script=Hans):

```
msdf-atlas-gen -font NotoSansSC-Regular.ttf -charset charset.txt -pxrange 2 -dimensions 512 256 -format png -json Poem.json -imageout Poem.png
```

`charset.txt` should contain the glyphs to include, e.g.:

```
"\"\\ ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890!`?'.,;:()[]{}<>|/@^$-%+=#_&~*天地玄黄麻雀虽小"
```

**Preferred: host on a CDN and fetch on demand.** Upload the resulting
`.json` + `.png` to a CORS-enabled host and load them via
`nv1.setFontFromUrl({ atlas, metrics })` — the way `examples/font.html`
pulls fonts from the [niivue/fonts](https://github.com/niivue/fonts)
community repository. This keeps your library tarball lean and lets you
update atlases without re-publishing.

**Bundling alternative (an app's own font):** import the pair with your
bundler and pass it to `setFont`; `parseFont` (from `@niivue/uikit`) reads
the JSON:

```js
import { parseFont } from '@niivue/uikit'
import json from './MyFont.json'
import atlasUrl from './MyFont.png' // a URL or data: URL from your bundler

await nv1.setFont({ metrics: parseFont(json), atlasUrl })
```

The library bundles only `ubuntu`, kept in `packages/uikit/src/fonts/` (see
below).

## Extending the bundled atlas

The five non-ASCII glyphs were added without touching the original 95: they
were generated alone at the atlas's em size and stacked above it, so every
existing glyph keeps its texels and metrics (no render reference moved).
`yOrigin: bottom` bounds of the old glyphs stay valid; the new ones sit 256
px higher. Write the result to `packages/uikit/src/fonts/ubuntu.{png,json}`.

```
msdf-atlas-gen -font Ubuntu-Regular.ttf -charset extra.txt -type msdf -pxrange 2 \
  -size 56.84375 -dimensions 512 64 -yorigin bottom -format png \
  -json extra.json -imageout extra.png
magick extra.png Ubuntu.png -append -strip PNG24:merged.png
```

then append `extra.json`'s glyphs with `atlasBounds.bottom/top` + 256 and set
`atlas.height` to 320.

