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
const DEMO_PAGES = ['index', 'buttons', 'ruler', 'slide', 'slide-wsi', 'volume']

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
            }),
          ]
        : [devImagesPlugin()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      lib: {
        entry: 'src/index.ts',
        formats: ['es'],
        fileName: 'uikit',
      },
      // UIKit brings its own rendering; @niivue/niivue is only a peer for the
      // lifecycle hook (added later), so keep it external when it is used.
      rolldownOptions: {
        external: ['@niivue/niivue'],
      },
    },
  }
})
