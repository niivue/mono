# demo-uikit

Demo pages for [`@niivue/uikit`](../../packages/uikit/README.md) and NiiVue's
uikit widgets (`@niivue/niivue/uikit`). `standalone.html` uses uikit alone, on
a bare canvas. Published at `/demo-uikit/` on the Pages site, and served by the
niivue dev server (`bunx nx dev niivue`, port 8080) at
http://localhost:8080/demo-uikit/index.html.

`bunx nx dev demo-uikit` serves the pages with Vite (port 8093); the dev
server also mounts `@niivue/dev-images`, so the pages can load real volumes
from `/volumes/...`. Each page's nav links to the others and marks the current
one; a backend menu reloads it on WebGL2 or WebGPU (`slide-wsi.html` defaults
to WebGPU, the others to WebGL2), and a status bar at the
bottom shows help on the left and the page's state on the right (yellow while
it waits, green for a result, red for an error). `demo.css`, `statusBar.js`
and `urlParamSelect.js` are shared by the pages.

| Page | Shows |
| --- | --- |
| `index.html` | Every widget on one `UIKitControls` layer over a volume: a menu bar, segmented control, select, toggles, sliders, number and text inputs, a text area, a color control, a file picker, a tool palette and a dialog. "Own panel" keeps the image out of the controls' strip with NiiVue's `layoutInset` |
| `calipers.html` | Calipers (the ruler overlay) on an axial CT slice, in the volume's units, beside NiiVue's static scale ruler. Endpoints are world points: they follow pan and the zoom slider, belong to their slice (hidden on others), and a drag never places one |
| `volume.html` | Volume ruler with a view selector and magnifier toggle |
| `slide.html` | The ruler over a Deep Zoom slide in the 3D render tile. By design it measures canvas pixels, not the scene: the zoom slider scales the scene under fixed calipers, and Retina switches device and CSS pixels; a magnifier toggle |
| `slide-wsi.html` | Tiles: the ruler, scale bar and slide minimap on the standalone tiled viewer (DICOM whole-slide image or Deep Zoom). Zoom slider and right-drag box zoom and a magnifier toggle; a slide without pixel spacing gets a page-drawn bar in slide pixels |
| `buttons.html` | `UIKitButtonOverlay` on its own: view buttons, a toggling label and a styled reset |
| `standalone.html` | No NiiVue: `UIKitCanvasHost` on a bare canvas; the app's own triangle shader with sliders, a colour control, a toggle, a button and a ruler over it |

