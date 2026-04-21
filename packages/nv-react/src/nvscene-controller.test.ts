// biome-ignore-all lint/style/noNonNullAssertion: test file — assertions on known state are safe
import { beforeEach, describe, expect, mock, test } from "bun:test"
import {
  clearMockInstances,
  mockInstances,
  registerNiivueMock,
  SLICE_TYPE,
  SHOW_RENDER,
} from "./__mocks__/niivue"

// Register the module mock before importing the controller
registerNiivueMock()

import { defaultLayouts } from "./layouts"
import {
  defaultSliceLayout,
  defaultSliceLayouts,
  defaultViewerOptions,
  heroRenderSliceLayout,
  NvSceneController,
  quadSliceLayout,
  splitSliceLayout,
  stackedSliceLayout,
  triSliceLayout,
} from "./nvscene-controller"

describe("NvSceneController", () => {
  let controller: NvSceneController
  let container: HTMLElement

  beforeEach(() => {
    clearMockInstances()
    controller = new NvSceneController()
    container = document.createElement("div")
  })

  // --- Construction & defaults ---

  describe("constructor", () => {
    test("uses defaultLayouts when none provided", () => {
      expect(controller.layouts).toBe(defaultLayouts)
    })

    test("accepts custom layouts", () => {
      const custom = {
        single: {
          slots: 1,
          label: "Single",
          layoutFunction: () => ({
            top: "0",
            left: "0",
            width: "100%",
            height: "100%",
          }),
        },
      }
      const c = new NvSceneController(custom)
      expect(c.layouts).toBe(custom)
    })

    test("initial state: layout 1x1, no viewers, not broadcasting, not loading", () => {
      const snap = controller.getSnapshot()
      expect(snap.currentLayout).toBe("1x1")
      expect(snap.viewerCount).toBe(0)
      expect(snap.isBroadcasting).toBe(false)
      expect(snap.isLoading).toBe(false)
      expect(snap.viewerStates).toEqual([])
    })

    test("initial slots match the default layout", () => {
      const snap = controller.getSnapshot()
      expect(snap.slots).toBe(1)
    })
  })

  // --- Subscribe / getSnapshot ---

  describe("subscribe / getSnapshot", () => {
    test("subscribe returns an unsubscribe function", () => {
      const listener = mock(() => {})
      const unsub = controller.subscribe(listener)
      expect(typeof unsub).toBe("function")
      unsub()
    })

    test("listeners are called when state changes", () => {
      const listener = mock(() => {})
      controller.subscribe(listener)
      controller.setContainerElement(container)
      controller.setLayout("1x1")
      expect(listener).toHaveBeenCalled()
    })

    test("unsubscribed listeners are not called", () => {
      const listener = mock(() => {})
      const unsub = controller.subscribe(listener)
      unsub()
      controller.setContainerElement(container)
      controller.setLayout("1x1")
      // setLayout calls notify, but listener was removed
      const callCount = listener.mock.calls.length
      controller.setLayout("2x2")
      expect(listener.mock.calls.length).toBe(callCount)
    })

    test("getSnapshot returns cached object until state changes", () => {
      const snap1 = controller.getSnapshot()
      const snap2 = controller.getSnapshot()
      expect(snap1).toBe(snap2) // referential equality
    })

    test("getSnapshot returns new object after state change", () => {
      const snap1 = controller.getSnapshot()
      controller.setContainerElement(container)
      controller.setLayout("2x2")
      const snap2 = controller.getSnapshot()
      expect(snap1).not.toBe(snap2)
    })
  })

  // --- Event system ---

  describe("event system", () => {
    test("on registers a listener that receives emitted events", () => {
      const cb = mock((_index: number) => {})
      controller.on("viewerRemoved", cb)
      controller.setContainerElement(container)
      controller.setLayout("1x2")
      controller.removeViewer(0)
      expect(cb).toHaveBeenCalledWith(0)
    })

    test("on returns an unsubscribe function", () => {
      const cb = mock((_index: number) => {})
      const unsub = controller.on("viewerRemoved", cb)
      expect(typeof unsub).toBe("function")
      unsub()
      controller.setContainerElement(container)
      controller.setLayout("1x2")
      controller.removeViewer(0)
      expect(cb).not.toHaveBeenCalled()
    })

    test("off removes a previously registered listener", () => {
      const cb = mock((_index: number) => {})
      controller.on("viewerRemoved", cb)
      controller.off("viewerRemoved", cb)
      controller.setContainerElement(container)
      controller.setLayout("1x2")
      controller.removeViewer(0)
      expect(cb).not.toHaveBeenCalled()
    })

    test("multiple listeners on the same event all fire", () => {
      const cb1 = mock((_index: number) => {})
      const cb2 = mock((_index: number) => {})
      controller.on("viewerRemoved", cb1)
      controller.on("viewerRemoved", cb2)
      controller.setContainerElement(container)
      controller.setLayout("1x2")
      controller.removeViewer(0)
      expect(cb1).toHaveBeenCalled()
      expect(cb2).toHaveBeenCalled()
    })

    test("listeners on different events do not cross-fire", () => {
      const removedCb = mock((_index: number) => {})
      const errorCb = mock((_index: number, _err: unknown) => {})
      controller.on("viewerRemoved", removedCb)
      controller.on("error", errorCb)
      controller.setContainerElement(container)
      controller.setLayout("1x2")
      controller.removeViewer(0)
      expect(removedCb).toHaveBeenCalled()
      expect(errorCb).not.toHaveBeenCalled()
    })

    test("viewerCreated event fires when a viewer is added", () => {
      const cb = mock((_nv: unknown, _index: number) => {})
      controller.on("viewerCreated", cb)
      controller.setContainerElement(container)
      controller.setLayout("1x1")
      expect(cb).toHaveBeenCalled()
      expect(cb.mock.calls[0]?.[1]).toBe(0)
    })
  })

  // --- Container & layout ---

  describe("container and layout", () => {
    test("setContainerElement stores the element", () => {
      controller.setContainerElement(container)
      expect(controller.containerElement).toBe(container)
    })

    test("setContainerElement(null) clears the element", () => {
      controller.setContainerElement(container)
      controller.setContainerElement(null)
      expect(controller.containerElement).toBeNull()
    })

    test("setLayout changes currentLayout and slots in snapshot", () => {
      controller.setContainerElement(container)
      controller.setLayout("2x2")
      const snap = controller.getSnapshot()
      expect(snap.currentLayout).toBe("2x2")
      expect(snap.slots).toBe(4)
    })

    test("setLayout with invalid name is a no-op", () => {
      const snap1 = controller.getSnapshot()
      controller.setLayout("nonexistent")
      const snap2 = controller.getSnapshot()
      expect(snap2.currentLayout).toBe(snap1.currentLayout)
    })

    test("setLayout fills all available slots", () => {
      controller.setContainerElement(container)
      controller.setLayout("2x2")
      expect(controller.getSnapshot().viewerCount).toBe(4)
    })

    test("setLayout removes excess viewers when new layout has fewer slots", () => {
      controller.setContainerElement(container)
      controller.setLayout("2x2")
      expect(controller.getSnapshot().viewerCount).toBe(4)
      controller.setLayout("1x1")
      expect(controller.getSnapshot().viewerCount).toBe(1)
    })

    test("setLayout creates a viewer if container is set and no viewers exist", () => {
      controller.setContainerElement(container)
      controller.setLayout("1x1")
      expect(controller.getSnapshot().viewerCount).toBe(1)
    })

    test("updateLayout applies position styles to viewer container divs", () => {
      controller.setContainerElement(container)
      controller.setLayout("1x2")
      controller.updateLayout()
      const firstViewer = controller.viewers[0]!
      expect(firstViewer.containerDiv.style.position).toBe("absolute")
      expect(firstViewer.containerDiv.style.width).toBe("50%")
    })

    test("updateLayout is a no-op without a container element", () => {
      // Should not throw
      controller.updateLayout()
    })
  })

  // --- Viewer lifecycle ---

  describe("viewer lifecycle", () => {
    beforeEach(() => {
      controller.setContainerElement(container)
    })

    test("addViewer throws if no container element", () => {
      const c = new NvSceneController()
      expect(() => c.addViewer()).toThrow("Container element not set")
    })

    test("addViewer throws if slot limit reached", () => {
      controller.setLayout("1x1")
      // setLayout fills the single slot
      expect(() => controller.addViewer()).toThrow("slot limit")
    })

    test("addViewer creates DOM elements appended to the container", () => {
      controller.setLayout("2x2")
      const containerDivs = container.querySelectorAll(
        ".niivue-canvas-container",
      )
      expect(containerDivs.length).toBe(4)
      const canvases = container.querySelectorAll(".niivue-canvas")
      expect(canvases.length).toBe(4)
    })

    test("setLayout fills all slots and viewerCount matches", () => {
      controller.setLayout("2x2")
      expect(controller.getSnapshot().viewerCount).toBe(4)
    })

    test("addViewer increments viewerCount when slot is available", () => {
      controller.setLayout("2x2")
      controller.removeViewer(3)
      const countBefore = controller.getSnapshot().viewerCount
      controller.addViewer()
      expect(controller.getSnapshot().viewerCount).toBe(countBefore + 1)
    })

    test("addViewer calls onViewerCreated callback", () => {
      const cb = mock((_nv: unknown, _index: number) => {})
      controller.onViewerCreated = cb
      controller.setLayout("1x1")
      expect(cb).toHaveBeenCalled()
    })

    test("addViewer creates a Niivue instance and calls attachToCanvas", () => {
      clearMockInstances()
      controller.setLayout("1x1")
      expect(mockInstances.length).toBe(1)
      const nv = mockInstances[0]!
      expect(nv.attachToCanvas).toHaveBeenCalled()
    })

    test("viewer has id, niivue, canvasElement, containerDiv", () => {
      controller.setLayout("1x1")
      const viewer = controller.viewers[0]!
      expect(viewer).toHaveProperty("id")
      expect(viewer).toHaveProperty("niivue")
      expect(viewer).toHaveProperty("canvasElement")
      expect(viewer).toHaveProperty("containerDiv")
      expect(typeof viewer.id).toBe("string")
    })

    test("removeViewer decrements viewerCount", () => {
      controller.setLayout("2x2")
      const countBefore = controller.getSnapshot().viewerCount
      controller.removeViewer(0)
      expect(controller.getSnapshot().viewerCount).toBe(countBefore - 1)
    })

    test("removeViewer removes DOM elements", () => {
      controller.setLayout("2x2")
      const viewer = controller.viewers[0]!
      const containerDiv = viewer.containerDiv
      controller.removeViewer(0)
      expect(containerDiv.parentNode).toBeNull()
    })

    test("removeViewer emits viewerRemoved event", () => {
      const cb = mock((_index: number) => {})
      controller.on("viewerRemoved", cb)
      controller.setLayout("2x2")
      controller.removeViewer(0)
      expect(cb).toHaveBeenCalledWith(0)
    })

    test("removeViewer with out-of-bounds index is a no-op", () => {
      controller.setLayout("1x1")
      const countBefore = controller.getSnapshot().viewerCount
      controller.removeViewer(99)
      expect(controller.getSnapshot().viewerCount).toBe(countBefore)

      controller.removeViewer(-1)
      expect(controller.getSnapshot().viewerCount).toBe(countBefore)
    })

    test("clearViewers removes all viewers", () => {
      controller.setLayout("2x2")
      controller.clearViewers()
      expect(controller.getSnapshot().viewerCount).toBe(0)
    })

    test("clearViewers disables broadcasting", () => {
      controller.setLayout("1x2")
      controller.setBroadcasting(true)
      controller.clearViewers()
      expect(controller.getSnapshot().isBroadcasting).toBe(false)
    })

    test("reset clears viewers and resets layout to 1x1", () => {
      controller.setLayout("2x2")
      controller.reset()
      const snap = controller.getSnapshot()
      expect(snap.viewerCount).toBe(0)
      expect(snap.currentLayout).toBe("1x1")
      expect(snap.slots).toBe(1)
    })
  })

  // --- Viewer accessors ---

  describe("viewer accessors", () => {
    beforeEach(() => {
      controller.setContainerElement(container)
    })

    test("canAddViewer returns true when under slot limit", () => {
      controller.setLayout("2x2")
      controller.removeViewer(0)
      expect(controller.canAddViewer()).toBe(true)
    })

    test("canAddViewer returns false when at slot limit", () => {
      controller.setLayout("1x1")
      expect(controller.canAddViewer()).toBe(false)
    })

    test("getNiivue returns Niivue instance at index", () => {
      controller.setLayout("2x2")
      const nv = controller.getNiivue(0)
      expect(nv).toBeDefined()
    })

    test("getNiivue returns undefined for out-of-bounds index", () => {
      controller.setLayout("1x1")
      expect(controller.getNiivue(99)).toBeUndefined()
    })

    test("getAllNiivue returns array of all instances", () => {
      controller.setLayout("1x2")
      const all = controller.getAllNiivue()
      expect(all.length).toBe(2)
    })

    test("forEachNiivue calls callback for each viewer", () => {
      controller.setLayout("1x2")
      const cb = mock((_nv: unknown, _i: number) => {})
      controller.forEachNiivue(cb)
      expect(cb).toHaveBeenCalledTimes(2)
    })

    test("getNiivueById returns instance by id", () => {
      controller.setLayout("1x2")
      const viewer = controller.viewers[1]!
      const nv = controller.getNiivueById(viewer.id)
      expect(nv).toBe(viewer.niivue)
    })

    test("getNiivueById returns undefined for unknown id", () => {
      expect(controller.getNiivueById("nonexistent")).toBeUndefined()
    })

    test("getViewerById returns ViewerSlot by id", () => {
      controller.setLayout("1x2")
      const viewer = controller.viewers[1]!
      const found = controller.getViewerById(viewer.id)
      expect(found).toBe(viewer)
    })

    test("getViewerById returns undefined for unknown id", () => {
      expect(controller.getViewerById("nonexistent")).toBeUndefined()
    })
  })

  // --- Broadcasting ---

  describe("broadcasting", () => {
    beforeEach(() => {
      controller.setContainerElement(container)
      controller.setLayout("1x2")
    })

    test("setBroadcasting(true) enables broadcasting", () => {
      controller.setBroadcasting(true)
      expect(controller.isBroadcasting()).toBe(true)
      expect(controller.getSnapshot().isBroadcasting).toBe(true)
    })

    test("setBroadcasting(false) disables broadcasting", () => {
      controller.setBroadcasting(true)
      controller.setBroadcasting(false)
      expect(controller.isBroadcasting()).toBe(false)
      expect(controller.getSnapshot().isBroadcasting).toBe(false)
    })

    test("setBroadcasting(true) calls broadcastTo on all viewers", () => {
      clearMockInstances()
      controller.clearViewers()
      controller.setLayout("1x2")
      controller.setBroadcasting(true)

      for (const inst of mockInstances) {
        expect(inst.broadcastTo).toHaveBeenCalled()
      }
    })

    test("setBroadcasting(false) calls broadcastTo with empty array", () => {
      clearMockInstances()
      controller.clearViewers()
      controller.setLayout("1x2")
      controller.setBroadcasting(true)
      controller.setBroadcasting(false)

      for (const inst of mockInstances) {
        const lastCall =
          inst.broadcastTo.mock.calls[inst.broadcastTo.mock.calls.length - 1]
        expect(lastCall?.[0]).toEqual([])
      }
    })

    test("setBroadcasting(true) excludes viewers with no volumes or meshes", () => {
      clearMockInstances()
      controller.clearViewers()
      controller.setLayout("1x3")

      const nv0 = mockInstances[0]!
      const nv1 = mockInstances[1]!
      const nv2 = mockInstances[2]!

      nv0.volumes = [{ url: "a.nii", name: "a.nii" }]
      nv0.meshes = []
      nv1.volumes = [{ url: "b.nii", name: "b.nii" }]
      nv1.meshes = []
      nv2.volumes = []
      nv2.meshes = []

      expect(() => controller.setBroadcasting(true)).not.toThrow()

      const last0 =
        nv0.broadcastTo.mock.calls[nv0.broadcastTo.mock.calls.length - 1]
      const last1 =
        nv1.broadcastTo.mock.calls[nv1.broadcastTo.mock.calls.length - 1]
      const last2 =
        nv2.broadcastTo.mock.calls[nv2.broadcastTo.mock.calls.length - 1]

      expect(last0?.[0]).toEqual([nv1])
      expect(last1?.[0]).toEqual([nv0])
      expect(last2?.[0]).toEqual([])
    })

    test("image load auto-rewires broadcasting for a previously empty viewer", () => {
      const nv0 = mockInstances[0]!
      const nv1 = mockInstances[1]!
      nv0.volumes = [{ url: "a.nii", name: "a.nii" }]
      nv0.meshes = []
      nv1.volumes = []
      nv1.meshes = []

      controller.setBroadcasting(true)

      let last0 =
        nv0.broadcastTo.mock.calls[nv0.broadcastTo.mock.calls.length - 1]
      let last1 =
        nv1.broadcastTo.mock.calls[nv1.broadcastTo.mock.calls.length - 1]
      expect(last0?.[0]).toEqual([])
      expect(last1?.[0]).toEqual([])

      nv1.volumes = [{ url: "b.nii", name: "b.nii" }]
      nv1.emitEvent("volumeLoaded", {
        volume: { url: "b.nii", name: "b.nii" },
      })

      last0 = nv0.broadcastTo.mock.calls[nv0.broadcastTo.mock.calls.length - 1]
      last1 = nv1.broadcastTo.mock.calls[nv1.broadcastTo.mock.calls.length - 1]
      expect(last0?.[0]).toEqual([nv1])
      expect(last1?.[0]).toEqual([nv0])
    })

    test("mesh load auto-rewires broadcasting for a previously empty viewer", () => {
      const nv0 = mockInstances[0]!
      const nv1 = mockInstances[1]!
      nv0.volumes = [{ url: "a.nii", name: "a.nii" }]
      nv0.meshes = []
      nv1.volumes = []
      nv1.meshes = []

      controller.setBroadcasting(true)

      let last0 =
        nv0.broadcastTo.mock.calls[nv0.broadcastTo.mock.calls.length - 1]
      let last1 =
        nv1.broadcastTo.mock.calls[nv1.broadcastTo.mock.calls.length - 1]
      expect(last0?.[0]).toEqual([])
      expect(last1?.[0]).toEqual([])

      nv1.meshes = [{ id: "mesh-1" }]
      nv1.emitEvent("meshLoaded", {})

      last0 = nv0.broadcastTo.mock.calls[nv0.broadcastTo.mock.calls.length - 1]
      last1 = nv1.broadcastTo.mock.calls[nv1.broadcastTo.mock.calls.length - 1]
      expect(last0?.[0]).toEqual([nv1])
      expect(last1?.[0]).toEqual([nv0])
    })

    test("broadcast wiring errors are captured and emitted without throwing", () => {
      const nv0 = mockInstances[0]!
      const nv1 = mockInstances[1]!
      nv0.volumes = [{ url: "a.nii", name: "a.nii" }]
      nv0.meshes = []
      nv1.volumes = [{ url: "b.nii", name: "b.nii" }]
      nv1.meshes = []
      nv0.broadcastTo = mock(() => {
        throw new Error("broadcast failed")
      })

      const errorCb = mock((_index: number, _err: unknown) => {})
      controller.on("error", errorCb)

      expect(() => controller.setBroadcasting(true)).not.toThrow()
      expect(errorCb).toHaveBeenCalled()
      expect(nv1.broadcastTo).toHaveBeenCalled()
      expect(controller.getSnapshot().viewerStates[0]?.errors.length).toBe(1)
    })
  })

  // --- Slice layouts ---

  describe("slice layouts", () => {
    beforeEach(() => {
      controller.setContainerElement(container)
      controller.setLayout("2x2")
    })

    test("setViewerSliceLayout stores and applies custom layout", () => {
      const layout = [
        {
          sliceType: SLICE_TYPE.AXIAL,
          position: [0, 0, 1, 1] as [number, number, number, number],
        },
      ]
      controller.setViewerSliceLayout(0, layout)
      expect(controller.getViewerSliceLayout(0)).toEqual(layout)
    })

    test("getViewerSliceLayout returns null for default", () => {
      expect(controller.getViewerSliceLayout(0)).toBeNull()
    })

    test("setViewerSliceLayout with null resets to axial", () => {
      controller.setViewerSliceLayout(0, null)
      const nv = mockInstances[0]!
      expect(nv.sliceType).toBe(SLICE_TYPE.AXIAL)
      expect(nv.showRender).toBe(SHOW_RENDER.NEVER)
    })

    test("setViewerSliceLayout on invalid index is a no-op", () => {
      // Should not throw
      controller.setViewerSliceLayout(99, null)
    })

    test("getViewerSliceLayout on invalid index returns null", () => {
      expect(controller.getViewerSliceLayout(99)).toBeNull()
    })
  })

  // --- Loading / error state ---

  describe("loading and error state", () => {
    beforeEach(() => {
      controller.setContainerElement(container)
      controller.setLayout("1x1")
    })

    test("loadVolume increments and decrements loading count", async () => {
      const nv = mockInstances[mockInstances.length - 1]!
      let resolveVolume: (v: unknown) => void
      nv.addVolume = mock(
        () =>
          new Promise((resolve) => {
            resolveVolume = (v: unknown) => {
              nv.volumes.push(v)
              resolve(v)
            }
          }),
      )

      const promise = controller.loadVolume(0, { url: "test.nii" })
      expect(controller.getSnapshot().isLoading).toBe(true)

      resolveVolume?.({ url: "test.nii", name: "test.nii" })
      await promise
      expect(controller.getSnapshot().isLoading).toBe(false)
    })

    test("loadVolume emits volumeAdded on success", async () => {
      const cb = mock((_index: number, _opts: unknown, _image: unknown) => {})
      controller.on("volumeAdded", cb)

      await controller.loadVolume(0, { url: "test.nii" })
      expect(cb).toHaveBeenCalled()
      expect(cb.mock.calls[0]?.[0]).toBe(0)
    })

    test("loadVolume emits error on failure and records it", async () => {
      const nv = mockInstances[mockInstances.length - 1]!
      nv.addVolume = mock(() => Promise.reject(new Error("load failed")))

      const errorCb = mock((_index: number, _err: unknown) => {})
      controller.on("error", errorCb)

      await expect(
        controller.loadVolume(0, { url: "bad.nii" }),
      ).rejects.toThrow("load failed")
      expect(errorCb).toHaveBeenCalled()

      // Error should be recorded in viewerStates
      const state = controller.getSnapshot().viewerStates[0]!
      expect(state.errors.length).toBe(1)
    })

    test("loadVolume throws for invalid viewer index", async () => {
      await expect(
        controller.loadVolume(99, { url: "test.nii" }),
      ).rejects.toThrow("No viewer at index")
    })

    test("loadVolumes loads all volumes sequentially", async () => {
      const cb = mock((_index: number, _opts: unknown, _image: unknown) => {})
      controller.on("volumeAdded", cb)

      await controller.loadVolumes(0, [{ url: "a.nii" }, { url: "b.nii" }])
      expect(cb).toHaveBeenCalledTimes(2)
    })

    test("removeVolume emits volumeRemoved when volume is found", async () => {
      const nv = mockInstances[mockInstances.length - 1]!
      nv.volumes = [{ url: "test.nii", name: "test.nii" }]

      const cb = mock((_index: number, _url: string) => {})
      controller.on("volumeRemoved", cb)

      await controller.removeVolume(0, "test.nii")
      expect(cb).toHaveBeenCalledWith(0, "test.nii")
      expect(nv.model.removeVolume).toHaveBeenCalled()
    })

    test("removeVolume is a no-op when volume is not found", () => {
      const cb = mock((_index: number, _url: string) => {})
      controller.on("volumeRemoved", cb)
      controller.removeVolume(0, "nonexistent.nii")
      expect(cb).not.toHaveBeenCalled()
    })

    test("removeVolume is a no-op for invalid viewer index", () => {
      // Should not throw
      controller.removeVolume(99, "test.nii")
    })

    test("viewerStates tracks loading and errors per viewer", () => {
      const snap = controller.getSnapshot()
      expect(snap.viewerStates.length).toBe(1)
      expect(snap.viewerStates[0]?.loading).toBe(0)
      expect(snap.viewerStates[0]?.errors).toEqual([])
    })
  })

  // --- Exported constants ---

  describe("exported constants", () => {
    test("defaultSliceLayout has correct structure", () => {
      expect(defaultSliceLayout.length).toBe(3)
      for (const tile of defaultSliceLayout) {
        expect(tile).toHaveProperty("sliceType")
        expect(tile).toHaveProperty("position")
        expect(tile.position.length).toBe(4)
      }
    })

    test("splitSliceLayout has 3 tiles", () => {
      expect(splitSliceLayout.length).toBe(3)
    })

    test("triSliceLayout has 3 tiles", () => {
      expect(triSliceLayout.length).toBe(3)
    })

    test("stackedSliceLayout has 3 tiles", () => {
      expect(stackedSliceLayout.length).toBe(3)
    })

    test("quadSliceLayout has 4 tiles including RENDER", () => {
      expect(quadSliceLayout.length).toBe(4)
      const renderTile = quadSliceLayout.find(
        (t) => t.sliceType === SLICE_TYPE.RENDER,
      )
      expect(renderTile).toBeDefined()
    })

    test("heroRenderSliceLayout has 4 tiles with RENDER as first", () => {
      expect(heroRenderSliceLayout.length).toBe(4)
      expect(heroRenderSliceLayout[0]?.sliceType).toBe(SLICE_TYPE.RENDER)
    })

    test("defaultSliceLayouts has expected keys", () => {
      const keys = Object.keys(defaultSliceLayouts)
      expect(keys).toContain("axial-hero")
      expect(keys).toContain("sag-left")
      expect(keys).toContain("tri-h")
      expect(keys).toContain("tri-v")
      expect(keys).toContain("quad-render")
      expect(keys).toContain("render-hero")
    })

    test("each defaultSliceLayout entry has label and layout", () => {
      for (const config of Object.values(defaultSliceLayouts)) {
        expect(typeof config.label).toBe("string")
        expect(Array.isArray(config.layout)).toBe(true)
        expect(config.layout.length).toBeGreaterThan(0)
      }
    })

    test("defaultViewerOptions has crosshairGap", () => {
      expect(defaultViewerOptions).toHaveProperty("crosshairGap")
      expect(defaultViewerOptions.crosshairGap).toBe(5)
    })
  })

  // --- Colormap / intensity / opacity ---

  describe("colormap and intensity controls", () => {
    beforeEach(() => {
      controller.setContainerElement(container)
      controller.setLayout("1x1")
    })

    function setupVolumeOnViewer() {
      const nv = mockInstances[mockInstances.length - 1]!
      nv.volumes = [
        {
          url: "brain.nii",
          name: "brain.nii",
          colormap: "gray",
          calMin: 0,
          calMax: 255,
          opacity: 1.0,
        },
      ]
      return nv
    }

    // --- setColormap ---

    test("setColormap calls setVolume with colormap", async () => {
      const nv = setupVolumeOnViewer()
      await controller.setColormap(0, 0, "hot")
      expect(nv.setVolume).toHaveBeenCalledWith(
        0,
        expect.objectContaining({ colormap: "hot" }),
      )
    })

    test("setColormap emits colormapChanged event", async () => {
      setupVolumeOnViewer()
      const cb = mock(
        (_viewerIndex: number, _volumeIndex: number, _colormap: string) => {},
      )
      controller.on("colormapChanged", cb)
      await controller.setColormap(0, 0, "hot")
      expect(cb).toHaveBeenCalledWith(0, 0, "hot")
    })

    test("setColormap notifies subscribers", async () => {
      setupVolumeOnViewer()
      const listener = mock(() => {})
      controller.subscribe(listener)
      const callsBefore = listener.mock.calls.length
      await controller.setColormap(0, 0, "hot")
      expect(listener.mock.calls.length).toBeGreaterThan(callsBefore)
    })

    test("setColormap is a no-op for invalid viewer index", async () => {
      setupVolumeOnViewer()
      const cb = mock(
        (_viewerIndex: number, _volumeIndex: number, _colormap: string) => {},
      )
      controller.on("colormapChanged", cb)
      await controller.setColormap(99, 0, "hot")
      expect(cb).not.toHaveBeenCalled()
    })

    test("setColormap is a no-op for invalid volume index", async () => {
      setupVolumeOnViewer()
      const cb = mock(
        (_viewerIndex: number, _volumeIndex: number, _colormap: string) => {},
      )
      controller.on("colormapChanged", cb)
      await controller.setColormap(0, 5, "hot")
      expect(cb).not.toHaveBeenCalled()
    })

    // --- setCalMinMax ---

    test("setCalMinMax calls setVolume with calMin and calMax", async () => {
      const nv = setupVolumeOnViewer()
      await controller.setCalMinMax(0, 0, 50, 200)
      expect(nv.setVolume).toHaveBeenCalledWith(
        0,
        expect.objectContaining({ calMin: 50, calMax: 200 }),
      )
    })

    test("setCalMinMax emits intensityChanged event", async () => {
      setupVolumeOnViewer()
      const cb = mock(
        (
          _viewerIndex: number,
          _volumeIndex: number,
          _min: number,
          _max: number,
        ) => {},
      )
      controller.on("intensityChanged", cb)
      await controller.setCalMinMax(0, 0, 50, 200)
      expect(cb).toHaveBeenCalledWith(0, 0, 50, 200)
    })

    test("setCalMinMax notifies subscribers", async () => {
      setupVolumeOnViewer()
      const listener = mock(() => {})
      controller.subscribe(listener)
      const callsBefore = listener.mock.calls.length
      await controller.setCalMinMax(0, 0, 50, 200)
      expect(listener.mock.calls.length).toBeGreaterThan(callsBefore)
    })

    test("setCalMinMax is a no-op for invalid viewer index", async () => {
      setupVolumeOnViewer()
      const cb = mock(
        (
          _viewerIndex: number,
          _volumeIndex: number,
          _min: number,
          _max: number,
        ) => {},
      )
      controller.on("intensityChanged", cb)
      await controller.setCalMinMax(99, 0, 50, 200)
      expect(cb).not.toHaveBeenCalled()
    })

    test("setCalMinMax is a no-op for invalid volume index", async () => {
      setupVolumeOnViewer()
      const cb = mock(
        (
          _viewerIndex: number,
          _volumeIndex: number,
          _min: number,
          _max: number,
        ) => {},
      )
      controller.on("intensityChanged", cb)
      await controller.setCalMinMax(0, 5, 50, 200)
      expect(cb).not.toHaveBeenCalled()
    })

    // --- setOpacity ---

    test("setOpacity calls setVolume with opacity", async () => {
      const nv = setupVolumeOnViewer()
      await controller.setOpacity(0, 0, 0.5)
      expect(nv.setVolume).toHaveBeenCalledWith(
        0,
        expect.objectContaining({ opacity: 0.5 }),
      )
    })

    test("setOpacity emits opacityChanged event", async () => {
      setupVolumeOnViewer()
      const cb = mock(
        (_viewerIndex: number, _volumeIndex: number, _opacity: number) => {},
      )
      controller.on("opacityChanged", cb)
      await controller.setOpacity(0, 0, 0.5)
      expect(cb).toHaveBeenCalledWith(0, 0, 0.5)
    })

    test("setOpacity notifies subscribers", async () => {
      setupVolumeOnViewer()
      const listener = mock(() => {})
      controller.subscribe(listener)
      const callsBefore = listener.mock.calls.length
      await controller.setOpacity(0, 0, 0.5)
      expect(listener.mock.calls.length).toBeGreaterThan(callsBefore)
    })

    test("setOpacity is a no-op for invalid viewer index", async () => {
      setupVolumeOnViewer()
      const cb = mock(
        (_viewerIndex: number, _volumeIndex: number, _opacity: number) => {},
      )
      controller.on("opacityChanged", cb)
      await controller.setOpacity(99, 0, 0.5)
      expect(cb).not.toHaveBeenCalled()
    })

    test("setOpacity is a no-op for invalid volume index", async () => {
      setupVolumeOnViewer()
      const cb = mock(
        (_viewerIndex: number, _volumeIndex: number, _opacity: number) => {},
      )
      controller.on("opacityChanged", cb)
      await controller.setOpacity(0, 5, 0.5)
      expect(cb).not.toHaveBeenCalled()
    })
  })
})
