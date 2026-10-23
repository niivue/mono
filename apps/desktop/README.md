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

### iOS (TestFlight)

```sh
rustup target add aarch64-apple-ios
rustup component add llvm-tools   # needed with Xcode 27, see below
APPLE_DEVELOPMENT_TEAM=<TEAMID> bunx tauri ios build --export-method app-store-connect
```

Sign in to your Apple ID in Xcode → Settings → Accounts first: automatic
signing creates the App Store profile. The build writes
`src-tauri/gen/apple/build/arm64/NeuroVue.ipa` and an `.xcarchive` beside it.
Open the archive in Xcode's Organizer and choose Distribute App → TestFlight to
upload it. Raise `CFBundleVersion` for every upload.

Xcode 27's SwiftPM hides the Swift functions Tauri's Rust code calls. swift-rs
1.0.9+ makes them public again with rustup's `llvm-objcopy`; without
`llvm-tools` the link fails with undefined `_register_plugin` and similar.

### Linux and Windows

Tauri doesn't cross-compile installers, so each OS builds on its own runner.
The `Desktop Build` workflow (`.github/workflows/desktop-build.yml`) builds
unsigned installers on macOS (universal .dmg), Linux (.deb, .rpm, .AppImage)
and Windows (.msi, NSIS .exe) and runs the Rust tests. It runs on PRs that touch
the app and can also be run manually. Download the installers from the run's
artifacts.

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
