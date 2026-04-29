# NiiVueKit bundled web app

This directory is populated by [`scripts/build-web.sh`](../../../scripts/build-web.sh). **The contents are not tracked in git** (except for this README).

Why: the web bundle is a generated artifact (~900 KB of minified JS, content-hashed filenames). Committing it would bloat history on every rebuild. Consumers of `NiiVueKit` who want `BridgeConfig.niiVueKitBundled` to work must run the build script once locally (or in CI before `swift build`).

## Populating

From the repo root:

```bash
packages/niivue-swift/scripts/build-web.sh
```

That builds `medgfx-web` (which in turn builds `@niivue/web-bridge` and the niivue library) and rsyncs `apps/medgfx/web/dist/` into this directory, preserving this README.

## Consuming

After the script runs, `Resources/WebApp/` contains `index.html` + `assets/`. `BridgeConfig.niiVueKitBundled` (a preset in `NiiVueKit/BridgeConfig+Bundled.swift`) wires `WebAssetHandler` to `Bundle.module`, so the bundle is served under the `niivue-app://` scheme.

If this directory is empty (only this README present), `BridgeConfig.niiVueKitBundled` will surface a 404 at the `niivue-app://app/index.html` request and the web view will stay blank. That's the signal to run `build-web.sh`.

## Not using `niiVueKitBundled`?

If the consumer app ships its own web bundle via a Run Script phase (the `apps/medgfx/` pattern), leaving this directory empty is fine -- the app uses `BridgeConfig.default` with `Bundle.main`, not `Bundle.module`.
