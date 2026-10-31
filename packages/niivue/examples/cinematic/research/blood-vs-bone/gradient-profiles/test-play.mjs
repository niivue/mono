import assert from 'node:assert/strict'
import { chromium } from '../../node_modules/playwright/index.mjs'

const b = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal'],
})
const p = await b.newPage({ viewport: { width: 800, height: 700 } })
const errors = []
p.on('pageerror', (e) => errors.push(e.message))
p.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
await p.goto(
  'http://localhost:8080/@fs/Users/chris/src/mono/scratch/boundary-study/play.html',
)
await p.waitForFunction(() => window.boundaryStudy?.cr.isConverged, {
  timeout: 60000,
})
const screenshot = () =>
  p.evaluate(() => {
    const { cr } = window.boundaryStudy
    cr.redisplay()
    return cr.canvas.toDataURL()
  })
const before = await screenshot()
await p.selectOption('#profile', 'absolute')
await p.waitForFunction(
  () =>
    window.boundaryStudy.cr.isConverged &&
    !document.getElementById('profile').disabled,
)
const after = await screenshot()
assert.notEqual(before, after)
await p.click('#toggle')
await p.waitForFunction(
  () =>
    window.boundaryStudy.cr.isConverged &&
    !document.getElementById('profile').disabled,
)
assert.equal(await screenshot(), before)
assert.deepEqual(errors, [])
console.log('Interactive profile changes and exact Off restoration: PASS')
await b.close()
