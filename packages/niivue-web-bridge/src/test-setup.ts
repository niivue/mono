/**
 * Test setup: map `window` to `globalThis` so the bridge's browser-flavoured
 * `resolveNativeSink` works under the Bun test runner. Loaded via
 * `bunfig.toml` [test] preload.
 */

// biome-ignore lint/suspicious/noExplicitAny: setup shim
;(globalThis as any).window = globalThis
