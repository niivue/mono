# Audit response (signal feature)

Response to the external review in `audit_temp.md`. Disposition per finding:
**Fixed** (landed + tested), **Discussed** (intentional / deferred with rationale),
or **Ignored**.

## Fixed

1. **High — GitHub Pages `/signals/` path not rewritten.** Fixed.
   `vite.config.examples.ts` now includes `signals` in the `VITE_BASE` rewrite
   list (alongside `volumes`/`meshes`).

2. **High — non-power-of-two spectroscopy O(n²) freeze.** Fixed.
   `deriveSpectroscopySeries` zero-fills the FID to the next power of two
   (`nextPow2`) so the fast radix-2 FFT always runs; the x-axis is computed over
   the padded length. Zero-filling is a standard MRS interpolation step. The
   direct DFT remains only as a correctness fallback for tiny inputs (tests).

3. **High — no caching or decimation.** Fixed (both parts).
   - Caching: `NVModel.derivePlotCached` memoizes each signal's derived plot,
     keyed by its display state (WeakMap, drops with the signal). Repeated graph
     collections during interaction skip the FFT/averaging work.
   - Decimation: `drawDecimatedSeries` renders dense series (more than ~2 samples
     per horizontal pixel) as a per-pixel-column min/max envelope, bounding the
     line buffer to the plot width regardless of sample count.

6. **Medium — merged axes can mix incompatible units.** Fixed.
   `collectSignalGraphData` only merges signals whose axis (label + reversed)
   matches the first loaded signal; incompatible signals are skipped. The window
   is applied only when every merged signal supplied one.

7. **Medium — subpath type exports incomplete.** Fixed.
   `index.webgpu.ts` and `index.webgl2.ts` now export the signal types and
   `SignalFromUrlOptions`, matching the main entry.

8. **Medium — dead/misleading API fields.** Fixed (removed all three).
   `SignalFromUrlOptions.kind`, `NVSignalDisplay.stacked`, and
   `SignalSeries.visible` are removed before they became compatibility debt.
   (Stacked sub-plots remain a possible future feature; it can be reintroduced
   with an implementation rather than as an unused flag.)

9. **Medium — unbounded legend.** Fixed.
   The signal legend is capped (`LEGEND_MAX_ROWS = 12`, further limited by plot
   height); overflow is summarized as a "+N more" row.

10. **Low — `innerHTML` with sidecar-derived labels.** Fixed.
    Both demos use `textContent` for the `signalLocationChange` status line.

12. **Low — save-time array copies.** Fixed.
    `persistence.f32ToBytes` now returns a view (no copy); cbor-x encodes
    synchronously so the buffer is read before it could change. The read side
    (`bytesToF32`) still copies for alignment.

13. **Low — stale feature parity tracking.** Fixed.
    `FEATURE_PARITY.md` section 34 documents the signal data class, readers,
    sidecars, processing, graph mode, persistence, and the open alignment item.

## Discussed (intentional or deferred)

4. **Medium — ambiguous NIfTI double fetch.** Partially addressed; remainder
   deferred. `_dispatchImage` now resolves the sidecar first and routes via MRS
   fields without fetching image bytes, eliminating the fetch for the common
   MRS-by-sidecar case. The remaining content-sniff path still re-reads the file
   in the volume branch; for drag-drop (`File`) this is an in-memory re-read, and
   loading a remote volume by URL through `loadImage` is uncommon (apps call
   `loadVolumes` directly). Full buffer-threading into the loaders is a larger
   refactor deferred as low real-world impact (recorded in `AGENTS.md`).

5. **Medium — `loadImage` replacement semantics for signals.** Intentional;
   documented. Signals deliberately **append** (not replace) so a multi-file
   drag-drop of, e.g., cardiac + respiratory accumulates both. `removeAllSignals()`
   is the explicit way to clear. Volume/mesh replace semantics are unchanged.
   Noted in `AGENTS.md` so it reads as a decision, not an inconsistency.

11. **Low — TSV peak memory.** Deferred. A two-pass/streaming parser would lower
    peak memory for very long recordings, but the current parser is simple and
    correct; the BIDS physio fixtures are small. Recorded as a known optimization.

## Verification

All gates green after the fixes: `nx run niivue:{typecheck,lint,test,build}`,
`bun run check-boundaries`, and `bun run build:examples`. Signal-specific suites
expanded (decimation bound, legend cap added). No GPU resource leak found
(signals are CPU-side typed arrays; removal drops model references and clears the
cursor + plot cache).
