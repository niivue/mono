# docs-site

The NiiVue documentation site: Markdown guides with live demos, plus a
gallery of every example page in `packages/niivue/examples`. Built with
Docusaurus and deployed to `/mono/docs/` by `.github/build-pages.sh`.

```bash
bunx nx dev docs-site     # dev server
bunx nx build docs-site   # static build in apps/docs/dist
```

- `docs/*.mdx`: the guides. Each live demo is a module in `src/demos` that
  receives a canvas and returns the viewer; the page shows its source.
- `plugins/gallery.ts`: builds the repository knowledge graph
  (`bun run graph:build`) and turns each card in `examples/index.html` into a
  gallery page. The code shown for an example is its inline script plus the
  local modules the graph links it to.
- `plugins/niivue-webpack-plugin.ts`: turns off symlink resolution so Babel
  does not re-transpile the built `@niivue/niivue` dist.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOCS_BASE_URL` | `/` | URL prefix of the site |
| `DOCS_EXAMPLES_BASE` | `https://niivue.github.io/mono/` | where demos fetch images and the gallery embeds example pages |
