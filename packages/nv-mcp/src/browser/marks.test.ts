import { describe, expect, it, mock } from 'bun:test'
import { NVSlideAnnotations } from '@niivue/niivue'

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
    removeAnnotations: mock((ids: readonly string[]) => {
      for (const id of ids)
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
      'The drawing at https://x/other.nii could not be loaded: it is not a uint8 label image voxel-aligned with the base volume, or a later drawing call replaced it.',
    )
    await expect(edit_drawing({ action: 'load' })).rejects.toThrow(
      'Loading a drawing needs a url.',
    )
    expect(view.drawScene).toHaveBeenCalledTimes(4)
  })

  it('fills a shape in the drawing', async () => {
    const view = baseView({ drawShapeFill: mock(() => true) })
    const { edit_drawing } = markHandlers(hostOf(view))
    expect(
      await edit_drawing({
        action: 'fill',
        shape: 'sphere',
        start_mm: [1, 2, 3],
        end_mm: [1, 2, 13],
      }),
    ).toEqual({ action: 'fill' })
    await edit_drawing({
      action: 'fill',
      shape: 'rectangle',
      start_mm: [0, 0, 0],
      end_mm: [5, 5, 0],
      slice: 'coronal',
    })
    expect(view.drawShapeFill).toHaveBeenNthCalledWith(
      1,
      2,
      [1, 2, 3],
      [1, 2, 13],
      0,
    )
    expect(view.drawShapeFill).toHaveBeenNthCalledWith(
      2,
      0,
      [0, 0, 0],
      [5, 5, 0],
      1,
    )
    await expect(
      edit_drawing({ action: 'fill', start_mm: [0, 0, 0], end_mm: [1, 1, 1] }),
    ).rejects.toThrow(
      'Filling needs a shape: one of rectangle, circle, sphere.',
    )
    await expect(
      edit_drawing({
        action: 'fill',
        shape: 'circle',
        start_mm: [0, 0, 0],
        end_mm: [1, 1, 1],
        slice: 'render',
      }),
    ).rejects.toThrow('A fill lies in an axial, coronal or sagittal slice.')
    const none = baseView({ drawShapeFill: mock(() => false) })
    await expect(
      markHandlers(hostOf(none)).edit_drawing({
        action: 'fill',
        shape: 'circle',
        start_mm: [0, 0, 0],
        end_mm: [1, 1, 1],
      }),
    ).rejects.toThrow('There is no drawing to fill. Create or load one first.')
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
      'edit_drawing needs an action: one of create, load, undo, close, svg, fill.',
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
      unit: 'mm',
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
    expect(partial.list_annotations({})).toEqual({
      annotations: [],
      unit: 'mm',
    })
    expect(() => partial.list_annotations({ json: true })).toThrow(
      "This page's NiiVue cannot give its annotations as JSON.",
    )
    expect(() => partial.list_annotations({ svg: true })).toThrow(
      "This page's NiiVue cannot trace its annotations as SVG.",
    )
  })
})

describe('edit_annotations', () => {
  it('sets the style annotations drawn by hand take, keeping fields left out', () => {
    const view = markView({
      annotationStyle: {
        fillColor: [0, 0, 1, 0.3],
        strokeColor: [0, 0, 1, 1],
        strokeWidth: 2,
      },
    })
    const { edit_annotations, list_annotations } = markHandlers(hostOf(view))
    expect(
      edit_annotations({ action: 'set_style', style: { strokeWidth: 4 } }),
    ).toMatchObject({
      action: 'set_style',
      style: {
        fillColor: [0, 0, 1, 0.3],
        strokeColor: [0, 0, 1, 1],
        strokeWidth: 4,
      },
    })
    expect((list_annotations({}) as { style?: unknown }).style).toEqual(
      view.annotationStyle,
    )
    expect(() =>
      edit_annotations({ action: 'set_style', style: { strokeColor: [1] } }),
    ).toThrow('strokeColor must be [r, g, b, a]')
    expect(() =>
      edit_annotations({
        action: 'set_style',
        style: { fillColor: [0, 0, 300, 1] },
      }),
    ).toThrow('fillColor must be [r, g, b, a], each 0 to 1')
    // Only the fields NiiVue reads are kept.
    edit_annotations({
      action: 'set_style',
      style: { strokeWidth: 4, dash: [2, 2] },
    })
    expect(Object.keys(view.annotationStyle ?? {}).sort()).toEqual([
      'fillColor',
      'strokeColor',
      'strokeWidth',
    ])
    expect(() => edit_annotations({ action: 'set_style' })).toThrow(
      'set_style needs style',
    )
    expect(view.annotationStyle?.strokeWidth).toBe(4)
    expect(() =>
      markHandlers(hostOf(markView())).edit_annotations({
        action: 'set_style',
        style: { strokeWidth: 1 },
      }),
    ).toThrow('no style')
  })

  it('removes several by ids, undoable when asked', () => {
    const view = markView()
    const { edit_annotations } = markHandlers(hostOf(view))
    expect(() =>
      edit_annotations({ action: 'remove', ids: ['a1', 'zz'] }),
    ).toThrow('There is no annotation with the id "zz".')
    expect(
      edit_annotations({
        action: 'remove',
        ids: ['a1', 'a2'],
        is_undoable: true,
      }),
    ).toMatchObject({ action: 'remove', count: 0 })
    expect(view.removeAnnotations).toHaveBeenLastCalledWith(['a1', 'a2'], true)
  })

  // A host's multi-shape edit (nv-ohif's contour operations) as one step.
  it('replaces several with new annotations as one undoable step', () => {
    const replaceAnnotations = mock(() => {})
    const view = markView({ replaceAnnotations })
    const { edit_annotations } = markHandlers(hostOf(view))
    expect(() =>
      edit_annotations({ action: 'replace', ids: ['zz'], annotations: [] }),
    ).toThrow('There is no annotation with the id "zz".')
    edit_annotations({
      action: 'replace',
      ids: ['a1', 'a2'],
      annotations: [note('b1')],
      is_undoable: true,
    })
    expect(replaceAnnotations).toHaveBeenLastCalledWith(
      ['a1', 'a2'],
      [expect.objectContaining({ id: 'b1', group: 'lesions' })],
      true,
    )
  })

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
    expect(view.removeAnnotation).toHaveBeenLastCalledWith('a2', false)
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
      'edit_annotations needs an action: one of add, remove, clear, select, set_text, undo, redo, load, set_style, replace.',
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
      unit: 'mm',
    })
    expect(() =>
      markHandlers(hostOf(baseView())).list_measurements({}),
    ).toThrow("This page's NiiVue keeps no measurements.")
  })

  it('names the unit of a micrometre volume beside the ends and distance', () => {
    const view = markView()
    view.volumes = [{ name: 'heart.nii', hdr: { xyzt_units: 11 } }]
    expect(markHandlers(hostOf(view)).list_measurements({})).toMatchObject({
      unit: 'um',
    })
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
      unit: 'mm',
    })
    expect(() =>
      edit_measurements({ action: 'add', start_mm: [0, 0, 0] }),
    ).toThrow('end_mm must be three numbers, [x, y, z] in world units.')
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

describe('set_boxes', () => {
  /** A view whose box properties keep what they are given, as NiiVue's do. */
  const boxView = () => baseView({ focusBox: null, lodBoxes: null })

  it('outlines a focus box and a set, with NiiVue defaults filled in', () => {
    const view = boxView()
    const { set_boxes } = markHandlers(hostOf(view))
    expect(
      set_boxes({
        focus: { min: [-10, -10, -10], max: [10, 10, 10] },
        boxes: [
          { min: [0, 0, 0], max: [1, 1, 1], color: [1, 0, 0], thickness: 1 },
          { min: [1, 0, 0], max: [2, 1, 1] },
        ],
      }),
    ).toEqual({
      focus: {
        min: [-10, -10, -10],
        max: [10, 10, 10],
        color: [1, 0.83, 0.28, 1],
        thickness: 2,
      },
      boxes: 2,
      unit: 'mm',
    })
    expect(view.lodBoxes?.[0].color).toEqual([1, 0, 0, 1])
    expect(view.drawScene).toHaveBeenCalled()
  })

  it('takes either down with null, leaving the other', () => {
    const view = boxView()
    const { set_boxes } = markHandlers(hostOf(view))
    const box = { min: [0, 0, 0], max: [1, 1, 1] }
    set_boxes({ focus: box, boxes: [box] })
    expect(set_boxes({ focus: null })).toMatchObject({ focus: null, boxes: 1 })
    expect(set_boxes({ boxes: [] })).toEqual({
      focus: null,
      boxes: 0,
      unit: 'mm',
    })
    expect(view.lodBoxes).toBeNull()
  })

  it('refuses a bad box, leaving the render as it was', () => {
    const view = boxView()
    const { set_boxes } = markHandlers(hostOf(view))
    const good = { min: [0, 0, 0], max: [1, 1, 1] }
    expect(() => set_boxes({})).toThrow('needs focus, boxes, or both')
    expect(() =>
      set_boxes({
        focus: good,
        boxes: [good, { min: [0, 0, 0], max: [1, 0, 1] }],
      }),
    ).toThrow('boxes[1]: each of min must be below max')
    expect(() => set_boxes({ focus: { ...good, color: [2, 0, 0] } })).toThrow(
      'color must be',
    )
    expect(() => set_boxes({ focus: { ...good, thickness: 0 } })).toThrow(
      'thickness must be above 0',
    )
    expect(() => set_boxes({ boxes: good })).toThrow('list of boxes')
    expect(view.focusBox).toBeNull()
    expect(view.lodBoxes).toBeNull()
    expect(() =>
      markHandlers(hostOf(baseView())).set_boxes({ focus: good }),
    ).toThrow('cannot outline boxes')
  })
})

describe('set_plane_outlines', () => {
  const square: [number, number, number][] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ]

  it('outlines rectangles and takes them down with null', () => {
    const view = baseView({ planeOutlines: [] })
    const { set_plane_outlines } = markHandlers(hostOf(view))
    expect(
      set_plane_outlines({
        outlines: [{ corners: square, color: [0, 1, 1], width: 3 }],
      }),
    ).toEqual({ outlines: 1 })
    expect(view.planeOutlines).toEqual([
      { cornersMM: square, color: [0, 1, 1, 1], width: 3 },
    ])
    expect(set_plane_outlines({ outlines: null })).toEqual({ outlines: 0 })
  })

  it('refuses a bad rectangle, leaving the scene as it was', () => {
    const view = baseView({ planeOutlines: [] })
    const { set_plane_outlines } = markHandlers(hostOf(view))
    expect(() =>
      set_plane_outlines({ outlines: [{ corners: square.slice(0, 3) }] }),
    ).toThrow('four [x, y, z] points')
    expect(() =>
      set_plane_outlines({
        outlines: [{ corners: [...square.slice(0, 3), [0, 'a', 0]] }],
      }),
    ).toThrow('outlines[0].corners[3]')
    expect(() =>
      set_plane_outlines({ outlines: [{ corners: square, width: 0 }] }),
    ).toThrow('width must be above 0')
    expect(view.planeOutlines).toEqual([])
    expect(() =>
      markHandlers(hostOf(baseView())).set_plane_outlines({ outlines: [] }),
    ).toThrow('cannot outline rectangles')
  })
})

describe('list_slide_annotations and edit_slide_annotations', () => {
  const slideHost = () => {
    const store = new NVSlideAnnotations(() => [0.5, 0.5])
    return {
      store,
      handlers: markHandlers({
        ...hostOf(baseView()),
        slideAnnotations: store,
      }),
    }
  }

  it('adds, labels, lists and removes on the real NVSlideAnnotations', () => {
    const { store, handlers } = slideHost()
    const added = handlers.edit_slide_annotations({
      action: 'add',
      tool: 'rectangle',
      points: [
        [0, 0],
        [10, 20],
      ],
      label: 'tumour',
    }) as { annotation: { id: string; stats: { area: number } }; count: number }
    expect(added.count).toBe(1)
    expect(added.annotation.stats.area).toBeCloseTo(50)
    const { id } = added.annotation
    handlers.edit_slide_annotations({
      action: 'set_label',
      id,
      label: 'margin',
    })
    expect(store.get(id)?.label).toBe('margin')
    expect(handlers.list_slide_annotations({ points: true })).toEqual({
      annotations: [
        {
          id,
          tool: 'rectangle',
          label: 'margin',
          stats: store.list()[0]?.stats,
          points: [
            [0, 0],
            [10, 20],
          ],
        },
      ],
    })
    expect(handlers.edit_slide_annotations({ action: 'remove', id })).toEqual({
      count: 0,
    })
  })

  it('clears them all', () => {
    const { handlers } = slideHost()
    handlers.edit_slide_annotations({
      action: 'add',
      tool: 'point',
      points: [[1, 2]],
    })
    handlers.edit_slide_annotations({
      action: 'add',
      tool: 'point',
      points: [[3, 4]],
    })
    expect(handlers.edit_slide_annotations({ action: 'clear' })).toEqual({
      count: 0,
    })
  })

  it('refuses in words', () => {
    const { handlers } = slideHost()
    const edit = handlers.edit_slide_annotations
    expect(() =>
      edit({
        action: 'add',
        tool: 'polygon',
        points: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toThrow('Wrong number of points for a polygon.')
    expect(() =>
      edit({ action: 'add', tool: 'line', points: [[0, Number.NaN]] }),
    ).toThrow('points must be a list of [x, y] in slide base pixels.')
    expect(() => edit({ action: 'add', points: [[0, 0]] })).toThrow(
      'Adding needs tool',
    )
    expect(() => edit({ action: 'remove', id: 'nope' })).toThrow(
      'There is no slide annotation with the id "nope".',
    )
    expect(() => edit({ action: 'set_label', id: 'nope' })).toThrow(
      'set_label needs label.',
    )
    expect(() =>
      markHandlers(hostOf(baseView())).list_slide_annotations({}),
    ).toThrow('This page has no slide annotations.')
  })
})
