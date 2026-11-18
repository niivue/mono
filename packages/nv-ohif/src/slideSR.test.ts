import { expect, test } from 'bun:test'
import dcmjs from 'dcmjs'
import { buildSlideSR, routeSlideSR } from './slideSR'

// A rotated slide (rows run along -x, columns along -y) with unequal spacing,
// so a swapped orientation or spacing index moves every point.
const sm = {
  SOPClassUID: '1.2.840.10008.5.1.4.1.1.77.1.6',
  SOPInstanceUID: '1.2.3.1',
  SeriesInstanceUID: '1.2.3',
  StudyInstanceUID: '1.2',
  FrameOfReferenceUID: '1.2.9',
  PatientID: 'P',
  TotalPixelMatrixOriginSequence: [
    { XOffsetInSlideCoordinateSystem: 10, YOffsetInSlideCoordinateSystem: 20 },
  ],
  ImageOrientationSlide: [0, -1, 0, -1, 0, 0],
  SharedFunctionalGroupsSequence: [
    { PixelMeasuresSequence: [{ PixelSpacing: [0.0005, 0.00025] }] },
  ],
}

test('slide line and polygon rows write SCOORD3D that loadSR reads back', async () => {
  const rows = [
    {
      uid: 'niivue-slide-1-1',
      label: 'cut',
      points: [
        [100.5, 200.5, 0],
        [300.5, 200.5, 0],
      ],
      data: { length: 50, unit: 'µm' },
      metadata: { slideTool: 'line' },
    },
    {
      uid: 'niivue-slide-1-2',
      label: 'gland',
      points: [
        [0.5, 0.5, 0],
        [40.5, 0.5, 0],
        [0.5, 20.5, 0],
      ],
      metadata: { slideTool: 'polygon' },
    },
  ]
  const ds = buildSlideSR(rows, () => sm, { SeriesDescription: 'slide' })
  const { DicomMessage, DicomMetaDictionary } = dcmjs.data
  const back = DicomMetaDictionary.naturalizeDataset(
    DicomMessage.readFile(dcmjs.data.datasetToDict(ds).write()).dict,
  )
  // Hand-computed: x = 10 - 0.0005 (r - 0.5), y = 20 - 0.00025 (c - 0.5),
  // stored as GraphicData's float32.
  const f = (...p: number[]) => p.map(Math.fround)
  const state =
    dcmjs.adapters.DICOMMicroscopyViewer.MeasurementReport.generateToolState(
      back,
    )
  expect(state.Polyline).toEqual([[f(9.9, 19.975, 0), f(9.9, 19.925, 0)]])
  expect(state.Polygon).toEqual([
    [f(10, 20, 0), f(10, 19.99, 0), f(9.99, 20, 0), f(10, 20, 0)],
  ])
  // What the SR SOP handler and loadSR read: frame of reference and labels.
  const groups = back.ContentSequence.find(
    (c: { ConceptNameCodeSequence: { CodeValue: string } }) =>
      c.ConceptNameCodeSequence.CodeValue === '126010',
  ).ContentSequence
  const find = (g: { ContentSequence: unknown[] }, code: string) =>
    (
      g.ContentSequence as {
        ConceptNameCodeSequence: { CodeValue: string }
        ReferencedFrameOfReferenceUID?: string
        ConceptCodeSequence?: { CodeValue: string }
      }[]
    ).find((c) => c.ConceptNameCodeSequence.CodeValue === code)
  expect(find(groups[0], '111030')?.ReferencedFrameOfReferenceUID).toBe('1.2.9')
  expect(
    groups.map(
      (g: { ContentSequence: unknown[] }) =>
        find(g, '121071')?.ConceptCodeSequence?.CodeValue,
    ),
  ).toEqual(['cut', 'gland'])
})

test('the SR save wrapper takes slide rows and hands other saves to OHIF', async () => {
  const contexts: Record<string, { commandFn: (o: object) => unknown }> = {
    storeMeasurements: { commandFn: () => 'cornerstone' },
  }
  const stored: unknown[] = []
  const commands = {
    getCommand: (name: string) => contexts[name],
    registerCommand: (_c: string, name: string, def: never) => {
      contexts[name] = def
    },
    runCommand: () => async (ds: unknown) => stored.push(ds),
  }
  routeSlideSR(commands as never, () => sm)
  routeSlideSR(commands as never, () => sm) // a second slide pane: not wrapped twice
  const save = (uid: string) =>
    contexts.storeMeasurements?.commandFn({
      measurementData: [{ uid, points: [[1, 1, 0]] }],
      dataSource: 'download',
    })
  expect(await save('volume-1')).toBe('cornerstone')
  expect(stored).toEqual([])
  await save('niivue-slide-1-1')
  expect(stored).toHaveLength(1)
})
