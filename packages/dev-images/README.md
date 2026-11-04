# @niivue/dev-images

Shared test volumes, meshes, and tractography files for the NiiVue monorepo. Stored with [Git LFS](https://git-lfs.github.com/).

This is a **private** package — not published to npm. It is used by demo apps and tests across the monorepo.

## Usage

```ts
import { imagesDir, volumesDir, imagePath } from '@niivue/dev-images'

imagePath('volumes/mni152.nii.gz') // absolute path to a test volume
```

A Vite plugin is also provided to serve image files during development and emit them as assets during build:

```ts
// vite.config.js
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'

export default {
  plugins: [devImagesPlugin()],
}
// → /volumes/mni152.nii.gz is now served automatically
```

Pass `devImagesPlugin({ emit: false })` to serve without emitting, when the build gets its images elsewhere.

The dev server also serves procedural OME-Zarr stores under `/tiles/` (`src/syntheticZarr.ts`): `synthetic-v1.ome.zarr` (301^3) and `synthetic-oct-v1.ome.zarr` (1716 x 1470 x 561), float32 Zarr v2 with 64^3 chunks, the geometry of the DANDI 000722 OCT stores. Each chunk is generated on request, so no bytes are in the repository; a build does not emit them. Bump a store's version when the field changes, since clients may cache chunks.

## Tests

```bash
bunx nx test dev-images
```

## Part of the [NiiVue](https://github.com/niivue) ecosystem
