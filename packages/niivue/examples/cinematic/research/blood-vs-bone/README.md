# Blood vs bone in the cinematic angio preset (research)

Not part of the demo. The angio preset (`cr_angio`) colours 150-400 HU red as
contrast blood. Red also appears where the voxel is not blood:

- (a) partial-volume voxels on bone/soft-tissue boundaries;
- (b) genuinely low-density bone: cancellous vertebral bodies, thin cortical
  plates (orbits, skull base), hyoid. On non-contrast CT_Philips nothing in
  that band is blood.

Goal: discriminate at texture preparation (once per volume), not per sample.
Scripts use local data paths (`/Users/chris/src/cinematic/...`); ground truth
is the TotalSegmentator labels of s1749 (venous phase) and s1212 (arterial).

## Already shipped or tried earlier

- Gradient magnitude (Kniss 2D TF) handles much of (a): `cr_angio` edge alpha.
- Render-time LH probe (Sereda): reverted, removed 0.3-3.5% of Philips red.

## gradient-profiles/ (first attempt)

Prep-time 1D profiles along the gradient (second derivative, high endpoint)
written to `grad.w`. Not compelling; its scoring (`check-materials.py`) only
measured bone boundaries, never cancellous interiors, which dominate (b).

## distance-to-bone/ (recommended, Fable study)

- dense = HU > T (600); D1 = Euclidean distance (mm) to dense;
  w = smoothstep(2 mm, 8 mm, D1).
- Closing term: w = 0 inside the morphological closing of dense by a 20 mm
  ball (cancellous interiors enclosed by cortex).
- Only the preset's blood band is attenuated:
  `alpha *= 1 - blood(hu) * (1 - w)`, blood = smoothstep(50,100) * (1 - smoothstep(400,450)).
- GPU: six separable squared-EDT passes (`edt.wgsl`) plus `blood.wgsl`
  writing `grad.w`. Prep 43 ms (CT_Philips, 11 M voxels), 181 ms
  (CT_WholeBody, 59 M), M-series; matches the CPU reference (`rule.py`).

| Measure | s1212 (arterial) | s1749 (venous) |
|---|---|---|
| AUC vessel vs bone interior / boundary | 0.976 / 0.931 | 0.952 / 0.954 |
| Vessel kept | 99.1% | 99.6% |
| Heart kept | 90.5% | 99.9% |
| Bone interior removed | 88.6% | 57.9% |
| Bone boundary removed | 76.0% | 66.2% |

CT_Philips: 93% of band voxels suppressed, render red pixels 8872 -> 5347.
CT_Abdo: heart ROI 86% kept; vertebral bodies turn ivory. Render cost +1-3
ms/frame (transparent interiors lengthen rays).

Limits: T is phase dependent (venous cortex is often < 600 HU at 1.5 mm, so
56-79% of sternum/sacrum/lumbar interiors stay red; T = 500 removes 23% of
arterial vessels). Head CTA untested (carotid canal, sella). Cancellous bone
vs blood cannot be fully solved from intensity; bone labels (already
supported by the renderer) fix the residual.

Rejected (see `score_*.txt`, `logit.txt`, `curves_*.txt`): max HU within R
(flips with contrast phase), in-band fraction "blood near blood" (AUC
0.30-0.56: cancellous bone has more band nearby), local texture (<= 0.79),
Hessian/Frangi/blobness (<= 0.81), gradient profiles (<= 0.60 interior),
logistic combinations (cross-case 0.92 < distance alone).

Integration sketch: EDT passes before the gradient pass, `grad.w` stays
geometry-only; a per-HU `blood` channel baked by `tf.js`; `classifyAlpha`
applies `tfA * mix(1, w, blood(hu))` for unlabeled samples only (~130-150
lines).
