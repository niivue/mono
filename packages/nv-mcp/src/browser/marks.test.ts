import { describe, expect, it, mock } from 'bun:test'

import { baseView, hostOf } from '../testing/fake-view'
import { markHandlers } from './marks'
import type { Annotation, Measurement, View } from './view'

const note = (id: string, extra: Partial<Annotation> = {}): Annotation => ({
  id,
  label: 1,
  group: 'lesions',
  sliceType: 0,
  slicePosition: 0.5,
  polygons: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
  ],
  style: { color: [1, 0, 0, 1] },
  ...extra,
})

/** A view keeping annotations and measurements as NiiVue's model would. */
function markView(overrides: Partial<View> = {}) {
  const annotations: Annotation[] = [note('a1'), note('a2', { text: 'two' })]
  const measurements: Measurement[] = [
    {
      startMM: [0, 0, 0],
      endMM: [3, 4, 0],
      distance: 5,
      sliceIndex: 0,
      sliceType: 0,
      slicePosition: 0.5,
    },
  ]
  const view = baseView({
    annotations,
    selectedAnnotation: null,
    addAnnotation: mock((a: Annotation) => {
      annotations.push(a)
    }),
    removeAnnotation: mock((id: string) => {
      annotations.splice(
        annotations.findIndex((a) => a.id === id),
        1,
      )
    }),
    clearAnnotations: mock(() => {
      annotations.splice(0)
    }),
    selectAnnotation: mock((id: string | null) => {
      view.selectedAnnotation = id
    }),
    setAnnotationText: mock((id: string, text: string) => {
      const found = annotations.find((a) => a.id === id)
      if (found) found.text = text
    }),
    annotationUndo: mock(),
    annotationRedo: mock(),
    getAnnotationsJSON: () => JSON.stringify(annotations),
    loadAnnotationsJSON: mock((json: string) => {
      annotations.splice(0, annotations.length, ...JSON.parse(json))
    }),
    annotationsToSVG: mock(() => '<svg/>'),
    getMeasurements: () => measurements,
    addMeasurement: mock((start, end, options) => {
      measurements.push({
        startMM: start,
        endMM: end,
        distance: Math.hypot(
          end[0] - start[0],
          end[1] - start[1],
          end[2] - start[2],
        ),
        sliceIndex: options?.sliceIndex ?? 0,
        sliceType: options?.sliceType ?? 0,
        slicePosition: options?.slicePosition ?? 0.5,
      })
      return measurements.length - 1
    }),
    removeMeasurement: mock((index: number) => {
      measurements.splice(index, 1)
    }),
    clearMeasurements: mock(() => {
      measurements.splice(0)
    }),
    clearAngles: mock(),
    clearDistanceMeasurements: mock(),
    ...overrides,
  })
  return view
}

describe('edit_drawing', () => {
  it('creates, undoes, closes and loads the drawing', async () => {
    const view = baseView({
      createEmptyDrawing: mock(),
      drawUndo: mock(),
      closeDrawing: mock(),
      loadDrawing: mock(async (url: string) => url.endsWith('fits.nii')),
    })
    const { edit_drawing } = markHandlers(hostOf(view))
    expect(await edit_drawing({ action: 'create' })).toEqual({
      action: 'create',
    })
    expect(view.createEmptyDrawing).toHaveBeenCalledTimes(1)
    await edit_drawing({ action: 'undo' })
    await edit_drawing({ action: 'close' })
    expect(view.drawUndo).toHaveBeenCalledTimes(1)
    expect(view.closeDrawing).toHaveBeenCalledTimes(1)
    expect(
      await edit_drawing({ action: 'load', url: 'https://x/fits.nii' }),
    ).toEqual({ action: 'load' })
    await expect(
      edit_drawing({ action: 'load', url: 'https://x/other.nii' }),
    ).rejects.toThrow(
      'The drawing at https://x/other.nii could not be loaded: it does not fit the base volume.',
    )
    await expect(edit_drawing({ action: 'load' })).rejects.toThrow(
      'Loading a drawing needs a url.',
    )
    expect(view.drawScene).toHaveBeenCalledTimes(4)
  })

  it('traces the drawing as svg for a slice', async () => {
    const view = baseView({
      drawingToSVG: mock((sliceType?: number, index?: number) =>
        index === 99
          ? null
          : `<svg data-slice="${sliceType}" data-index="${index}"/>`,
      ),
    })
    const { edit_drawing } = markHandlers(hostOf(view))
    expect(
      await edit_drawing({ action: 'svg', slice: 'Coronal', slice_index: 12 }),
    ).toEqual({ action: 'svg', svg: '<svg data-slice="1" data-index="12"/>' })
    await expect(
      edit_drawing({ action: 'svg', slice_index: 99 }),
    ).rejects.toThrow('There is no drawing to trace.')
    await expect(
      edit_drawing({ action: 'svg', slice: 'oblique' }),
    ).rejects.toThrow('Unknown slice "oblique". One of: axial, coronal')
    expect(view.drawScene).not.toHaveBeenCalled()
  })

  it('refuses no action, no volume, and a page that cannot draw', async () => {
    const { edit_drawing } = markHandlers(hostOf(baseView()))
    await expect(edit_drawing({})).rejects.toThrow(
      'edit_drawing needs an action: one of create, load, undo, close, svg.',
    )
    await expect(edit_drawing({ action: 'create' })).rejects.toThrow(
      "This page's NiiVue cannot create a drawing.",
    )
    await expect(edit_drawing({ action: 'svg' })).rejects.toThrow(
      "This page's NiiVue cannot trace a drawing as SVG.",
    )
    const empty = markHandlers(hostOf(baseView({ volumes: [] })))
    await expect(empty.edit_drawing({ action: 'create' })).rejects.toThrow(
      'No volume is loaded yet. Call load_volume first.',
    )
  })
})

describe('list_annotations', () => {
  it('lists the annotations with polygon counts, or with polygons, json and svg', () => {
    const view = markView()
    const { list_annotations } = markHandlers(hostOf(view))
    expect(list_annotations({})).toEqual({
      annotations: [
        {
          id: 'a1',
          label: 1,
          group: 'lesions',
          sliceType: 0,
          slice: 'axial',
          slicePosition: 0.5,
          style: { color: [1, 0, 0, 1] },
          polygonCount: 1,
        },
        expect.objectContaining({ id: 'a2', text: 'two', polygonCount: 1 }),
      ],
      selected: null,
    })
    const full = list_annotations({
      polygons: true,
      json: true,
      svg: true,
      slice: 'sagittal',
      slice_position: 0.25,
    }) as Record<string, unknown>
    expect(
      (full.annotations as Array<{ polygons: unknown[] }>)[0].polygons,
    ).toEqual([
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    ])
    expect(JSON.parse(full.json as string)).toHaveLength(2)
    expect(full.svg).toBe('<svg/>')
    expect(view.annotationsToSVG).toHaveBeenCalledWith(2, 0.25)
  })

  it('refuses a page without annotations, json or svg', () => {
    expect(() => markHandlers(hostOf(baseView())).list_annotations({})).toThrow(
      "This page's NiiVue has no annotations.",
    )
    const partial = markHandlers(hostOf(baseView({ annotations: [] })))
    expect(partial.list_annotations({})).toEqual({ annotations: [] })
    expect(() => partial.list_annotations({ json: true })).toThrow(
      "This page's NiiVue cannot give its annotations as JSON.",
    )
    expect(() => partial.list_annotations({ svg: true })).toThrow(
      "This page's NiiVue cannot trace its annotations as SVG.",
    )
  })
})

describe('edit_annotations', () => {
  it('adds, selects, retitles, removes, clears, undoes, redoes and loads', () => {
    const view = markView()
    const { edit_annotations } = markHandlers(hostOf(view))
    expect(edit_annotations({ action: 'add', annotation: note('a3') })).toEqual(
      {
        action: 'add',
        count: 3,
        selected: null,
      },
    )
    expect(edit_annotations({ action: 'select', id: 'a3' })).toEqual({
      action: 'select',
      id: 'a3',
      count: 3,
      selected: 'a3',
    })
    edit_annotations({ action: 'select' })
    expect(view.selectAnnotation).toHaveBeenLastCalledWith(null)
    edit_annotations({ action: 'set_text', id: 'a1', text: 'one' })
    expect(view.annotations?.[0].text).toBe('one')
    expect(edit_annotations({ action: 'remove', id: 'a2' })).toMatchObject({
      action: 'remove',
      id: 'a2',
      count: 2,
    })
    edit_annotations({ action: 'undo' })
    edit_annotations({ action: 'redo' })
    expect(view.annotationUndo).toHaveBeenCalledTimes(1)
    expect(view.annotationRedo).toHaveBeenCalledTimes(1)
    expect(
      edit_annotations({ action: 'load', json: JSON.stringify([note('b1')]) }),
    ).toMatchObject({ action: 'load', count: 1 })
    expect(edit_annotations({ action: 'clear' })).toMatchObject({
      action: 'clear',
      count: 0,
    })
    expect(view.drawScene).toHaveBeenCalledTimes(9)
  })

  it('hands NiiVue each polygon as outer and holes, from a point list or that shape', () => {
    const view = markView()
    const { edit_annotations } = markHandlers(hostOf(view))
    edit_annotations({ action: 'add', annotation: note('p1') })
    expect(view.addAnnotation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'p1',
        polygons: [
          {
            outer: [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
              { x: 1, y: 1 },
            ],
            holes: [],
          },
        ],
      }),
    )
    edit_annotations({
      action: 'add',
      annotation: note('p2', {
        polygons: [
          {
            outer: [{ x: 0, y: 0 }, [1, 0], { x: 1, y: 1 }, [0, 1]],
            holes: [
              [
                [0.2, 0.2],
                [0.4, 0.2],
                [0.4, 0.4],
              ],
            ],
          },
        ] as unknown as Annotation['polygons'],
      }),
    })
    expect(view.addAnnotation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        polygons: [
          {
            outer: [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
              { x: 1, y: 1 },
              { x: 0, y: 1 },
            ],
            holes: [
              [
                { x: 0.2, y: 0.2 },
                { x: 0.4, y: 0.2 },
                { x: 0.4, y: 0.4 },
              ],
            ],
          },
        ],
      }),
    )
  })

  it('refuses a polygon with too few points, a bad point, or no slice position', () => {
    const view = markView()
    const { edit_annotations } = markHandlers(hostOf(view))
    const bad = (extra: Record<string, unknown>) => () =>
      edit_annotations({
        action: 'add',
        annotation: { ...note('x'), ...extra },
      })
    expect(
      bad({
        polygons: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      }),
    ).toThrow(
      'Each polygon needs at least three points: a list of them, or {outer, holes}.',
    )
    expect(
      bad({
        polygons: [
          [
            [0, 0],
            [1, 'a'],
            [1, 1],
          ],
        ],
      }),
    ).toThrow(
      'Each polygon point must be [x, y] or {x, y}, in mm on the slice plane.',
    )
    expect(bad({ polygons: [] })).toThrow(
      'annotation needs at least id, sliceType, slicePosition and polygons.',
    )
    expect(bad({ slicePosition: '0.5' })).toThrow(
      'annotation needs at least id',
    )
    expect(view.addAnnotation).not.toHaveBeenCalled()
  })

  it('refuses a missing or unknown id, a bad annotation, and missing text or json', () => {
    const { edit_annotations } = markHandlers(hostOf(markView()))
    expect(() => edit_annotations({})).toThrow(
      'edit_annotations needs an action: one of add, remove, clear, select, set_text, undo, redo, load.',
    )
    expect(() => edit_annotations({ action: 'remove' })).toThrow(
      "Action remove needs the annotation's id.",
    )
    expect(() => edit_annotations({ action: 'remove', id: 'zz' })).toThrow(
      'There is no annotation with the id "zz".',
    )
    expect(() => edit_annotations({ action: 'add' })).toThrow(
      'Adding needs annotation: a NiiVue VectorAnnotation as JSON.',
    )
    expect(() =>
      edit_annotations({ action: 'add', annotation: { id: 'x' } }),
    ).toThrow(
      'annotation needs at least id, sliceType, slicePosition and polygons.',
    )
    expect(() => edit_annotations({ action: 'set_text', id: 'a1' })).toThrow(
      'set_text needs text.',
    )
    expect(() => edit_annotations({ action: 'load', json: '  ' })).toThrow(
      'Loading needs json',
    )
  })

  it('refuses a page that cannot', () => {
    const bare = markHandlers(hostOf(baseView({ annotations: [note('a1')] })))
    expect(() =>
      bare.edit_annotations({ action: 'add', annotation: note('x') }),
    ).toThrow("This page's NiiVue cannot add an annotation.")
    expect(() =>
      bare.edit_annotations({ action: 'set_text', id: 'a1' }),
    ).toThrow("This page's NiiVue cannot set text an annotation.")
  })
})

describe('list_measurements and edit_measurements', () => {
  it('lists the measurements by slice name', () => {
    const { list_measurements } = markHandlers(hostOf(markView()))
    expect(list_measurements({})).toEqual({
      measurements: [
        {
          index: 0,
          startMM: [0, 0, 0],
          endMM: [3, 4, 0],
          distance: 5,
          slice: 'axial',
          sliceIndex: 0,
          slicePosition: 0.5,
        },
      ],
    })
    expect(() =>
      markHandlers(hostOf(baseView())).list_measurements({}),
    ).toThrow("This page's NiiVue keeps no measurements.")
  })

  it('adds a measurement between two points, removes one, and clears', () => {
    const view = markView()
    const { edit_measurements } = markHandlers(hostOf(view))
    const added = edit_measurements({
      action: 'add',
      start_mm: [0, 0, 0],
      end_mm: [0, 0, 10],
      slice: 'coronal',
      slice_index: 3,
      slice_position: 0.4,
    }) as Record<string, unknown>
    expect(view.addMeasurement).toHaveBeenCalledWith([0, 0, 0], [0, 0, 10], {
      sliceType: 1,
      sliceIndex: 3,
      slicePosition: 0.4,
    })
    expect(added).toMatchObject({
      action: 'add',
      index: 1,
      measurement: { index: 1, distance: 10, slice: 'coronal' },
    })
    expect((added.measurements as unknown[]).length).toBe(2)
    expect(edit_measurements({ action: 'remove', index: 0 })).toMatchObject({
      action: 'remove',
      index: 0,
      measurements: [expect.objectContaining({ distance: 10 })],
    })
    expect(() => edit_measurements({ action: 'remove', index: 5 })).toThrow(
      'There is no measurement 5: 1 kept, numbered from 0.',
    )
    expect(() => edit_measurements({ action: 'remove' })).toThrow(
      'Removing needs index, as list_measurements counts them.',
    )
    edit_measurements({ action: 'clear_angles' })
    edit_measurements({ action: 'clear_distances' })
    expect(view.clearAngles).toHaveBeenCalledTimes(1)
    expect(view.clearDistanceMeasurements).toHaveBeenCalledTimes(1)
    expect(edit_measurements({ action: 'clear' })).toEqual({
      action: 'clear',
      measurements: [],
    })
    expect(() =>
      edit_measurements({ action: 'add', start_mm: [0, 0, 0] }),
    ).toThrow('end_mm must be three numbers, [x, y, z] in millimetres.')
    expect(() => edit_measurements({})).toThrow(
      'edit_measurements needs an action: one of add, remove, clear, clear_angles, clear_distances.',
    )
  })

  it('refuses a page that cannot', () => {
    const { edit_measurements } = markHandlers(hostOf(baseView()))
    expect(() =>
      edit_measurements({
        action: 'add',
        start_mm: [0, 0, 0],
        end_mm: [1, 0, 0],
      }),
    ).toThrow("This page's NiiVue cannot add measurements.")
    expect(() => edit_measurements({ action: 'clear_angles' })).toThrow(
      "This page's NiiVue cannot clear angles measurements.",
    )
  })
})
