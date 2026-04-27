# ipyniivue examples

`01_hello_volume.ipynb` is the small smoke notebook used by the Nx
`smoke` target.

The remaining notebooks are first-pass ports of selected
`packages/niivue/examples/*.html` demos:

| Notebook | Source demo | Notes |
| --- | --- | --- |
| `02_vox_basic.ipynb` | `vox.basic.html` | Volume, colormap, orientation, and slice controls |
| `03_vox_atlas.ipynb` | `vox.atlas.html` | MNI template plus AAL atlas labels |
| `04_mesh_basic.ipynb` | `mesh.basic.html` | Mesh and shader selection |
| `05_mesh_layers.ipynb` | `mesh.layers.html` | Cortical mesh with curvature and statistical layers |
| `06_tract_dsi.ipynb` | `tract.dsi.html` | TinyTrack tractography controls |
| `07_connectome.ipynb` | `connectome.html` | Dense/sparse connectome controls |
| `08_clip_planes.ipynb` | `vox.clip.html` | Clip-plane count, cutaway, and color controls |
| `09_freesurfer_crosscut.ipynb` | `freesurfer.crosscut.html` | FreeSurfer volume plus crosscut mesh shader |
| `10_vox_4d.ipynb` | `vox.4d.html` | 4D frame, graph, calibration, colorbar, and pixel-ratio controls |
| `11_vox_stats.ipynb` | `vox.stats.html` | Asymmetric statistical thresholds and clip-plane controls |
| `12_vox_modulate.ipynb` | `vox.modulate.html` | FA/V1 opacity, modulation, and V1 slice-shader controls |
| `13_vox_paqd.ipynb` | `vox.paqd.html` | PAQD rendering presets with atlas and statistical overlays |
| `14_tract_tsf.ipynb` | `tract.tsf.html` | TCK tract with TSF and TXT scalar overlays |
| `15_tract_group.ipynb` | `tract.group.html` | Single tract-group selection for the Yeh 2022 TRX atlas |
| `16_tract_groups.ipynb` | `tract.groups.html` | Multi-group tract selection with fixed palette colors |
| `17_layout.ipynb` | `layout.html` | Multiplanar, mosaic, hero, margin, ruler, and radiological controls |
| `18_mesh_atlas.ipynb` | `mesh.atlas.html` | Anatomical atlas mesh with shader, legend, and background controls |
| `19_vox_atlas_stat.ipynb` | `vox.atlas.stat.html` | AAL atlas labels plus a statistical overlay |
| `20_freesurfer_clip.ipynb` | `freesurfer.clip.html` | FreeSurfer brainmask and pial mesh with 2D mesh clipping controls |
| `21_vox_mask.ipynb` | `vox.mask.html` | Background image masking for overlay volumes |
| `22_vox_thumbnail.ipynb` | `vox.thumbnail.html` | Volume thumbnail loading and visibility controls |
| `23_ext_imgproc.ipynb` | `imgproc.html` | `@niivue/nv-ext-image-processing` transforms (otsu, removeHaze, conform, connectedLabel) via `nv.apply_image_transform` |
| `24_ext_drawing.ipynb` | `drawing.html` | `@niivue/nv-ext-drawing` interpolation: draw a few slices, then fill the gaps with `nv.interpolate_drawing_slices` (intensity-guided optional) |

The ports use the public GitHub Pages asset mirror:

```python
BASE_URL = "https://niivue.github.io/mono"
VOLUMES = f"{BASE_URL}/volumes"
MESHES = f"{BASE_URL}/meshes"
```

Controller notebooks use `ipywidgets` for sliders, dropdowns, and
checkboxes. These drive Python-to-JavaScript updates and avoid relying on
NiiVue browser events returning to Python.
