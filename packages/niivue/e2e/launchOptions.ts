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
const executablePathOverride: LaunchOptions = process.env
  .PLAYWRIGHT_CHROMIUM_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
  : {}

/**
 * `PLAYWRIGHT_CHROMIUM_CHANNEL=chromium` launches full Chromium (new headless)
 * on the machine's real GPU. The default headless shell only ever gets
 * SwiftShader, even on a physical Mac; full Chromium reaches Metal on the
 * macos runners (issue #199). The SwiftShader flags are dropped in this mode
 * because `--use-angle=swiftshader` would force software rendering anyway.
 * `PLAYWRIGHT_CHROMIUM_PATH` is ignored here: `channel` and `executablePath`
 * conflict.
 *
 * A local run on macOS defaults to this mode: the suite takes seconds on
 * the real GPU and over a minute on SwiftShader. CI and other platforms keep
 * SwiftShader unless the variable is set. Set it to an empty string
 * (`PLAYWRIGHT_CHROMIUM_CHANNEL=`) to run SwiftShader on a Mac, e.g. to check
 * reference images against the renderer CI's Ubuntu job uses.
 */
export const channel =
  process.env.PLAYWRIGHT_CHROMIUM_CHANNEL ??
  (process.platform === 'darwin' && !process.env.CI ? 'chromium' : undefined)
const hardwareGpuLaunchOptions: LaunchOptions = {
  channel,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
}

/** WebGL2 on SwiftShader; recent Chrome gates that software path behind this flag. */
export const defaultLaunchOptions: LaunchOptions = channel
  ? hardwareGpuLaunchOptions
  : { args: ['--enable-unsafe-swiftshader'], ...executablePathOverride }

/**
 * Brings up Dawn on SwiftShader, which is enough to run WebGPU in headless
 * Chromium. The config's default is plain WebGL2-on-SwiftShader, so only the
 * specs that need a GPU adapter pay for this.
 *
 * `--use-vulkan=swiftshader` is what lets a WebGPU canvas present. Without it
 * Chromium cannot allocate the canvas's shared image, destroys the device on
 * the first frame, and every later `onSubmittedWorkDone` rejects with "A valid
 * external Instance reference no longer exists".
 */
const webgpuLaunchOptions: LaunchOptions = channel
  ? hardwareGpuLaunchOptions
  : {
      args: [
        '--enable-unsafe-swiftshader',
        '--enable-unsafe-webgpu',
        '--use-angle=swiftshader',
        '--enable-features=Vulkan',
        '--use-vulkan=swiftshader',
      ],
      ...executablePathOverride,
    }

/**
 * What a spec that needs a GPU adapter passes to `test.use()`. Empty in
 * hardware mode, where the default options already reach the GPU: any
 * `launchOptions` override, even an identical one, puts those specs in their
 * own workers, so every worker launches a second browser and loads NiiVue
 * again partway through the run (about 1.5 s of an 8-worker run).
 */
export const webgpuUse: { launchOptions?: LaunchOptions } = channel
  ? {}
  : { launchOptions: webgpuLaunchOptions }
