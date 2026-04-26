# Known issues

## JS → Python comm routing failure (unresolved)

In the test environment used during development, JS-to-Python message
routing is unreliable.

**Environment**: Python 3.13.2 (pyenv), jupyterlab 4.4.10, ipywidgets
8.1.8, anywidget 0.9.19, Chrome and Safari (both tested fresh and in
Incognito with cleared caches), JupyterLab launched from
`packages/ipyniivue` after `pip install -e .`.

**Symptom**: Calls like `await nv.wait_ready()`, `await
nv.get_crosshair_pos()`, and event subscriptions via `nv.on(...)` never
return / never fire. Browser DevTools eventually shows:

```
Could not send widget sync message Error: Cannot send
    at Comm.send (services-shim.ts:246)
    at AnyModel.send_sync_message (widget.ts:614)
    at AnyModel.save_changes (widget.ts:643)
    at sendToPython (widget.js:...)
    at R.handler (widget.js:...)
    at R.emit (widget.js:...)
    at R.setClipPlaneDepthAziElev / canvasResize / etc.
```

`Comm.send` throws because `is_open === false` — the comm has been
closed. Both available JS-to-Python channels (`model.send` and
`model.set` + state-update) ultimately route through the same comm, so
both paths fail.

## What we ruled out

- **Browser cache**: confirmed via file-on-disk size + token presence
  diagnostic that the latest `widget.js` was loaded; tested in Incognito
  on two browsers with cleared site data.
- **anywidget version**: 0.10.0 changelog has no relevant changes — only
  drops Python 3.8/3.9. Same library version that the upstream
  `niivue/ipyniivue` uses successfully.
- **ipywidgets / JupyterLab versions**: 8.1.8 / 4.4.10 are current.
- **Python observer registration**: tested both bound-method and closure
  patterns; local pure-Python tests of the round-trip pass.
- **Event flood**: ruled out by skipping `canvasResize`, `viewAttached`,
  `viewDestroyed`, which fire at 60Hz during mount and would otherwise
  saturate the WebSocket.
- **Lifecycle pattern**: refactored to anywidget's recommended
  `initialize` + `render` split, matching upstream `niivue/ipyniivue`.

## What works

- TypeScript-driven codegen (76 reactive properties + 11 read-only + 83
  methods + 28 events; checked-in JSON descriptor).
- Self-contained `widget.js` bundle (~1.1 MB, niivue ESM + Ubuntu.png
  font atlas + Cortex.jpg matcap inlined).
- WebGPU canvas mounts in JupyterLab; if `add_volume_from_url(...)` is
  called soon after display (before the comm dies), the volume renders.
- Constructor overrides: `NiiVue(slice_type=4, is_colorbar_visible=True)`.
- Initial state seed from JS to Python on attach (`nv.azimuth` reflects
  NiiVue's real default).
- Python → JS reactive writes (e.g. `nv.is_colorbar_visible = False`
  toggles the colorbar in real time).

## What doesn't work

- Round-trip request/response (`wait_ready`, async value-returning
  methods).
- NiiVue → Python event subscriptions.

## Suggested next steps

1. Reproduce on a different host / Python install (fresh conda env)
   to isolate environment factors.
2. Capture Jupyter server-side logs during a failed round-trip to see
   whether the JS WebSocket frames arrive at the kernel at all, or are
   being closed before delivery.
3. Diff CommManager state at runtime against the upstream
   `niivue/ipyniivue` widget (which uses the same anywidget version and
   works in production).
4. Consider pivoting the codegen to emit Python that imports/extends
   `niivue/ipyniivue`'s widget classes (a thin wrapper rather than a
   parallel implementation), inheriting its proven comm protocol.

## Defensive scaffolding left in place

- **`_msg_outbox` synthetic traitlet** (`_generated.py`): JS-to-Python
  relay via state-update, designed to bypass `model.send`. Currently
  unreliable for the same comm-level reason but harmless and can be
  removed once the underlying issue is understood.
- **`SKIP_EVENT_FORWARDING` set** (`widget.js`): excludes the three
  60Hz internal events that would otherwise overload the WebSocket.
- **`wait_ready(timeout=...)`** with caller-side `asyncio.wait_for`
  pattern documented in the smoke notebook so tests fail fast instead
  of hanging.
- **`initialize` + `render` lifecycle split** matching anywidget's
  recommended pattern.
