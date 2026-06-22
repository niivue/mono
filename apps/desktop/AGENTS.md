# AGENTS.md

Guidance for agents (and humans) working in this repo.

## What this is

NeuroVue is a [Tauri v2](https://tauri.app) desktop app for viewing NIfTI brain
volumes. Frontend is React + TypeScript (`src/`) rendering with
[`@niivue/niivue`](https://github.com/niivue/niivue); the Rust backend
(`src-tauri/src/`) embeds a local axum HTTP server that serves volumes, IIIF
image previews, and a multi-resolution pyramid, and exposes Tauri commands.

## Mobile portability is a hard constraint

**Goal: ship iPhone and iPad apps from this same codebase.** The project is
already structurally mobile-capable (Tauri v2, `mobile_entry_point` in
`src-tauri/src/lib.rs`, `staticlib`/`cdylib` crate types). Do **not** introduce
designs or implementations that would prevent an iOS/iPadOS build, and prefer
choices that keep that path open. Concretely:

- **Keep the data transport swappable.** The embedded `127.0.0.1` HTTP server is
  a desktop convenience; on iOS the idiomatic path is a custom protocol / IPC
  (cleartext HTTP is blocked by App Transport Security and sockets are subject to
  app lifecycle). Access server data through the existing `serverUrl` + `fetch`
  seam and avoid HTTP-only semantics (range requests, `Cache-Control` reliance,
  multiple ports) that a custom protocol couldn't replicate.
- **Subprocess features stay desktop-only and optional.** iOS forbids spawning
  external executables/PTYs, so the Python terminal (`portable-pty`) and the
  niimath sidecar binary cannot run there. Keep them feature-gated
  (`#[cfg(desktop)]`), keep their deps desktop-only, and never make them
  load-bearing in a core flow.
- **Don't assume arbitrary filesystem access.** iOS sandboxes the filesystem
  (document-picker URLs / security-scoped bookmarks, not free `canonicalize()`
  of absolute paths). Keep dataset acquisition behind an abstraction.
- **WebGL2 is the guaranteed baseline; WebGPU is progressive enhancement.** iOS
  WebGPU support is thin. Preserve the `navigator.gpu` → WebGL2 fallback (see
  `preferredBackend()`); do not adopt WebGPU-only niivue features.
- **Every interaction needs a touch path.** Pointer events already cover touch —
  keep using them. No hover-only or wheel-only controls: wheel-zoom and
  hover-reveal affordances must have pinch/tap equivalents.
- **Layout stays responsive.** iPhone is small, iPad is ~desktop. Don't make
  fixed desktop pixel dimensions load-bearing; keep panels collapsible/adaptive.
- **Keep memory bounded.** iOS kills memory-hungry apps. Maintain the source
  voxel ceiling and cache budgets, and keep their limits env-overridable so
  mobile can run tighter.

When a proposed change would trade away mobile portability, call it out and
prefer the portable option.
