import { getCollection } from 'astro:content'
import type { APIRoute } from 'astro'
import { guide, markdownPath } from '../lib/markdown'
import { sidebar } from '../sidebar'
import { docsUrl, rawRepoUrl, repoUrl } from '../site'

// The llms.txt index (https://llmstxt.org/): a summary, the facts an agent
// most often gets wrong, then every guide's Markdown version in reading order.

const SUMMARY = `NiiVue is a JavaScript library for viewing medical images in the browser: volumes such as MRI and CT, surface meshes, tractography, connectomes and physiological signals, drawn with WebGL2 or WebGPU. It needs only a canvas and a URL to the data, and no server beyond one that serves the files.`

const NOTES = `This documentation covers the rewritten NiiVue, published on npm under the \`next\` tag. Things to know when writing NiiVue code:

- Install \`@niivue/niivue@next\`. A plain \`npm install @niivue/niivue\` gets the 0.x releases, whose API is different: code written for 0.x does not work with this version.
- Settings are properties, not setter methods: \`nv.sliceType = SLICE_TYPE.AXIAL\`, not \`nv.setSliceType(...)\`. Each assignment redraws the view.
- Create a viewer, attach it to a canvas, then load data: \`const nv = new NiiVue(); await nv.attachToCanvas(canvas); await nv.loadVolumes([{ url }])\`.
- Per-image options use the same keys at load time and afterwards: \`loadVolumes([{ url, colormap: 'hot' }])\`, then \`nv.setVolume(0, { calMin: 2 })\`. Meshes work the same way with \`loadMeshes\` and \`setMesh\`.
- WebGL2 is the default renderer. \`new NiiVue({ backend: 'webgpu' })\` uses WebGPU and falls back to WebGL2 when WebGPU is unavailable.
- A viewer is an \`EventTarget\`: \`nv.addEventListener('locationChange', (e) => e.detail)\`.
- DICOM is not built in: convert it in the browser with \`@niivue/dcm2niix\`. OME-Zarr, TIFF and tiled slides load through \`@niivue/nv-ext-tile@next\`. React components are in \`@niivue/nvreact@next\`.
- Each guide below is Markdown with its live demos' code inline. A demo is a module \`async (canvas, { ui, asset, canvases })\`: \`asset(path)\` resolves a sample file under https://niivue.github.io/mono/ and \`ui\` builds its controls; neither is part of NiiVue.`

export const GET: APIRoute = async ({ url }) => {
  const site = docsUrl(url)
  const link = (path: string) => new URL(path, site).href
  const examples = (await getCollection('gallery')).length

  const guides = await Promise.all(
    sidebar.map(async ({ label, items }) => {
      const lines = await Promise.all(
        items
          .filter((item) => typeof item === 'string')
          .map(async (id) => {
            const { title, description } = (await guide(id)).data
            return `- [${title}](${link(markdownPath(id))}): ${description}`
          }),
      )
      return `## ${label}\n\n${lines.join('\n')}`
    }),
  )

  const sections = [
    `# NiiVue`,
    `> ${SUMMARY}`,
    NOTES,
    `## Documentation sets\n\n- [Complete guide](${link('llms-full.txt')}): every guide below in one file`,
    ...guides,
    `## Examples

- [Gallery](${link('gallery/')}): ${examples} example pages, each running live beside its source code
- [Example source](${repoUrl}/tree/main/packages/niivue/examples): the HTML and JavaScript of every example page`,
    `## Reference

- [API reference](${rawRepoUrl('packages/niivue/docs/api.md')}): naming rules, every viewer property by group, and the per-volume and per-mesh option types
- [Events](${rawRepoUrl('packages/niivue/docs/events.md')}): every event a viewer fires and its \`detail\`
- [Migrating from NiiVue 0.x](${rawRepoUrl('packages/niivue/docs/convert.md')}): old property names and setter methods mapped to the new API
- [Package README](${rawRepoUrl('packages/niivue/README.md')}): installation, backend-only builds and standalone ES modules`,
    `## Optional

- [Feature parity](${rawRepoUrl('packages/niivue/FEATURE_PARITY.md')}): which NiiVue 0.x features this version has, and which are still missing`,
  ]
  return new Response(`${sections.join('\n\n')}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
