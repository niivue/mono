import json,base64,pathlib
p=pathlib.Path(__file__).parent
methods={'baseline':'Off','2-2-25-75-1':'Positive curvature: 2 mm, 25–75 HU/mm²','0-2-25-75-1':'Absolute curvature: 2 mm, 25–75 HU/mm²','0-2-25-75-0.5':'Absolute curvature: 50% strength','1-4-450-650-1':'High endpoint: 4 mm, 450–650 HU'}
data={}
for sample in ('ct-philips','ct-abdo'):
 data[sample]={}
 for method in methods:
  f=p/f'{sample}-{method}.json'
  if not f.exists():continue
  d=json.loads(f.read_text());d['png']='data:image/png;base64,'+base64.b64encode((p/f'{sample}-{method}.png').read_bytes()).decode();data[sample][method]=d
rows=[]
for dataset in ('s1212','s1749'):
 d=json.loads((p/f'materials-{dataset}.json').read_text())
 for key,name in [('2-2-25-75','Positive curvature'),('0-2-25-75','Absolute curvature'),('1-4-450-650','High endpoint')]:
  values=[d[region]['profiles'][key]['meanAttenuation']*100 for region in ('bone_boundary','vessel_interior','vessel_surface')]
  rows.append('<tr><td>'+dataset+'</td><td>'+name+'</td>'+''.join(f'<td>{v:.2f}%</td>' for v in values)+'</tr>')
html='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Precomputed boundary classification</title><style>body{font:16px/1.5 system-ui;margin:32px auto;padding:0 24px;max-width:1500px;background:#161616;color:#ddd}h1{font-size:28px}p{max-width:1050px}a{color:#9cceff}select{font:inherit;padding:6px;margin-right:20px}.images{display:grid;grid-template-columns:1fr 1fr;gap:12px}img{width:100%}figure{margin:0}td,th{border-bottom:1px solid #555;text-align:left;padding:6px 16px}table{border-collapse:collapse}pre{overflow:auto;background:#222;padding:12px}@media(max-width:750px){.images{grid-template-columns:1fr}}</style>
<h1>Precomputed boundary classification</h1>
<p>The stable source is pushed as <code>c7d8b9d8</code> on <code>feat/cinematic-labels</code>. This study is separate, local, and opt-in. <a href="http://localhost:8080/@fs/Users/chris/src/mono/scratch/boundary-study/play.html">Open the interactive experiment</a> (development server required).</p>
<p><strong>Result:</strong> preprocessing is a practical place for the feature. A conservative positive-curvature profile offers modest separation with less vessel attenuation than absolute curvature. These results justify further evaluation, not enabling it by default.</p>
<label>Scan <select id="sample"><option value="ct-philips">CT_Philips</option><option value="ct-abdo">CT_Abdo</option></select></label><label>Profile <select id="method"></select></label>
<div class="images"><figure><figcaption>Original</figcaption><img id="before" alt="Original rendering"></figure><figure><figcaption id="caption"></figcaption><img id="after" alt="Experimental rendering"></figure></div><p id="metric"></p>
<h2>Known-material check</h2><p>Mean attenuation of the opacity multiplier within selected candidate voxels: 100–450 HU and Sobel gradient below 160 HU/mm. Bone boundaries are a one-voxel shell around selected skeletal segmentations. Vessel interiors are eroded masks; vessel surfaces are the remaining labelled voxels. These include selected major arteries and portal veins, not every vessel. Segmentation labels are reference regions, not verified ground truth.</p>
<table><thead><tr><th>CT</th><th>Profile</th><th>Bone boundary</th><th>Vessel interior</th><th>Vessel surface</th></tr></thead><tbody>ROWS</tbody></table>
<p>The conservative positive profile removes about 4.6% of red pixels from the head rendering. The stronger absolute profile removes about 17.8%, but the table shows why that is not automatically an improvement. Rendered red-pixel coverage is not a vessel-sensitivity metric.</p>
<h2>What is computed</h2><p>At each voxel, use the existing Sobel gradient to choose a physical direction. Sample intensities at plus/minus <code>scaleMM</code> along it. The finite-difference estimate <code>(high - 2*center + low) / scaleMM²</code> approximates the second directional derivative discussed by Kniss. It is a finite-radius approximation, not a complete Hessian implementation. Positive curvature selects locally rising/concave profiles; absolute curvature also suppresses intensity peaks, explaining its larger effect on vessels. The high-endpoint alternative tests the larger endpoint intensity.</p>
<p>A smooth threshold produces a multiplier, blended toward 1 by <code>strength</code> and restricted to the angio intensity band with smooth shoulders (100–160 and 350–450 HU). It is stored in the existing gradient texture’s unused W component. The march and extinction/shadow builder multiply by that same weight, using their existing gradient reads. Normals remain unchanged. This is baked modulation, not full RGBA preclassification.</p>
<h2>Cost and API implications</h2><p>No extra per-sample texture reads or persistent feature texture are needed in the production design; there is one extra multiplication. Warm preprocessing took about 9–12 ms for the two small CTs on Metal; first-use pipeline compilation reached about 203 ms. These wall-clock times include setup/queue completion and are not isolated compute-pass timings. Frame timings were variable, so no speedup or zero-cost claim is made.</p>
<p>The interactive prototype retains the original gradient texture for exact Off restoration and allocates a second gradient texture while enabled. That costs about 84 MiB for Philips and 89 MiB for Abdo. A production implementation could fuse feature calculation into the original gradient-build pass instead. Changing profile settings invalidates extinction and restarts accumulation.</p>
<p>A possible API shape is explicit and serializable, with physical units and an exact Off state; do not freeze its names or thresholds yet:</p>
<pre>boundaryClassification: null
// or an angio-specific profile:
boundaryClassification: {
  feature: 'positiveSecondDerivative',
  scaleMM: 2,
  range: [25, 75], // HU/mm², smooth attenuation ramp
  strength: 0.5
}</pre>
<p>The profile must belong to the transfer function, not silently apply to all colormaps or label-based materials. A neutral modifier must preserve the original. If feature values rather than final weights are cached, threshold/strength edits can avoid repeating the neighbourhood analysis; this prototype deliberately prioritizes simple, transparent experiments.</p>
<h2>Verification and limits</h2><p>Chromium Metal (non-fallback adapter), 800×493 render, 32 progressive samples, camera 110°/10°. Zero strength was pixel-identical to the original shader. Live profile enable/disable restored the exact original image. Shader compilation and GPU validation errors are asserted in the harness. Pre-push affected format, lint, typecheck, tests, build, boundaries, and codespell passed; incidental generated Python binding changes were restored before pushing.</p>
<p>Not tested: small-vessel accuracy, Safari, a broader dataset, or general applicability to other transfer functions. Fixed thresholds are empirical; classification is not anatomical segmentation. Most of the head artifact remains. Nothing here changes the normal cinematic page or the pushed branch.</p>
<p>Files: <code>feature.wgsl</code>, <code>profile.mjs</code>, <code>play.html</code>/<code>play.mjs</code>, <code>run.mjs</code>, <code>test-play.mjs</code>, and <code>check-materials.py</code>. Reproduce a render from the repo root with <code>bun scratch/boundary-study/run.mjs 2-2-25-75-1 ct-philips</code>.</p>
<script>const data=DATA,labels=LABELS;const s=document.querySelector('#sample'),m=document.querySelector('#method');function options(){m.replaceChildren(...Object.keys(data[s.value]).filter(x=>x!=='baseline').map(x=>new Option(labels[x],x)));m.value='2-2-25-75-1';draw()}function draw(){const b=data[s.value].baseline,a=data[s.value][m.value];document.querySelector('#before').src=b.png;document.querySelector('#after').src=a.png;document.querySelector('#caption').textContent=labels[m.value];document.querySelector('#metric').textContent=`Red pixels: ${b.red.toLocaleString()} → ${a.red.toLocaleString()} (${(100*(1-a.red/b.red)).toFixed(1)}% reduction).`};s.onchange=options;m.onchange=draw;options();</script></html>'''
(p/'comparison.html').write_text(html.replace('ROWS',''.join(rows)).replace('DATA',json.dumps(data)).replace('LABELS',json.dumps(methods)))
