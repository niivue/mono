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
  // loadMatcap emits the same change event as the setter (#460).
  expect(r.changes).toEqual([
    r.fromOption,
    '/src/assets/matcaps/Cortex.jpg',
    r.fromOption,
  ])
})

test('the setter changes the rendered matcap of a loaded volume', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const shot = () => page.locator('#matcap-canvas').screenshot()
  // A fixed sleep was too short on the CI runner: wait for the image to change.
  const settled = { timeout: 30_000, intervals: [250] }
  const setMatcap = (name: string) =>
    page.evaluate((n) => {
      ;(window as unknown as { nv: { volumeMatcap: string } }).nv.volumeMatcap =
        n
    }, name)
  await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const canvas = document.createElement('canvas')
    canvas.id = 'matcap-canvas'
    canvas.width = 256
    canvas.height = 256
    document.body.prepend(canvas)
    const nv = new NiiVue({
      backend: 'webgl2',
      matcaps: {
        cortex: '/src/assets/matcaps/Cortex.jpg',
        shiny: '/src/assets/matcaps/Shiny.jpg',
      },
    })
    await nv.attachToCanvas(canvas)
    nv.sliceType = 4 // render: the only view that samples the matcap
    nv.volumeIllumination = 0.5 // unlit volumes never sample the matcap
    await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
    ;(window as unknown as { nv: typeof nv }).nv = nv
  })
  // The reference is taken once two shots in a row agree (the scene is idle).
  let cortex = await shot()
  await expect
    .poll(async () => {
      const next = await shot()
      const same = next.equals(cortex)
      cortex = next
      return same
    }, settled)
    .toBe(true)
  // Mean absolute RGBA difference, decoded in the page (no PNG library).
  const distance = (a: Buffer, b: Buffer) =>
    page.evaluate(
      async ([a64, b64]) => {
        const rgba = async (src: string) => {
          const img = new Image()
          img.src = `data:image/png;base64,${src}`
          await img.decode()
          const c = document.createElement('canvas')
          c.width = img.width
          c.height = img.height
          const ctx = c.getContext('2d') as CanvasRenderingContext2D
          ctx.drawImage(img, 0, 0)
          return ctx.getImageData(0, 0, c.width, c.height).data
        }
        const [x, y] = await Promise.all([rgba(a64), rgba(b64)])
        let sum = 0
        for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i])
        return sum / x.length
      },
      [a.toString('base64'), b.toString('base64')],
    )
  await setMatcap('SHINY')
  await expect
    .poll(async () => (await shot()).equals(cortex), settled)
    .toBe(false)
  const shiny = await shot()
  const away = await distance(shiny, cortex)
  expect(away).toBeGreaterThan(1)
  await setMatcap('Cortex')
  // The CI Metal runner does not redraw the restored matcap byte for byte, so
  // the restored frame must be much closer to Cortex than Shiny was.
  let back = Number.POSITIVE_INFINITY
  let restored = shiny
  await expect
    .poll(async () => {
      restored = await shot()
      back = await distance(restored, cortex)
      return back < away / 10
    }, settled)
    .toBe(true)
    .catch(async (e) => {
      const info = test.info()
      await info.attach('cortex', { body: cortex, contentType: 'image/png' })
      await info.attach('shiny', { body: shiny, contentType: 'image/png' })
      await info.attach('restored', {
        body: restored,
        contentType: 'image/png',
      })
      throw new Error(
        `restored-to-cortex ${back}, shiny-to-cortex ${away}: ${e}`,
      )
    })
  console.log(
    `matcap distances: shiny ${away.toFixed(2)}, restored ${back.toFixed(3)}`,
  )
})
