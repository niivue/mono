/**
 * The smallest `View` a handler test can start from: one volume 200 mm
 * across centred on the origin, no clip plane, and mocks for the members
 * every handler touches. A test adds the optional members it exercises.
 */

import { mock } from 'bun:test'
import type { NiiVueHost, View } from '../browser/view'
import { PLANE_NONE } from '../planes'

/** A view with `overrides` on top of the base. */
export function baseView(overrides: Partial<View> = {}): View {
  const view: View = {
    canvas: null,
    volumes: [{ name: 'mni152.nii.gz', id: 'v0' }],
    azimuth: 110,
    elevation: 15,
    crosshairPos: new Float32Array([0.5, 0.5, 0.5]),
    getCrosshairPos: () =>
      Array.from(view.crosshairPos).map((f) => (f - 0.5) * 200),
    getClipPlaneDepthAziElev: mock(
      () => [PLANE_NONE, 0, 0] as [number, number, number],
    ),
    setClipPlane: mock(),
    loadVolumes: mock(async () => {}),
    addVolume: mock(async () => {}),
    drawScene: mock(),
    model: {
      mm2scene: (mm) => mm.map((v) => v / 200 + 0.5),
      scene2mm: (frac) => frac.map((f) => (f - 0.5) * 200),
    },
    ...overrides,
  }
  return view
}

/** A host over `view` that counts how often an answer was prepared. */
export function hostOf(view: View): NiiVueHost & { prepared: number } {
  const host = {
    view,
    prepared: 0,
    beforeAnswer() {
      host.prepared += 1
    },
  }
  return host
}
