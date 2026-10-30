import { expect, test } from '@playwright/test'

// Issues #442 and #443: the constructor, the volumeMatcap setter and
// loadMatcap resolve a matcap name the same way, case-insensitively, to the
// URL in opts.matcaps. A bare name stored unresolved fails to load and draws
// the default matcap instead.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

test('setter and loadMatcap resolve mixed-case matcap names to their URL', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    // The default instance knows only cortex; register a second matcap.
    const matcaps = {
      cortex: '/src/assets/matcaps/Cortex.jpg',
      shiny: '/src/assets/matcaps/Shiny.jpg',
    }
    const fromOption = new NiiVue({ matcaps, volumeMatcap: 'Shiny' })
      .volumeMatcap

    const nv = new NiiVue({ matcaps })
    const changes: unknown[] = []
    nv.addEventListener('change', (e) => {
      if (e.detail.property === 'volumeMatcap') changes.push(e.detail.value)
    })
    nv.volumeMatcap = 'SHINY'
    const fromSetter = nv.volumeMatcap
    nv.volumeMatcap = 'cortex'
    await nv.loadMatcap('Shiny')
    const fromLoad = nv.volumeMatcap
    return { fromOption, fromSetter, fromLoad, changes }
  })

  expect(r.fromOption).toBe('/src/assets/matcaps/Shiny.jpg')
  expect(r.fromSetter).toBe(r.fromOption)
  expect(r.fromLoad).toBe(r.fromOption)
  expect(r.changes[0]).toBe(r.fromOption)
})
