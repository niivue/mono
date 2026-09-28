/**
 * The canvas: its 2D pan and zoom, the point under a pixel and where a
 * point lands, the slide plane of a whole-slide image, the statistics of
 * a chunked volume, and what the page saves or loads as a whole.
 */

import { nameFor, SLICE_TYPES } from '../views'
import {
  choice,
  clamp,
  flag,
  integer,
  number,
  numbers,
  type Params,
  pointIfGiven,
  strings,
  text,
} from './params'
import { pickIndex } from './pick'
import type { DocumentOptions, Handlers, NiiVueHost } from './view'

const SAVES = ['document', 'volume', 'mesh', 'bitmap', 'drawing'] as const
const SLIDE_DRAWING = ['create', 'clear', 'undo', 'end'] as const

/** The handlers for the viewport, point mapping, slide, chunk and file tools. */
export function viewportHandlers(host: NiiVueHost): Handlers {
  const { view } = host

  const reported = () => ({
    ...(view.getViewport ? { viewport: view.getViewport() } : {}),
  })

  return {
    set_viewport(params: Params) {
      host.beforeAnswer?.()
      let changed = false
      const pan = numbers(params, 'pan', 2)
      const zoom = number(params, 'zoom')
      if (pan || zoom !== undefined) {
        if (!view.setViewport || !view.getViewport)
          throw new Error("This page's NiiVue cannot pan or zoom its canvas.")
        if (zoom !== undefined && zoom <= 0)
          throw new Error('zoom must be above 0.')
        const now = view.getViewport()
        view.setViewport({
          pan: pan ? [pan[0], pan[1]] : now.pan,
          zoom: zoom ?? now.zoom,
        })
        changed = true
      }
      const bounds = params?.bounds
      if (bounds !== undefined) {
        if (bounds === null) {
          if (!view.clearBounds)
            throw new Error("This page's NiiVue cannot bound its drawing.")
          view.clearBounds()
        } else {
          if (!view.setBounds)
            throw new Error("This page's NiiVue cannot bound its drawing.")
          const box = numbers(params, 'bounds', 4)
          if (!box || box.some((v) => v < 0 || v > 1))
            throw new Error(
              'bounds must be [x1, y1, x2, y2], each 0 to 1, or null.',
            )
          view.setBounds([box[0], box[1], box[2], box[3]])
        }
        changed = true
      }
      if (flag(params, 'reset')) {
        if (!view.setViewport)
          throw new Error("This page's NiiVue cannot pan or zoom its canvas.")
        view.setViewport({ pan: [0, 0], zoom: 1 })
        changed = true
      }
      if (!changed)
        throw new Error(
          'set_viewport needs something to set: pan, zoom, bounds or reset.',
        )
      view.drawScene()
      return reported()
    },

    map_point(params: Params) {
      host.beforeAnswer?.()
      const canvas = numbers(params, 'canvas', 2)
      const mm = pointIfGiven(params, 'mm')
      const vox = pointIfGiven(params, 'vox')
      if (!canvas && !mm && !vox)
        throw new Error('map_point needs canvas ([x, y] pixels), mm or vox.')
      const out: Record<string, unknown> = {}
      if (canvas) {
        if (!view.hitTest || !view.canvasToMM)
          throw new Error(
            "This page's NiiVue cannot say what is under a pixel.",
          )
        const hit = view.hitTest(canvas[0], canvas[1])
        out.canvas = canvas
        out.hit = hit
          ? { ...hit, slice: nameFor(SLICE_TYPES, hit.sliceType) }
          : null
        const at = view.canvasToMM(canvas[0], canvas[1])
        out.mm = at
        if (at) out.frac = Array.from(view.model.mm2scene(at))
      }
      if (mm) {
        if (!view.mmToCanvas)
          throw new Error(
            "This page's NiiVue cannot place a point on its canvas.",
          )
        out.mm = mm
        out.frac = Array.from(view.model.mm2scene(mm))
        out.canvas = view.mmToCanvas(mm)
      }
      if (vox) {
        if (!view.vox2frac)
          throw new Error("This page's NiiVue cannot place a voxel.")
        const frac = view.vox2frac(vox)
        out.vox = vox
        out.frac = frac
        out.mm = Array.from(view.model.scene2mm(frac))
        if (view.mmToCanvas) {
          const at = out.mm as number[]
          out.canvas = view.mmToCanvas([at[0], at[1], at[2]])
        }
      }
      return out
    },

    set_slide(params: Params) {
      host.beforeAnswer?.()
      let changed = false
      const level = params?.level
      if (level !== undefined) {
        if (!view.setSlidePlaneLevel)
          throw new Error("This page's NiiVue has no slide plane.")
        view.setSlidePlaneLevel(
          level === null ? undefined : integer(params, 'level'),
        )
        changed = true
      }
      if (flag(params, 'clear_plane')) {
        if (!view.clearSlidePlane)
          throw new Error("This page's NiiVue has no slide plane.")
        view.clearSlidePlane()
        changed = true
      }
      const drawing = choice(params, 'drawing', SLIDE_DRAWING)
      if (drawing) {
        const step = {
          create: view.createSlideDrawing
            ? () => {
                const maxRaster = integer(params, 'max_raster', 1)
                view.createSlideDrawing?.(
                  maxRaster === undefined ? undefined : { maxRaster },
                )
              }
            : undefined,
          clear: view.clearSlideDrawing,
          undo: view.slideDrawUndo,
          end: view.slideDrawEnd,
        }[drawing]
        if (!step) throw new Error("This page's NiiVue has no slide drawing.")
        step()
        changed = true
      }
      if (!changed)
        throw new Error(
          'set_slide needs something to do: level, clear_plane or drawing.',
        )
      view.drawScene()
      return {
        ...(level === undefined ? {} : { level }),
        ...(drawing ? { drawing } : {}),
      }
    },

    chunk_stats(params: Params) {
      host.beforeAnswer?.()
      if (!view.chunkStreamStats)
        throw new Error("This page's NiiVue streams no chunked volumes.")
      if (flag(params, 'rebake')) {
        if (!view.rebakeChunkedOverlays)
          throw new Error("This page's NiiVue cannot rebake its overlays.")
        view.rebakeChunkedOverlays()
      }
      const out: Record<string, unknown> = { stream: view.chunkStreamStats() }
      if (view.chunkTimingStats) out.timing = view.chunkTimingStats()
      if (view.lodCompensation) out.lodCompensation = view.lodCompensation()
      if (flag(params, 'reset_timing')) {
        if (!view.resetChunkTiming)
          throw new Error("This page's NiiVue keeps no chunk timing.")
        view.resetChunkTiming()
        out.timingReset = true
      }
      return out
    },

    async save(params: Params) {
      host.beforeAnswer?.()
      const what = choice(params, 'what', SAVES)
      if (!what) throw new Error(`save needs what: one of ${SAVES.join(', ')}.`)
      const filename = text(params, 'filename')
      switch (what) {
        case 'document': {
          if (!view.saveDocument)
            throw new Error("This page's NiiVue cannot save a document.")
          const options: DocumentOptions = {}
          const never = strings(params, 'settings_never_saved')
          const always = strings(params, 'settings_always_saved')
          if (never || always)
            options.settings = {
              ...(never ? { neverSave: never } : {}),
              ...(always ? { alwaysSave: always } : {}),
            }
          const format = choice(params, 'format', ['json', 'cbor'] as const)
          if (format) options.format = format
          const name = filename ?? 'scene.nvd'
          view.saveDocument(name, options)
          return { saved: what, filename: name }
        }
        case 'volume': {
          if (!view.saveVolume)
            throw new Error("This page's NiiVue cannot save a volume.")
          const index = pickIndex(view.volumes, params?.volume, 'volume', 0)
          const drawing = flag(params, 'drawing') ?? false
          await view.saveVolume({
            ...(filename ? { filename } : {}),
            isSaveDrawing: drawing,
            volumeByIndex: index,
          })
          return {
            saved: what,
            volume: view.volumes[index].name,
            drawing,
            ...(filename ? { filename } : {}),
          }
        }
        case 'mesh': {
          if (!view.saveMesh || !view.meshes)
            throw new Error("This page's NiiVue cannot save a mesh.")
          const index = pickIndex(view.meshes, params?.mesh, 'mesh', 0)
          await view.saveMesh(index, filename)
          return {
            saved: what,
            mesh: view.meshes[index].name ?? index,
            filename: filename ?? 'mesh.mz3',
          }
        }
        case 'bitmap': {
          if (!view.saveBitmap)
            throw new Error("This page's NiiVue cannot save a picture.")
          const quality = number(params, 'quality')
          await view.saveBitmap(
            filename,
            quality === undefined ? undefined : clamp(quality, 0, 1),
          )
          return { saved: what, filename: filename ?? 'myBitmap.png' }
        }
        case 'drawing': {
          if (!view.saveDrawing)
            throw new Error("This page's NiiVue cannot save a drawing.")
          await view.saveDrawing(filename)
          return { saved: what, filename: filename ?? 'drawing.nii' }
        }
      }
    },

    async load_document(params: Params) {
      host.beforeAnswer?.()
      if (!view.loadDocument)
        throw new Error("This page's NiiVue cannot load a document.")
      const url = text(params, 'url')
      if (!url) throw new Error('load_document needs a url.')
      const fill = choice(params, 'fill', ['default', 'current'] as const)
      try {
        await view.loadDocument(url, fill ? { fill } : undefined)
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        throw new Error(`The document at ${url} could not be loaded: ${why}`)
      }
      view.drawScene()
      return {
        url,
        ...(fill ? { fill } : {}),
        volumes: view.volumes.map((v) => v.name),
        ...(view.meshes
          ? { meshes: view.meshes.map((m) => m.name ?? '') }
          : {}),
      }
    },
  }
}
