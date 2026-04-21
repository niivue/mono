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

## Part of the [NiiVue](https://github.com/niivue) ecosystem
