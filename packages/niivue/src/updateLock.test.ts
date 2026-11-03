// The GPU update lock (#273, #447): coalesced callers, view takeover and destroy,
// against a fake view whose updateBindGroups waits on a gate opened by hand.

import { expect, mock, test } from 'bun:test'

for (const w of ['volumeLoad', 'omeZarrChunk', 'transform'])
  mock.module(`@/workers/${w}.worker?worker&inline`, () => ({
    default: class {},
  }))
const { default: NiiVue } = await import('@/NVControlBase')

type Gate = { p: Promise<void>; open: () => void; fail: (e: Error) => void }
function gate(): Gate {
  let open = () => {}
  let fail: (e: Error) => void = () => {}
  const p = new Promise<void>((resolve, reject) => {
    open = resolve
    fail = reject
  })
  return { p, open, fail }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

type Internals = {
  view: unknown
  drawScene: () => void
  _viewLifecycle: unknown
  _rebuildViewResources: () => Promise<void>
  updateVolumeAffineOnly: () => Promise<void>
}

function rig() {
  // No view lifecycle: each test installs a fake view by hand.
  const nv = new NiiVue({}, undefined as never)
  const internals = nv as unknown as Internals
  const gates: Gate[] = []
  const log: string[] = []
  internals.view = {
    updateBindGroups: async () => {
      const g = gate()
      gates.push(g)
      const n = gates.length
      log.push(`start ${n}`)
      await g.p
      log.push(`end ${n}`)
    },
  }
  internals.drawScene = () => {}
  const track = (name: string, p: Promise<unknown>) =>
    p.then(
      () => log.push(`${name} ok`),
      (e: Error) => log.push(`${name} ${e.message}`),
    )
  return { nv, internals, gates, log, track }
}

test('a queued caller settles with its own pass, not the follow-ups after it', async () => {
  const { nv, gates, log, track } = rig()
  track('A', nv.updateGLVolume())
  track('B', nv.updateGLVolume())
  await tick()
  gates[0].open() // the follow-up carrying B starts
  await tick()
  track('C', nv.updateGLVolume())
  await tick()
  gates[1].open() // B's pass finishes; C's starts
  await tick()
  expect(log).toContain('B ok')
  expect(log).not.toContain('end 3')
  gates[2].open()
  await tick()
  expect(log).toContain('C ok')
})

test('a rebuild on the same view leaves a settled caller with its own outcome', async () => {
  const { nv, internals, gates, log, track } = rig()
  track('A', nv.updateGLVolume())
  track('B', nv.updateGLVolume())
  await tick()
  gates[0].open()
  await tick()
  track('rebuild', internals._rebuildViewResources())
  await tick()
  gates[1].open() // B's pass succeeds, then the rebuild takes the lock
  await tick()
  gates[2].fail(new Error('rebuild failed'))
  await tick()
  expect(log).toContain('B ok')
  expect(log).toContain('rebuild rebuild failed')
})

test('an affine-only rerun fails its queued caller, not the first', async () => {
  const { internals, gates, log, track } = rig()
  track('A', internals.updateVolumeAffineOnly())
  track('B', internals.updateVolumeAffineOnly())
  await tick()
  gates[0].open()
  await tick()
  gates[1].fail(new Error('rerun failed'))
  await tick()
  expect(log).toContain('A ok')
  expect(log).toContain('B rerun failed')
})

test('destroy releases callers and runs no follow-up on the destroyed view', async () => {
  const { nv, internals, gates, log, track } = rig()
  track('A', nv.updateGLVolume())
  track('B', nv.updateGLVolume())
  await tick()
  gates[0].open()
  await tick()
  track('settle', nv.whenUpdatesSettle())
  internals._viewLifecycle = {}
  internals.view = {
    destroy() {},
    updateBindGroups: async () => {
      log.push('post-destroy rebuild')
    },
  }
  nv.destroy()
  track('late', nv.updateGLVolume())
  gates[1].open()
  await tick()
  await tick()
  expect(log).toContain('B ok')
  expect(log).toContain('settle ok')
  expect(log).not.toContain('post-destroy rebuild')
})

test('whenUpdatesSettle is not held by updates that arrive after it', async () => {
  const { nv, gates, log, track } = rig()
  nv.updateGLVolume()
  nv.updateGLVolume() // queued: whenUpdatesSettle joins its follow-up
  track('settle', nv.whenUpdatesSettle())
  for (let n = 0; n < 5; n++) {
    nv.updateGLVolume()
    await tick()
    for (const g of gates) g.open()
    await tick()
  }
  expect(log).toContain('settle ok')
  for (const g of gates) g.open()
})
