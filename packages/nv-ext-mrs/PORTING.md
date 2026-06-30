# Porting provenance: fsleyes-plugin-mrs -> NiiVue

`@niivue/nv-ext-mrs` and the MRS support in NiiVue core port algorithms from
**fsleyes-plugin-mrs** (BSD-3-Clause, (c) 2021 William Clarke, University of
Oxford; co-author Vasilis Karlaftis; acks Paul McCarthy). The upstream license
is shipped verbatim as `LICENSE.fsleyes-plugin-mrs`.

The spectral math lives in NiiVue **core** (`packages/niivue/src/signal/processing.ts`
and `packages/niivue/src/volume/mrsi.ts`) so it can be shared with single-voxel
spectroscopy (`svs.html`); this package supplies the FSL-MRS display defaults,
the range-to-map tool, and the scene controller.

NiiVue follows camelCase / `NV*` naming; where it does not conflict, function
and constant names mirror the upstream so the port is auditable.

## Function-by-function map

| NiiVue (TypeScript) | Upstream (Python) | Notes |
|---|---|---|
| `GYRO_MAG_RATIO`, `PPM_SHIFT`, `PPM_RANGE` (core `processing.ts`) | `constants.py` (`GYRO_MAG_RATIO`, `PPM_SHIFT`, `PPM_RANGE`) | dict literals ported verbatim |
| `ppmRefForNucleus()` (core) | `PPM_SHIFT[nucleus]` lookup | the additive ppm offset (1H = 4.65) |
| `halveFirstPoint()` (core) | `calcSpectrum`: `data[..., 0] *= 0.5` (`utils.py`) | first-FID-point scaling |
| `deriveSpectroscopySeries()` FFT+fftshift (core) | `calcSpectrum`: `np.fft.fft` then `np.fft.fftshift` (`utils.py`) | no conjugation |
| Hz axis `(i-half)/(nFFT*dwell)` (core) | `calcFrequencies`: `fftfreq(n, dwell)` + `fftshift` (`powerspectrumseries.py`) | dwell = `pixdim[4]` |
| Hz->ppm `-hz/specFreq + shift` (core) | `_set_mrs_plot_scale`: `xScale = -1/spec_freq`, `xOffset = PPM_SHIFT` (`views.py`) | display-only transform |
| `apodize()` (core) | `apodize`: `exp(-t/(1/broadening))`, `t = linspace(0, dwell*(N-1), N)` (`utils.py`) | exponential line-broadening |
| `phaseCorrection()` (core) | `phaseCorrection`: `exp(1j*2*pi*(p0/360 + freqs*p1))` (`powerspectrumseries.py`) | p0 degrees, p1 seconds (UI ms /1000) |
| `integratePpmBandMap()` (core) | `range_tool.draw_overlay`: apodize -> `calcSpectrum` -> `phaseCorrection` -> `sum(abs|real(spectrum[..., band]), axis=-1)` (`range_tool.py`) | per-voxel band integral |
| `makeMetaboliteMap()` naming `SpecSum_{lo}_{hi}` | `range_tool.draw_overlay`: `f'SpecSum_{lo:0.1f}_{hi:0.1f}'` | overlay name |
| transient averaging in `deriveSpectroscopySeries` / `integratePpmBandMap` | `apply_higher_dim_operations` mean branch (`utils.py`) | dims 5-7 mean reduction (index/diff deferred) |

## Reference parity values

`packages/niivue/src/signal/processing.test.ts` mirrors the upstream
`tests/test_utils.py` cases:

- `calcSpectrum([1,2,3,4])` -> `fftshift(fft([0.5,2,3,4]))` = `[-2.5, -2.5-2j, 9.5, -2.5+2j]`
- `apodize([1,2,3,4], dwell=0.1, broadening=1)` -> `[1,2,3,4] * exp(-[0,0.1,0.2,0.3])`
- `phaseCorrection` zero-order rotation (p0 in degrees).

## Deferred / not yet ported

- `apply_higher_dim_operations` index/difference branches and DIM_COIL SVD coil
  combination (the demo dataset has no higher dims; only the mean branch is used).
- MRSI fit-results loading (`tools.py`: tree + colourscheme -> fit/baseline/
  residual spectra and concentration/QC maps). Deferred — the demo dataset has
  no `fsl_mrsi` results directory. When ported, the upstream restricted-`eval`
  colourscheme heuristic will be replaced with a safe expression evaluator.
- Interactive Ctrl/Shift-drag phasing (`profiles.py`): the demo uses sliders.
