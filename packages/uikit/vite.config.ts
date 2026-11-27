import { fileURLToPath } from 'node:url'
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig, type Plugin } from 'vite'
import dts from 'vite-plugin-dts'

// On build: emit type declarations for the library. On serve (the demo dev
// server): mount the shared dev-images plugin so the demos can load real volumes
// from `/volumes/...` (e.g. /volumes/mni152.nii.gz). The WSI demo loads its
// tissue slide from the test-images repo over the network, so no local slide
// route is needed.
//
// `vite build --mode demo` builds the demo pages instead, for GitHub Pages
// (.github/build-pages.sh): VITE_BASE is their folder (e.g. /mono/uikit/) and
// VITE_IMAGES_BASE the shared site root whose dev-images they load, as the
// demo apps do (apps/demo-ext-drawing/vite.config.js).
const DEMO_PAGES = [
  'index',
  'buttons',
  'calipers',
  'volume',
  'subvolume',
  'slide',
  'slide-wsi',
]

function imagesBaseRewrite(imagesBase: string): Plugin {
  return {
    name: 'ghpages-rewrite-asset-urls',
    enforce: 'post',
    renderChunk(code) {
      let out = code
      for (const dir of ['volumes', 'meshes'])
        for (const q of ['"', "'", '`'])
          out = out.replaceAll(`${q}/${dir}/`, `${q}${imagesBase}${dir}/`)
      return out
    },
  }
}

export default defineConfig(({ command, mode }) => {
  if (mode === 'demo') {
    const imagesBase = process.env.VITE_IMAGES_BASE ?? '/'
    return {
      base: process.env.VITE_BASE ?? '/',
      plugins: [
        devImagesPlugin({ emit: false }),
        imagesBaseRewrite(imagesBase),
      ],
      build: {
        outDir: 'dist-demo',
        emptyOutDir: true,
        target: 'esnext',
        rolldownOptions: {
          input: Object.fromEntries(
            DEMO_PAGES.map((p) => [
              p,
              fileURLToPath(new URL(`${p}.html`, import.meta.url)),
            ]),
          ),
        },
      },
    }
  }
  return {
    plugins:
      command === 'build'
        ? [
            dts({
              entryRoot: 'src',
              exclude: ['src/**/*.test.ts'],
              tsconfigPath: './tsconfig.json',
              // The plugin drops triple-slash directives; the hook types need
              // the WebGPU globals (a peer) in a consumer's typecheck.
              beforeWriteFile: (filePath, content) =>
                filePath.endsWith('/hook.d.ts')
                  ? {
                      filePath,
                      content: `/// <reference types="@webgpu/types" />\n${content}`,
                    }
                  : undefined,
            }),
          ]
        : [devImagesPlugin()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      lib: {
        // The root and controls entries need no niivue; the niivue entry does
        // (an optional peer).
        entry: {
          uikit: 'src/index.ts',
          controls: 'src/controlsEntry.ts',
          niivue: 'src/niivueEntry.ts',
        },
        formats: ['es'],
      },
      rolldownOptions: {
        external: ['@niivue/niivue'],
      },
    },
  }
})
