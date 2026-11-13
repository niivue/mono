# docs-site

The NiiVue documentation site: Markdown guides with live demos, plus a
gallery of the example pages and demo apps. Built with
[Astro](https://astro.build/) and [Starlight](https://starlight.astro.build/)
and deployed to `/mono/docs/` by `.github/build-pages.sh`.

```bash
bunx nx dev docs-site     # dev server
bunx nx build docs-site   # static build in apps/docs/dist
```

- `src/content/docs/guide/*.mdx`: the guides. Each live demo is a module in
  `src/demos` that receives a canvas and returns the viewer; `<Demo name="…" />`
  runs it and shows its source. Link between pages with root-relative URLs
  (`/guide/meshes/`); `astro.config.ts` adds the base path.
- `src/lib/gallery.ts`: builds the repository knowledge graph
  (`bun run graph:build`) and turns each card in `packages/niivue/examples/index.html` and
  `.github/pages/index.html` into a gallery entry, so adding a card there adds
  it to the gallery. The code shown for an example is its inline script plus the
  local modules the graph links it to. `src/content.config.ts` loads it as the
  `gallery` collection, and `src/pages/gallery/` renders it.
- `src/lib/markdown.ts`: each guide as Markdown at `<page>/index.md` (with
  `<Demo>` written out as its code), joined into `/llms-full.txt` and indexed
  by `/llms.txt` in the order of `src/sidebar.ts`, following
  [llmstxt.org](https://llmstxt.org/). Guides need a `description`.
- `src/pages/index.astro`: the home page. `src/components/Hero.astro` and
  `SiteTitle.astro` override Starlight's hero and header title;
  `PageTitle.astro` puts the gallery search beside the title.
- `scripts/screenshots.ts` (`bunx nx screenshots docs-site [-- slug...]`):
  captures gallery thumbnails, running any per-demo `PREPARE` steps first.
  Set `DOCS_EXAMPLES_BASE` to the server root (`http://localhost:5273/`),
  not `/examples/`.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOCS_BASE_URL` | `/` | URL prefix of the site |
| `DOCS_EXAMPLES_BASE` | `https://niivue.github.io/mono/` | where demos fetch images and the gallery embeds example pages |
