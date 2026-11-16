import { expect, test } from 'bun:test'
import type NiiVue from '@niivue/niivue'
import { joinSyncGroups } from './viewportSync'

// Records each pane's broadcast targets.
const pane = () => {
  const p = {
    targets: [] as unknown[],
    broadcastTo: (t?: unknown[]) => {
      p.targets = t ?? []
    },
  }
  return p as typeof p & NiiVue
}

test('panes in one VOI group broadcast to each other; others stay out', () => {
  const voi = [
    { type: 'voi', id: 'mpr' },
    { type: 'hydrateseg', id: 'sameFOR' },
  ]
  const [ax, cor, vr] = [pane(), pane(), pane()]
  const leaveAx = joinSyncGroups('ax', ax, voi)
  joinSyncGroups('cor', cor, voi)
  joinSyncGroups('vr', vr, [{ type: 'hydrateseg', id: 'sameFOR' }])
  expect(ax.targets).toEqual([cor])
  expect(cor.targets).toEqual([ax])
  expect(vr.targets).toEqual([])
  leaveAx()
  expect(cor.targets).toEqual([])
})
