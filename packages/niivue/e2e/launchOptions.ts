import type { LaunchOptions } from '@playwright/test'

// `use.launchOptions` REPLACES the config's object rather than merging into it,
// so a spec that adds its own flags drops whatever the config set. Everything
// that has to survive that lives here, in one place, rather than being copied
// into each spec and forgotten by the next one.

/**
 * Opt-in escape hatch for a machine that has a headless shell but not
 * Playwright's exact pinned revision (a 92 MB download). Unset in CI, so the
 * pinned browser is still what gates a PR.
 */
export const executablePathOverride: LaunchOptions = process.env
  .PLAYWRIGHT_CHROMIUM_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
  : {}

/**
 * Brings up Dawn on SwiftShader, which is enough to run WebGPU in headless
 * Chromium. The config's default is plain WebGL2-on-SwiftShader, so only the
 * specs that need a GPU adapter pay for this.
 */
export const webgpuLaunchOptions: LaunchOptions = {
  args: [
    '--enable-unsafe-swiftshader',
    '--enable-unsafe-webgpu',
    '--use-angle=swiftshader',
    '--enable-features=Vulkan',
  ],
  ...executablePathOverride,
}
