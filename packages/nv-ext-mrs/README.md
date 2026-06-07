# @niivue/nv-ext-mrs

MR spectroscopic imaging (MRSI / CSI) visualization for NiiVue — a port of the
[FSLeyes MRS plugin](https://git.fmrib.ox.ac.uk/fsl/fsleyes/fsleyes-plugin-mrs)
workflow.

MRSI is a spatial grid of MR spectra: every voxel of a low-resolution image
holds a complex free-induction decay (FID). This package overlays that grid on a
high-resolution anatomy, shows the spectrum at the crosshair voxel (updating as
you navigate), and integrates a ppm band across all voxels into a metabolite map.

## What lives where

- **NiiVue core** (`@niivue/niivue`) owns the spatial-spectral plumbing and the
  FSL-MRS spectral math: a complex MRSI NIfTI loads on the volume path, retains
  its raw complex FID + spectral metadata (`NVImage.complexFID` / `mrsMeta`), and
  shows a derived total-signal map; `nv.addMrsiSignal(volumeId)` registers a
  crosshair-following spectrum on the graph. The transforms (halve-first-point,
  apodization, 0/1-order phase, ppm-band integration, nucleus constants) are in
  `signal/processing.ts`.
- **This package** supplies the FSL-MRS display defaults, the range-to-map tool
  (`makeMetaboliteMap`), and a scene controller (`MrsScene`) that wires it all
  together. UI is left to the consumer (see `apps/demo-ext-mrs` / `mrsi.html`).

## Usage

```ts
import NiiVue from '@niivue/niivue'
import { MrsScene } from '@niivue/nv-ext-mrs'

const nv = new NiiVue()
await nv.attachTo('gl1')

const scene = new MrsScene(nv)
await scene.load({
  anatomyUrl: '/signals/mrsi_T1.nii.gz',
  mrsiUrl: '/signals/mrsi.nii.gz',
  maskUrl: '/signals/mrsi_mask.nii.gz',
})

// Move the crosshair on the ortho view -> the spectrum graph follows the voxel.
scene.setComponent('real')
scene.setApodization(2)        // 2 Hz line-broadening
scene.setPhase(0, 0)           // 0th-order (deg), 1st-order (ms)
scene.setPpmWindow([0.2, 4.2]) // 1H window

// Integrate the NAA band (1.9-2.1 ppm) across all voxels into an overlay.
await scene.makeMap([1.9, 2.1], { colormap: 'redyell' })
```

Lower-level helpers are also exported: `makeMetaboliteMap`, `paddedPpmRange`,
`defaultSpectrumDisplay`, and the core re-exports `PPM_RANGE`, `PPM_SHIFT`,
`GYRO_MAG_RATIO`, `integratePpmBandMap`.

## Status

v1 covers navigation + spectrum + manipulation + metabolite maps (plan phases
0-2). MRSI fit-results overlays (fit/baseline/residual spectra, concentration/QC
maps) are deferred — see `PORTING.md`.

## Attribution

Ports algorithms from **fsleyes-plugin-mrs**, BSD-3-Clause, (c) 2021 William
Clarke, University of Oxford. The upstream license is included as
`LICENSE.fsleyes-plugin-mrs`; `PORTING.md` maps each ported function to its
source. Demo data is FSL course data (`fsl_mrs/mrsi`).

## Links

 - [FSLeyes MRS Plugin Documentation](https://pages.fmrib.ox.ac.uk/wclarke/fsleyes-plugin-mrs/)
 - FSL course [visualize MRSI](https://open.oxcin.ox.ac.uk/pages/fslcourse/practicals/fsl_mrs/index.html#mrsi_visualise) tutorial.
 - [mrs_nifti_standard](https://github.com/wtclarke/mrs_nifti_standard)
 - [fsleyes-plugin-mrs](https://git.fmrib.ox.ac.uk/paulmc/fsleyes-plugin-mrs) repository
 - [spec2nii](https://github.com/wtclarke/spec2nii) Python conversion tool
 - [spec2nii_test_data](https://git.fmrib.ox.ac.uk/wclarke/spec2nii_test_data)
