import { expect, test } from 'bun:test'
import {
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
import { niivueSegmentationDataset } from './segCommands'

// RT panes draw nested ROIs over larger ones and leave hidden ROIs out.
test('an RT pane saved as SEG keeps nested and hidden ROIs whole', async () => {
  const img = new Uint8Array(16)
  const paint = (shown: Set<number>) => {
    img.fill(shown.has(1) ? 1 : 0)
    if (shown.has(2)) for (const i of [5, 6, 9, 10]) img[i] = 2
  }
  const shownLog: number[][] = []
  const nv = {
    drawingVolume: { img },
    volumes: [{ dimsRAS: [3, 4, 4, 1] }],
    vox2mm: ([x, y, z]: number[]) => [-(x as number), -(y as number), z],
  }
  registerNiivue('rt', nv as never)
  updateNiivueViewport('rt', {
    displaySets: [
      {
        instances: [
          {
            SOPInstanceUID: '1',
            SeriesInstanceUID: 's',
            ImagePositionPatient: [0, 0, 0],
            ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
            PixelSpacing: [1, 1],
            Rows: 4,
            Columns: 4,
          },
        ],
      },
    ] as never,
  })
  const row = (value: number, visible: boolean) => ({
    value,
    label: `r${value}`,
    rgb: [255, 0, 0],
    visible,
  })
  const pane = {
    viewportId: 'rt',
    seg: {},
    rt: {
      showOnly: (s: Set<number>) => {
        shownLog.push([...s])
        paint(s)
      },
    },
    rows: () => [row(1, true), row(2, false)],
  }
  paint(new Set([1]))
  try {
    const ds = await niivueSegmentationDataset(pane as never, 'SEG', 'x')
    const bits = new Uint8Array(ds?.PixelData as ArrayBuffer)
    const set = (from: number, n: number) => {
      let c = 0
      for (let b = from; b < from + n; b++)
        c += ((bits[b >> 3] as number) >> (b & 7)) & 1
      return c
    }
    expect(ds?.NumberOfFrames).toBe(2)
    expect([set(0, 16), set(16, 16)]).toEqual([16, 4])
    expect(shownLog.at(-1)).toEqual([1])
  } finally {
    unregisterNiivue('rt')
  }
})
