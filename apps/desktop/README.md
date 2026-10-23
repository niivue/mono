# NeuroVue

NeuroVue is a lightweight viewer app for neuroimaging workflow previews. It is
modeled on the OSD volume desktop and the IIIF volumetric server, but the app
shell and local data server are Rust/Tauri.

The intended split is:

- Rust local server: IIIF desktop manifests, volume metadata, raw NIfTI bytes,
  session patch files, and future OME-Zarr/tract/mesh routes.
- Web viewer: OSD-style dataset browsing plus NiiVue WebGPU/WebGL rendering.
- Tauri wrapper: native file access, session lifecycle, and app windows.

## Development

Lives in the mono workspace at `apps/desktop` (nx project `neurovue`).

```sh
bun install                    # from the monorepo root
bunx nx tauri-dev neurovue     # desktop app with live reload
bunx nx tauri-build neurovue   # release .app / .dmg
```

The nx targets build `@niivue/niivue` first (`dependsOn: ["^build"]`), so the app
always picks up a fresh niivue `dist/`.

`tauri dev` and `tauri build` prepare a Tauri sidecar for
`niimath` by downloading the latest platform release from
`rordenlab/niimath`. To refresh an already staged binary, run:

```sh
bun run ensure-niimath --force
```

### macOS release build

`bun run tauri:build:mac` builds a universal (Apple silicon + Intel) app and
`.dmg`. Run `rustup target add x86_64-apple-darwin` once first. Signing and
notarization come from the environment, so nothing personal lives in the repo:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
# Notarization (optional; skipped with a warning when unset), either:
export APPLE_ID=... APPLE_PASSWORD=<app-specific password> APPLE_TEAM_ID=<TEAMID>
# or an App Store Connect API key:
export APPLE_API_KEY=... APPLE_API_ISSUER=... APPLE_API_KEY_PATH=...
bun run tauri:build:mac
```

Output lands in `src-tauri/target/universal-apple-darwin/release/bundle/`.
Without notarization, Gatekeeper blocks the app on other Macs.

The Tauri host starts a local server and the viewer asks the host for its URL.
In browser-only Vite development, the app falls back to
`http://127.0.0.1:8087`, which is the current OSD/IIIF reference server.

## Reference Contract

NeuroVue starts with the same core endpoints used by the OSD desktop:

- `GET /api`
- `GET /iiif/desktop`
- `GET /iiif/desktop/neuro/manifest`
- `GET /iiif/image/{volume}/{axis}/{slice}/info.json`
- `GET /iiif/image/{volume}/{axis}/{slice}/{region}/{size}/{rotation}/{quality}.{format}`
- `GET /volumes/{volume}/metadata`
- `GET /volumes/{volume}/raw.nii.gz`

The initial Rust server includes a compatibility shim and serves a local MNI152
sample when one is discoverable from the NiiVue checkouts.
