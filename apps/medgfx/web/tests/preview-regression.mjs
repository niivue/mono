/**
 * Headless regression checks for the Quick Look preview page.
 *
 *   bunx nx e2e medgfx-web                  # builds first, via Nx
 *
 * Covers the web half of Milestones 3 and 4: a document reaches JavaScript and
 * decodes with its header intact, the fixed 2×2 layout draws four non-blank
 * tiles, 4D files keep frame zero while reporting the total, exactly one
 * terminal message is ever posted, and no failure path leaves a blank canvas.
 *
 * What it cannot cover is the native half — `PreviewSchemeHandler`'s chunked
 * reads, the opaque document token, security scope, and the Quick Look
 * completion gate all need Finder on a Mac. An http server standing in for the
 * scheme handler proves the page's side of the contract, not the transport's.
 *
 * Playwright is a devDependency of this project; `packages/niivue` already
 * carries it for its own e2e suite, so this adds no new toolchain.
 */

import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nifti1, SPECIMENS } from './preview-fixtures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, '..', 'dist')
// The app's bundled sample volume, standing in for a real-world `.nii.gz`.
const SAMPLES = join(HERE, '..', '..', 'medgfx')
const DEMO = 'mni152.nii.gz'

/** Synthetic fixtures, served under /fixtures/. See preview-fixtures.mjs. */
const FIXTURES = {
  'basic.nii': SPECIMENS.volume(),
  'series.nii': nifti1({ dims: [12, 12, 10, 7] }),
  'complex.nii': nifti1({ dims: [12, 12, 10], datatype: 32 }),
  'flat.nii': nifti1({ dims: [16, 16, 1] }),
  'empty.nii': nifti1({ dims: [0, 0, 0] }),
  // Header promises a full volume; the data stops a third of the way in.
  'truncated.nii': SPECIMENS.truncated(),
  'garbage.nii': SPECIMENS.corrupt(),
  'surface.gii': SPECIMENS.surface(),
  // The case the contract singles out: per-vertex values for a surface the file
  // does not contain. It must NOT send us looking for a companion.
  'layer.gii': SPECIMENS.layerOnly(),
  'garbage.mz3': Buffer.from('not a mesh '.repeat(64)),
}

/**
 * Real mesh and tract fixtures come from the workspace's Git-LFS dev-images
 * package. A synthetic octahedron proves the GIFTI path but says nothing about
 * whether NiiVue's mz3/tck/trk/trx readers produce something visible.
 *
 * Still skipped loudly when absent: a clone without `git lfs pull` has the
 * 3-line pointer files here, not the meshes.
 */
const LFS_MESHES = join(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'dev-images',
  'images',
  'meshes',
)
const REAL_MESHES = [
  ['cortex_5124.mz3', 'surface'],
  ['tract.SLF1_R.tck', 'streamlines'],
  ['tract.IFOF_R.trk', 'streamlines'],
  ['colby.trx', 'streamlines'],
]

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
}

/**
 * Mirror the extension's opaque document route: `/document/<token>/<name>`,
 * percent-encoded exactly as `PreviewSchemeHandler.registerDocument` does —
 * every character escaped except alphanumerics and `.`.
 *
 * Serving fixtures at a plain `/fixtures/name.tck` hid a real bug for a whole
 * milestone: `NVMesh.loadMesh` reads the reader extension from the URL and
 * ignores the `name` we pass, so a fully-escaped route silently fell back to
 * the MZ3 reader and every mesh format except `.mz3` failed. Tests that do not
 * use the shape the extension actually uses cannot catch that.
 */
function documentURL(base, name) {
  // Matches `registerDocument`: everything escaped except alphanumerics and `.`.
  const encoded = name.replace(
    /[^A-Za-z0-9.]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  )
  return `${base}/document/00000000-0000-4000-8000-000000000000/${encoded}`
}

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0]))
  try {
    let body
    if (path.startsWith('/document/')) {
      // token/name — the name is the last component, and identifies the fixture.
      body = FIXTURES[path.split('/').pop()]
      if (!body) throw new Error('no such fixture')
    } else if (path.startsWith('/fixtures/')) {
      body = FIXTURES[path.slice('/fixtures/'.length)]
      if (!body) throw new Error('no such fixture')
    } else if (path.startsWith('/meshes/')) {
      body = await readFile(join(LFS_MESHES, path.slice('/meshes/'.length)))
    } else if (path.startsWith('/samples/')) {
      body = await readFile(join(SAMPLES, path.slice('/samples/'.length)))
    } else {
      body = await readFile(join(DIST, path === '/' ? 'quicklook.html' : path))
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const results = []
/** Unexpected page exceptions, asserted at the end. See the `pageerror` hook. */
const pageExceptions = []
function check(name, ok, detail) {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const { chromium } = await import('playwright')
// ponytail: PLAYWRIGHT_CHROMIUM_PATH lets this run against a headless shell
// already on the machine instead of forcing playwright's exact pinned revision
// to be downloaded (~92 MiB). Unset is the normal path.
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
})

/**
 * A fresh page with the host's message handler stubbed in before any module
 * runs, so the `ready` message is captured too.
 */
async function openPreview({ generation } = {}) {
  const page = await browser.newPage({ viewport: { width: 700, height: 560 } })
  // Mirrors the host's `WKUserScript` at `.atDocumentStart`.
  if (generation !== undefined) {
    await page.addInitScript((g) => {
      window.__qlGeneration = g
    }, generation)
  }
  // Printing these but never failing on them is the "test shaped so it cannot
  // fail" pattern again: a real exception in the interaction path would look
  // exactly like the known synthesized-input artifact below. Anything not on
  // the allow-list fails the run.
  page.on('pageerror', (e) => {
    console.log('  [page exception]', e.message)
    if (!/setPointerCapture|No active pointer/.test(e.message))
      pageExceptions.push(e.message)
  })
  await page.addInitScript(() => {
    window.__posted = []
    window.webkit = {
      messageHandlers: {
        qlPreview: { postMessage: (m) => window.__posted.push(JSON.parse(m)) },
      },
    }
  })
  await page.goto(`${base}/quicklook.html`)
  await page.waitForFunction(() => !!window.niivuePreview, null, {
    timeout: 30000,
  })
  await page.waitForFunction(
    () => window.__posted.some((m) => m.stage === 'ready'),
    null,
    {
      timeout: 30000,
    },
  )
  return page
}

/** Run one request to completion and return its terminal message. */
async function preview(url, displayName, extra = {}) {
  const page = await openPreview()
  await page.evaluate(
    ([u, name, rest]) =>
      window.niivuePreview.render({
        url: u,
        displayName: name,
        family: 'volume',
        ...rest,
      }),
    [url, displayName, extra],
  )
  const messages = await page.evaluate(() => window.__posted)
  return {
    page,
    message: messages.find((m) => m.stage === 'loaded' || m.stage === 'failed'),
  }
}

/**
 * Lit-pixel count per quadrant of the canvas.
 *
 * The canvas has no `preserveDrawingBuffer`, so reading it back in-page returns
 * an empty buffer — the Milestone 0.5 spike lost a day to exactly that. The
 * compositor does have the frame, so the screenshot is taken by Playwright and
 * handed back to the page only to be decoded.
 */
async function quadrantPixels(page) {
  const shot = (await page.locator('#gl').screenshot({ type: 'png' })).toString(
    'base64',
  )
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    const hw = Math.floor(bitmap.width / 2)
    const hh = Math.floor(bitmap.height / 2)
    return [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ].map(([qx, qy]) => {
      const { data } = ctx.getImageData(qx * hw, qy * hh, hw, hh)
      let lit = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] + data[i + 1] + data[i + 2] > 60) lit++
      }
      return lit
    })
  }, shot)
}

// --- 1. Surface --------------------------------------------------------------
let page = await openPreview()
const surface = await page.evaluate(() =>
  Object.keys(window.niivuePreview).sort(),
)
check(
  'page exposes render and fail',
  surface.join(',') === 'fail,render',
  surface.join(','),
)
await page.close()

// --- 2. A real volume decodes, draws, and reports its header ----------------
const demoSize = (await stat(join(SAMPLES, DEMO))).size
let result = await preview(`${base}/samples/${DEMO}`, DEMO, {
  fileSize: demoSize,
})
let meta = result.message?.metadata ?? {}
check(
  'demo volume posts `loaded`',
  result.message?.stage === 'loaded',
  result.message?.stage,
)
check('it is displayable', meta.displayable === 'true', meta.displayable)
check('format is named', meta.format === 'NIfTI', meta.format)
check('dimensions are reported', meta.dims === '207×256×215', meta.dims)
check(
  'voxel spacing carries a unit',
  /^[\d.]+×[\d.]+×[\d.]+ mm$/.test(meta.voxel ?? ''),
  meta.voxel,
)
check(
  'field of view is derived',
  /^[\d.]+×[\d.]+×[\d.]+ mm$/.test(meta.fov ?? ''),
  meta.fov,
)
check(
  'datatype is named, not numbered',
  /^[a-z]/.test(meta.type ?? ''),
  meta.type,
)
check(
  'orientation is a 3-letter code',
  /^[RLAPSI]{3}$/.test(meta.orient ?? ''),
  meta.orient,
)
check(
  'a 3D volume reports no frame count',
  meta.frames === undefined,
  meta.frames,
)
check('file size is shown', meta.size === '4.1 MB', meta.size)

// Accessibility: the strip abbreviates to fit a narrow panel, so the
// unabbreviated pairing has to exist somewhere a screen reader can reach.
const a11y = await result.page.evaluate(() => ({
  group: document.getElementById('meta').getAttribute('aria-label'),
  canvas: document.getElementById('gl').getAttribute('aria-label'),
  pair: document.querySelector('#meta .pair').getAttribute('aria-label'),
  role: document.getElementById('meta').getAttribute('role'),
}))
check(
  'the strip is announced as a labelled group',
  a11y.role === 'group' && a11y.group?.includes(DEMO),
  a11y.group,
)
check(
  'each value carries its label',
  /^[a-z]+: .+/.test(a11y.pair ?? ''),
  a11y.pair,
)
check(
  'the canvas is not an unlabelled graphic',
  a11y.canvas?.includes(DEMO),
  a11y.canvas,
)

const strip = await result.page.locator('#meta').innerText()
check(
  'the strip shows the filename',
  strip.includes(DEMO),
  strip.replace(/\n/g, ' | '),
)
check(
  'the spinner is dismissed',
  await result.page.locator('#loading').isHidden(),
)
check(
  'no fallback panel over a good render',
  await result.page.locator('#fallback').isHidden(),
)

// The exit gate: four non-blank tiles.
const quads = await quadrantPixels(result.page)
check(
  'all four quadrants are non-blank',
  quads.every((n) => n > 500),
  quads.join(' / '),
)

// A late timeout from the host must not overpaint a finished preview.
await result.page.evaluate(() => window.niivuePreview.fail('timeout'))
const terminal = (await result.page.evaluate(() => window.__posted)).filter(
  (m) => m.stage === 'loaded' || m.stage === 'failed',
)
check(
  'a late fail() cannot post a second terminal message',
  terminal.length === 1,
  `${terminal.length}`,
)
check(
  'the fallback does not overpaint a loaded preview',
  await result.page.locator('#fallback').isHidden(),
)
await result.page.close()

// --- 3. Synthetic geometry, so the numbers are known exactly ----------------
result = await preview(documentURL(base, 'basic.nii'), 'basic.nii', {
  fileSize: 1234,
})
meta = result.message?.metadata ?? {}
check('synthetic dims are exact', meta.dims === '24×28×20', meta.dims)
check('synthetic spacing is exact', meta.voxel === '2×2×2.5 mm', meta.voxel)
check('synthetic fov is exact', meta.fov === '48×56×50 mm', meta.fov)
check('synthetic orientation is RAS', meta.orient === 'RAS', meta.orient)
check('synthetic datatype is uint8', meta.type === 'uint8', meta.type)
await result.page.close()

// --- 4. 4D keeps frame zero and reports the total ---------------------------
result = await preview(documentURL(base, 'series.nii'), 'series.nii')
meta = result.message?.metadata ?? {}
check(
  'a 4D file loads',
  result.message?.stage === 'loaded',
  result.message?.stage,
)
check('it reports one frame of seven', meta.frames === '1 of 7', meta.frames)
check('and still renders', meta.displayable === 'true', meta.displayable)
await result.page.close()

// --- 5. Loadable but not an ordinary voxel view → metadata, not an error ----
// `flat.nii` has no third dimension and `truncated.nii` is short of voxel data;
// both parse, so their headers are worth showing rather than discarding behind
// an error.
for (const file of ['flat.nii', 'truncated.nii']) {
  result = await preview(documentURL(base, file), file)
  meta = result.message?.metadata ?? {}
  const shown = await result.page.locator('#meta').innerText()
  check(
    `${file} is not an error`,
    result.message?.stage === 'loaded',
    result.message?.stage,
  )
  check(
    `${file} falls back to metadata`,
    meta.displayable === 'false',
    meta.displayable,
  )
  check(
    `${file} still shows its header`,
    shown.includes(file) && shown.includes('dims'),
    shown.replace(/\n/g, ' | '),
  )
  check(
    `${file} says why there is no image`,
    (await result.page.locator('#fallback-detail').innerText()).length > 0,
  )
  await result.page.close()
}

// A datatype NiiVue refuses outright never becomes a volume, so it cannot reach
// the metadata path — but it must not be reported as a damaged file either.
result = await preview(documentURL(base, 'complex.nii'), 'complex.nii')
check(
  'complex data is unsupported, not unreadable',
  result.message?.code === 'unsupported',
  result.message?.code,
)
check(
  'complex data still shows a panel',
  await result.page.locator('#fallback').isVisible(),
)
await result.page.close()

// --- 6. Malformed input fails visibly, and never blankly -------------------
for (const file of ['empty.nii', 'garbage.nii']) {
  result = await preview(documentURL(base, file), file)
  const panelShown =
    (await result.page.locator('#fallback').isVisible()) ||
    (await result.page.locator('#meta').isVisible())
  check(
    `${file} posts a terminal message`,
    !!result.message,
    result.message?.code ?? result.message?.stage,
  )
  check(`${file} shows something, never a blank canvas`, panelShown)
  check(
    `${file} does not claim to be displayable`,
    result.message?.metadata?.displayable !== 'true',
  )
  await result.page.close()
}

// --- 7. Native-detected failures render a panel ----------------------------
for (const [code, expect] of [
  ['resource-limit', 'too large'],
  ['unreadable', 'could not be read'],
]) {
  page = await openPreview()
  await page.evaluate((c) => window.niivuePreview.fail(c), code)
  const reported = (await page.evaluate(() => window.__posted)).find(
    (m) => m.stage === 'failed',
  )
  const detail = await page.locator('#fallback-detail').innerText()
  check(
    `fail('${code}') posts its code`,
    reported?.code === code,
    reported?.code,
  )
  check(
    `fail('${code}') explains itself on screen`,
    detail.includes(expect),
    detail,
  )
  await page.close()
}

// --- 8. An unreachable document is reported, not swallowed -----------------
result = await preview(`${base}/fixtures/does-not-exist.nii`, 'gone.nii')
check(
  'an unreadable document posts `unreadable`',
  result.message?.code === 'unreadable',
  result.message?.code,
)
check(
  'the fallback panel is visible',
  await result.page.locator('#fallback').isVisible(),
)
await result.page.close()

// --- 9. Geometry: a synthetic surface renders and reports its counts -------
result = await preview(documentURL(base, 'surface.gii'), 'surface.gii', {
  family: 'mesh',
  fileSize: 900,
})
meta = result.message?.metadata ?? {}
check(
  'a GIFTI surface loads',
  result.message?.stage === 'loaded',
  result.message?.stage,
)
check('it is displayable', meta.displayable === 'true', meta.displayable)
check('it is described as a surface', meta.kind === 'surface', meta.kind)
check('vertex count is exact', meta.vertices === '6', meta.vertices)
check('triangle count is exact', meta.triangles === '8', meta.triangles)
check('extent is reported in mm', meta.extent === '80×80×80 mm', meta.extent)
check(
  'the render is visible',
  (await quadrantPixels(result.page)).reduce((a, b) => a + b) > 500,
)
await result.page.close()

// --- 10. Layer-only GIFTI: metadata, and no hunt for a companion ----------
result = await preview(documentURL(base, 'layer.gii'), 'layer.gii', {
  family: 'mesh',
})
meta = result.message?.metadata ?? {}
const detail = await result.page.locator('#fallback-detail').innerText()
check(
  'a layer-only GIFTI is not an error',
  result.message?.stage === 'loaded',
  result.message?.stage,
)
check(
  'it falls back to metadata',
  meta.displayable === 'false',
  meta.displayable,
)
check(
  'it says the surface is missing, not that the file is bad',
  /per-vertex data but no surface/.test(detail),
  detail,
)
check('it reports the layer it does have', meta.layers === '1', meta.layers)
await result.page.close()

result = await preview(documentURL(base, 'garbage.mz3'), 'garbage.mz3', {
  family: 'mesh',
})
check(
  'a malformed mesh fails visibly',
  result.message?.stage === 'failed',
  result.message?.code,
)
check('and shows a panel', await result.page.locator('#fallback').isVisible())
await result.page.close()

// --- 11. Real mesh and tract readers, when the LFS fixtures are present ---
if (!existsSync(LFS_MESHES)) {
  console.log(`SKIP  real mesh/tract fixtures — ${LFS_MESHES} not present`)
} else {
  for (const [file, kind] of REAL_MESHES) {
    result = await preview(`${base}/meshes/${file}`, file, { family: 'mesh' })
    meta = result.message?.metadata ?? {}
    const lit = (await quadrantPixels(result.page)).reduce((a, b) => a + b)
    check(
      `${file} loads`,
      result.message?.stage === 'loaded',
      result.message?.stage ?? result.message?.code,
    )
    check(`${file} is a ${kind}`, meta.kind === kind, meta.kind)
    // Two of these bundles sit well off the origin; a render that is fitted but
    // not centred would be off-screen, so this is the check that catches it.
    check(`${file} is visible on screen`, lit > 500, `${lit} lit px`)
    await result.page.close()
  }
}

// --- 11b. A throw mid-draw must still produce ONE terminal message ---------
// The suite tested "at most one" but not "at least one". `settled` used to be
// latched before the drawing work, so a throw in between posted nothing at all,
// permanently disarmed fail(), and left the host completing a blank panel as a
// success. Injected here by removing the canvas the draw path writes to.
page = await openPreview()
await page.evaluate(() => document.getElementById('gl').remove())
await page.evaluate(
  (u) =>
    window.niivuePreview.render({
      url: u,
      displayName: 'basic.nii',
      family: 'volume',
    }),
  documentURL(base, 'basic.nii'),
)
const afterThrow = (await page.evaluate(() => window.__posted)).filter(
  (m) => m.stage === 'loaded' || m.stage === 'failed',
)
check(
  'a throw mid-draw still posts exactly one terminal message',
  afterThrow.length === 1,
  `${afterThrow.length}`,
)
check(
  'and it is not reported as a success',
  afterThrow[0]?.stage === 'failed',
  afterThrow[0]?.stage,
)
await page.close()

// The same injection against a NON-displayable fixture. This is the case the
// check above cannot see: `present` used to post from a `finally`, and a
// `return` from the catch still runs one, so the metadata-only branch posted
// `failed` and then `loaded` on top of it — two terminal messages, the second
// of which reached the native "preview loaded in N ms" timing log.
for (const file of ['truncated.nii', 'layer.gii']) {
  page = await openPreview()
  await page.evaluate(() => document.getElementById('gl').remove())
  await page.evaluate(
    ([u, n, f]) =>
      window.niivuePreview.render({ url: u, displayName: n, family: f }),
    [documentURL(base, file), file, file.endsWith('.gii') ? 'mesh' : 'volume'],
  )
  const terminals = (await page.evaluate(() => window.__posted)).filter(
    (m) => m.stage === 'loaded' || m.stage === 'failed',
  )
  check(
    `${file} posts exactly one terminal message when the draw throws`,
    terminals.length === 1,
    terminals.map((m) => m.stage).join(', '),
  )
  await page.close()
}

// --- 12. Rotatable and resizable ------------------------------------------
result = await preview(documentURL(base, 'surface.gii'), 'surface.gii', {
  family: 'mesh',
})
page = result.page
const before = (await page.locator('#gl').screenshot({ type: 'png' })).toString(
  'base64',
)
const box = await page.locator('#gl').boundingBox()
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.mouse.down()
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(
    box.x + box.width / 2 + i * 8,
    box.y + box.height / 2 + i * 3,
  )
}
await page.mouse.up()
await page.waitForTimeout(300)
const after = (await page.locator('#gl').screenshot({ type: 'png' })).toString(
  'base64',
)
// The drag must reach NiiVue and change the view. Paired with a lit-pixel
// assertion for the same reason the inverse check needed one: "the frame
// changed" is also satisfied by a render that collapsed into noise.
const stillLit = (await quadrantPixels(page)).reduce((a, b) => a + b)
check(
  'a primary drag rotates the render',
  before !== after && stillLit > 500,
  `${stillLit} lit px`,
)

// The drag must NOT be preventDefault'd: the selection WebKit starts is what
// keeps the gesture away from the host window, and suppressing it is what made
// the panel draggable. The tint that selection would otherwise paint is killed
// by `::selection { background: transparent }`, not by preventing it.
const notClaimed = await page.evaluate(() => {
  const gl = document.getElementById('gl')
  const event = new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
  })
  gl.dispatchEvent(event)
  return event.defaultPrevented
})
// EVERY message must echo the host's generation, or one in flight across a
// navigation can complete the next preview. `ready` is included: the host
// injects `window.__qlGeneration` at document start, and a stale `ready` that
// the host could not attribute used to set `pageIsReady` for the wrong request.
{
  // A fresh page: `fail` is a no-op once a preview has settled, which is
  // correct and would make this check vacuous.
  const stampPage = await openPreview()
  const stamping = await stampPage.evaluate(async () => {
    await window.niivuePreview.fail('timeout', 7)
    return window.__posted.map((m) => [m.stage, m.generation ?? null])
  })
  const terminal = stamping.filter(([stage]) => stage !== 'ready')
  const ready = stamping.filter(([stage]) => stage === 'ready')
  check(
    'terminal messages echo the host generation',
    terminal.length === 1 &&
      terminal[0][0] === 'failed' &&
      terminal[0][1] === 7,
    JSON.stringify(terminal),
  )
  // The harness does not inject `__qlGeneration`, so the page falls back to -1
  // and leaves messages unstamped rather than stamping a sentinel the host
  // would reject as stale. That fallback is the behaviour asserted here.
  check(
    'an uninjected page leaves `ready` unstamped rather than sending -1',
    ready.every(([, g]) => g === null),
    JSON.stringify(ready),
  )
  // With the generation injected, `ready` carries it.
  const injected = await openPreview({ generation: 42 })
  const readyStamp = await injected.evaluate(() =>
    window.__posted
      .filter((m) => m.stage === 'ready')
      .map((m) => m.generation ?? null),
  )
  check(
    'an injected page stamps `ready` with its generation',
    readyStamp.length === 1 && readyStamp[0] === 42,
    JSON.stringify(readyStamp),
  )
  await injected.close()
  await stampPage.close()
}

check(
  'the page leaves the default action alone',
  notClaimed === false,
  `defaultPrevented=${notClaimed}`,
)
const selectionPaint = await page.evaluate(() => {
  const probe = document.createElement('div')
  probe.textContent = 'x'
  document.body.append(probe)
  const bg = getComputedStyle(probe, '::selection').backgroundColor
  probe.remove()
  return bg
})
check(
  'and selection is invisible rather than disabled',
  /rgba\(0, 0, 0, 0\)|transparent/.test(selectionPaint),
  selectionPaint,
)

// Belt and braces, and the part that does not depend on how an engine paints a
// selected <canvas>: a selection that does form is torn down immediately. The
// distinction from `user-select: none` is that it is allowed to FORM first —
// that is what absorbs the drag and keeps it away from the host window.
const rangesAfterSelectAll = await page.evaluate(async () => {
  document.execCommand('selectAll')
  // `selectionchange` is dispatched as a task, so the range survives the
  // synchronous turn and is gone by the next one — before paint, which is why
  // there is no visible flash.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return document.getSelection()?.rangeCount ?? -1
})
check(
  'a selection that forms is cleared immediately',
  rangesAfterSelectAll === 0,
  `${rangesAfterSelectAll} ranges`,
)

// Finder resizes the panel freely; the drawing buffer must follow, or the
// render is upscaled and soft.
await page.setViewportSize({ width: 940, height: 700 })
await page.waitForTimeout(400)
const sharp = await page.evaluate(() => {
  const c = document.getElementById('gl')
  const ratio = window.devicePixelRatio || 1
  return {
    backing: [c.width, c.height],
    css: [
      Math.round(c.clientWidth * ratio),
      Math.round(c.clientHeight * ratio),
    ],
  }
})
check(
  'the drawing buffer follows a resize',
  sharp.backing[0] === sharp.css[0] && sharp.backing[1] === sharp.css[1],
  `${sharp.backing} vs ${sharp.css}`,
)
check(
  'and the render survives it',
  (await quadrantPixels(page)).reduce((a, b) => a + b) > 500,
)
await page.close()

check(
  'no unexpected page exceptions',
  pageExceptions.length === 0,
  pageExceptions.slice(0, 2).join(' | '),
)

await browser.close()
server.close()

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
