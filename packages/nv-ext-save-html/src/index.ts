/**
 * @niivue/nv-ext-save-html
 *
 * Export a NiiVue scene as a self-contained HTML file with no external
 * dependencies. The generated HTML embeds the complete niivue library
 * and the serialized scene data (volumes, meshes, drawings, settings).
 *
 * Usage:
 * ```ts
 * import NiiVueGPU from '@niivue/niivue';
 * import { saveHTML } from '@niivue/nv-ext-save-html';
 *
 * const nv = new NiiVueGPU();
 * await nv.attachTo('gl1');
 * await nv.loadVolumes([{ url: 'brain.nii.gz' }]);
 *
 * // bundleSource = await fetch('/niivue-standalone.js').then(r => r.text());
 * saveHTML(nv, 'scene.html', { niivueBundleSource: bundleSource });
 * ```
 */

import type NiiVueGPU from '@niivue/niivue'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SaveHTMLOptions {
  /**
   * Fully self-contained niivue ESM bundle as a source code string.
   *
   * The bundle must export `NiiVueGPU` as its **default export** and must
   * have all dependencies (cbor-x, gl-matrix, nifti-reader-js, etc.) inlined.
   *
   * Build one with e.g. `vite build` using `rollupOptions.external: []`.
   */
  niivueBundleSource: string

  /** Canvas element ID in the generated HTML (default: `"gl1"`). */
  canvasId?: string

  /** HTML `<title>` (default: `"NiiVue Scene"`). */
  title?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Compression helpers (Web Streams API — available in all modern browsers)
// ---------------------------------------------------------------------------

/** Gzip-compress a Uint8Array. */
async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('gzip')
  const writer = stream.writable.getWriter()
  writer.write(data)
  writer.close()
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}

// ---------------------------------------------------------------------------
// Encoding / escaping helpers
// ---------------------------------------------------------------------------

/** Encode a Uint8Array to a base-64 string (works in browsers and workers). */
function uint8ToBase64(bytes: Uint8Array): string {
  // Chunk to avoid call-stack overflow with large arrays
  const CHUNK = 0x8000
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)))
  }
  return btoa(parts.join(''))
}

/**
 * Sanitize text so it can safely live inside a `<script type="text/plain">`
 * element. The only dangerous sequence is a literal `</script` (case-
 * insensitive) which would prematurely close the tag.
 */
function sanitizeForScriptTag(text: string): string {
  return text.replace(/<\/script/gi, '<\\/script')
}

/** Escape text for safe inclusion in an HTML element (title, attributes). */
function escapeHTML(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function buildHTML(
  bundleSource: string,
  base64Document: string,
  canvasId: string,
  title: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHTML(title)}</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      width: 100%;
      overflow: hidden;
      background: #000;
      font-family: system-ui, Arial, Helvetica, sans-serif;
      user-select: none;
    }
    main {
      position: relative;
      width: 100%;
      height: 100%;
    }
    canvas {
      position: absolute;
      width: 100%;
      height: 100%;
      cursor: crosshair;
    }
    canvas:focus {
      outline: none;
    }
  </style>
</head>
<body>
  <main>
    <canvas id="${canvasId}"></canvas>
  </main>

  <!-- NiiVue library bundle (inert — not executed by the browser) -->
  <script id="__niivue_bundle__" type="text/plain">
${sanitizeForScriptTag(bundleSource)}
  </script>

  <!-- NVD document data as gzip-compressed, base-64-encoded CBOR (inert) -->
  <script id="__nvd_data__" type="text/plain">
${base64Document}
  </script>

  <!-- Loader: import the bundle, decode the document, restore the scene -->
  <script type="module">
    // 1. Dynamic-import the embedded niivue bundle
    const bundleSrc = document.getElementById("__niivue_bundle__").textContent;
    const blob = new Blob([bundleSrc], { type: "text/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    const niivueModule = await import(blobUrl);
    URL.revokeObjectURL(blobUrl);
    const NiiVueGPU = niivueModule.default ?? niivueModule.NiiVueGPU;

    // 2. Decode base-64, gzip-decompress, and wrap as a File
    const base64 = document.getElementById("__nvd_data__").textContent.trim();
    const raw = atob(base64);
    const compressed = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) compressed[i] = raw.charCodeAt(i);
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(compressed);
    writer.close();
    const bytes = new Uint8Array(await new Response(ds.readable).arrayBuffer());
    const file = new File([bytes], "scene.nvd");

    // 3. Create NiiVue, attach to canvas, and load the document
    const nv = new NiiVueGPU();
    await nv.attachTo("${canvasId}");
    await nv.loadDocument(file);
    // The serialized document has an empty matcap to avoid baking in
    // environment-specific URLs. Restore the default matcap from this bundle.
    if (nv.opts?.matcaps) {
      const defaultMatcap = Object.values(nv.opts.matcaps)[0];
      if (defaultMatcap) await nv.loadMatcap(defaultMatcap);
    }
  </script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a self-contained HTML string that embeds the current NiiVue scene.
 *
 * The returned HTML includes the niivue library and all loaded data (volumes,
 * meshes, drawings, settings). Opening the HTML file in a browser will
 * recreate the scene — no server or external files needed.
 *
 * @param nv      - The NiiVue instance whose scene to export.
 * @param options - See {@link SaveHTMLOptions}.
 * @returns A complete HTML document as a string.
 */
export async function generateHTML(
  nv: NiiVueGPU,
  options: SaveHTMLOptions,
): Promise<string> {
  const {
    niivueBundleSource,
    canvasId = 'gl1',
    title = 'NiiVue Scene',
  } = options

  if (!niivueBundleSource) {
    throw new Error(
      'nv-ext-save-html: niivueBundleSource is required. ' +
        'Provide the full source of a self-contained niivue ESM bundle.',
    )
  }

  // Clear environment-specific matcap URL before serialization.
  // The serialized document should not contain localhost dev-server paths;
  // the standalone bundle's NiiVue instance provides its own default matcap.
  const savedMatcap = nv.volumeMatcap
  nv.model.volume.matcap = ''

  // Serialize the scene to CBOR binary (NVD format)
  const nvdBytes = nv.serializeDocument()

  // Restore the original matcap on the live instance
  nv.model.volume.matcap = savedMatcap

  // Gzip-compress then base-64-encode for embedding
  const compressed = await gzipCompress(nvdBytes)
  const base64 = uint8ToBase64(compressed)

  return buildHTML(niivueBundleSource, base64, canvasId, title)
}

/**
 * Download the current NiiVue scene as a self-contained HTML file.
 *
 * Convenience wrapper around {@link generateHTML} that triggers a browser
 * download.
 *
 * @param nv       - The NiiVue instance whose scene to export.
 * @param filename - Name of the downloaded file (default: `"scene.html"`).
 * @param options  - See {@link SaveHTMLOptions}.
 */
export async function saveHTML(
  nv: NiiVueGPU,
  filename = 'scene.html',
  options: SaveHTMLOptions,
): Promise<void> {
  const html = await generateHTML(nv, options)
  const blob = new Blob([html], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
