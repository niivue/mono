# demo-ext-fullstack

Minimal full-stack demo showing how to combine NiiVue (in the browser) with niimath (a portable, server-side native binary) for image processing. While niimath itself can run in WASM (see https://niivue.github.io/niivue-niimath/), this example intentionally uses a backend to mirror how users typically integrate platform-specific neuroimaging tools (e.g., FSL, FreeSurfer) that run in Unix-based cloud environments rather than on local machines.

Because niimath is cross-platform (Windows, macOS, Linux), this demo runs anywhere while illustrating the pattern: offload processing to a server you control and tune for your own cloud or HPC setup.

Select a built-in sample volume or upload your own NIfTI file, construct a niimath pipeline (e.g., -s 3 -thr 0.5 -bin), reorder operations via drag-and-drop, and click Run on server. The processed output is returned and displayed in the viewer as a preview. To continue building on the result, use Apply result as input in the Current Image panel to chain additional processing steps.

The whole stack is two processes:

| Process    | Port | What it does                                                      |
|------------|------|-------------------------------------------------------------------|
| Vite       | 8088 | Serves the frontend + `@niivue/dev-images` sample volumes         |
| Bun server | 8087 | Receives uploads, spawns `niimath`, returns the processed file    |

No database, no auth, no Docker. Runs on macOS, Linux, and Windows from a
single Bun command. Job history is in-memory and cleared on server restart.

## One-time setup

The server uses the prebuilt `niimath` binary from the
[rordenlab/niimath releases](https://github.com/rordenlab/niimath/releases).
Fetch it for your platform:

```bash
bunx nx run demo-ext-fullstack:setup
```

That downloads the right zip (`niimath_macos.zip` / `niimath_lnx.zip` /
`niimath_win.zip`), extracts the binary into
`apps/demo-ext-fullstack/server/bin/`, and writes a small `manifest.json`
recording which release was installed. The directory is gitignored.

## Run

```bash
bunx nx dev demo-ext-fullstack
```

Starts both the Bun API server (port 8087) and the Vite dev server (port 8088,
auto-opens). Vite proxies `/api/*` to the backend so the frontend uses a single
origin. The dev script tears down both children if either one crashes, so you
won't end up with an orphan process bound to either port.

To run them separately:

```bash
bunx nx run demo-ext-fullstack:server      # API only
bunx nx run demo-ext-fullstack:frontend    # Vite only — `bun run frontend`
```

## How it works

1. Frontend builds an array of niimath args (e.g. `["-s", "3", "-bin"]`)
   from the sidebar UI. Operations can be reordered by drag-and-drop and the
   generated command is displayed live above the **Run** button (click either
   the command or the status bar to copy).
2. On **Run**, the current volume is sent as a raw body to `POST /api/process`
   with `X-Niimath-Filename` and `X-Niimath-Args` headers (see API below for
   why this isn't multipart).
3. The server writes the upload to `os.tmpdir()/niivue-fullstack-demo/`, spawns
   `niimath <input> <args...> <output>` with `FSLOUTPUTTYPE=NIFTI_GZ`, and
   returns `{id, resultUrl, command, durationMs}`.
4. The frontend points NiiVue at `resultUrl` and shows the result as a
   *preview* — `currentSource` (the input runs operate on) stays unchanged,
   so reordering or editing pipeline steps re-runs against the same source
   instead of chaining onto the previous result. Click **Apply result as
   input** on the Current Image panel to promote the preview to the working
   input. Subsequent runs then re-fetch from the server rather than
   re-uploading the in-browser blob, which keeps chains byte-stable
   (NiiVue's loader can detach the Blob's backing buffer on worker transfer).
5. The **Save to disk** button on the Current Image panel triggers a normal
   browser download for whatever's currently displayed (sample, upload, or
   the latest server result).

## API

| Method | Path                  | Purpose                                       |
|--------|-----------------------|-----------------------------------------------|
| GET    | `/api/health`         | Server status + which niimath release is in use |
| POST   | `/api/process`        | Raw NIfTI body, headers `X-Niimath-Filename` (URL-encoded) and `X-Niimath-Args` (JSON string array). Runs niimath. |
| GET    | `/api/result/:id`     | Streams the processed NIfTI back              |
| GET    | `/api/jobs`           | In-memory history `{jobs: Job[]}`             |

The upload endpoint deliberately avoids `multipart/form-data`. Bun's
`req.formData()` intermittently rejects browser-built multipart bodies as
"missing final boundary" on larger files; raw body + headers is a much smaller
surface to break and lets `fetch` stream the Blob rather than buffer the whole
thing in JS. The Bun server sets `idleTimeout: 240` (Bun's default of 10s
drops slow ops; 255s is the cap) and the Vite proxy disables its own timeout
so heavy pipelines don't get hung up at either hop.

## Security note

This demo runs niimath with caller-supplied argument arrays. A handful of
cheap defences are in place so a malicious page in another tab — or another
machine on the same Wi-Fi — can't abuse the running dev server:

- **Loopback bind.** The Bun server listens on `127.0.0.1:8087`, not
  `0.0.0.0`, so the API isn't reachable from the LAN even when the laptop
  is on a coffee-shop network. Override with `FULLSTACK_SERVER_HOST` if you
  really do need to expose it.
- **No CORS headers.** The Vite dev server proxies `/api/*` so the frontend
  hits the API same-origin; cross-origin requests from other tabs get no
  `Access-Control-Allow-Origin` back, so browsers won't let scripts read
  `/api/jobs` or `/api/result/<id>`.
- **Argument validator.** Every entry in `X-Niimath-Args` must be either a
  niimath flag (`-foo`) or a plain number. Stops `["-add","/etc/passwd"]`
  style attacks where a niimath operator that accepts "value or filename"
  gets steered into reading off-disk files.
- **Body size cap.** Uploads larger than 2 GiB are rejected with `413`.
  Checked twice — once against `Content-Length` before reading, once
  against the buffered size after, so chunked uploads can't slip past.
- **Input cleanup.** Each upload is unlinked from the work dir as soon as
  niimath returns. Outputs stick around so `/api/result/:id` and the
  history reload button keep working until the server restarts.

It is still a **localhost convenience** — don't expose the API to an
untrusted network without adding auth, request limits, and persistent
output cleanup.

## What's deliberately missing

This demo intentionally drops most of what a "real" fullstack app needs, so the
plumbing between NiiVue and a native processing binary is the only thing on
display: no database, no users/auth, no scenes table, no history persistence,
no Docker, no nginx, no migration tooling. The
[`fullstack-niivue-demo`](https://github.com/niivue/niivue-fullstack-demo)
showcases those pieces.
