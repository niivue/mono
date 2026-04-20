# Fonts

NiiVueGPU renders text with MSDF (multi-channel signed distance field) atlases. Each
font is shipped as a `.json` metrics file + `.png` atlas pair under
`src/assets/fonts/`, wrapped at build time by `scripts/generate-assets.js` into a
TypeScript module that the library can import.

Only `ubuntu` (ASCII) is bundled with the library; `src/assets/fonts/index.ts`
is the barrel consumed by `NVControlBase` as the default font and published in
the npm tarball. Community atlases — including CJK-capable fonts like Poem —
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

**Bundling alternative:** drop the resulting `.json` + `.png` into
`src/assets/fonts/` and rerun `scripts/generate-assets.js`. Everything in
that directory ships in the published npm package, so reserve this path
for fonts you genuinely want bundled as defaults.
