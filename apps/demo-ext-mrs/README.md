# demo-ext-mrs

Live demo of MR spectroscopic imaging (MRSI) in NiiVue, built on
[`@niivue/nv-ext-mrs`](../../packages/nv-ext-mrs). The entry page is
**`mrsi.html`**.

It overlays the complex MRSI grid on a T1 anatomy, follows the crosshair to show
each voxel's spectrum, and turns a ppm window into a metabolite map — the
FSLeyes MRS plugin workflow.

```bash
bunx nx dev demo-ext-mrs      # http://localhost:8090/mrsi.html
```

## Data

The demo loads from `/signals/` (served by `@niivue/dev-images` from
`packages/dev-images/images/signals/`, alongside the `svs_*` fixtures):

- `mrsi_T1.nii.gz` — 1 mm anatomy (background)
- `mrsi.nii.gz` — 48×48×1×1024 complex64 MRSI grid (overlay)
- `mrsi_mask.nii.gz` — valid-voxel mask (hides empty voxels)

These are FSL course data (`fsl_mrs/mrsi`). The T1 should be defaced and
size-reduced before public hosting (see the repo's data-governance notes).

## Controls

- **Component** — real / imaginary / magnitude / phase
- **Apodize (Hz)** — exponential line-broadening
- **Phase0 (°) / Phase1 (ms)** — 0th / 1st-order phase correction
- **ppm low / high** — spectrum display window; **Full range** clears it
- **Map** — integrate `magnitude` (|spectrum|) or the `real` part over the band
- **Make map** — integrate the current ppm window across all voxels into a
  `SpecSum_{lo}_{hi}` metabolite-map overlay (e.g. 1.9-2.1 ppm → an NAA map);
  **Map opacity** adjusts the latest map
- **Map threshold** — raise the MRSI grid's lower display threshold (`calMin`)
  to hide low-signal voxels (e.g. residual signal outside the head)
- **Mask** — restrict the MRSI overlay to in-mask (brain) voxels by modulating
  it with `mrsi_mask.nii.gz` (cosmetic; off shows the full grid FOV)
- **Snap** — snap the crosshair to the MRSI voxel grid so the cursor marks the
  centre of the coarse cell being sampled (free crosshair off the grid)
- **Colormap** — MRSI grid colormap; `warm` (default) matches FSLeyes, plus the
  colorblind-safe perceptual maps `cividis` / `viridis` / `magma` / `lipari`
- **Colorbar** — show/hide the MRSI intensity scale. The grid value is the
  *total signal* (the ppm-band integral of `|spectrum|`), a relative magnitude
  in arbitrary units — not SNR or a metabolite concentration
- **View** — axial / coronal / sagittal / multiplanar / render
- **WebGPU** — toggle the rendering backend
