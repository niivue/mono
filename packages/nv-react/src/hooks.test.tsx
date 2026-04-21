import { beforeEach, describe, expect, mock, test } from "bun:test"
import { act, renderHook } from "@testing-library/react"
import { clearMockInstances, registerNiivueMock } from "./__mocks__/niivue"

registerNiivueMock()

import { useNiivue, useScene, useSceneEvent } from "./hooks"
import { NvSceneController } from "./nvscene-controller"

describe("useScene", () => {
  beforeEach(() => {
    clearMockInstances()
  })

  test("creates a new NvSceneController when no controller is passed", () => {
    const { result } = renderHook(() => useScene())
    expect(result.current.scene).toBeInstanceOf(NvSceneController)
    expect(result.current.snapshot).toBeDefined()
  })

  test("uses the provided controller when passed", () => {
    const controller = new NvSceneController()
    const { result } = renderHook(() => useScene(controller))
    expect(result.current.scene).toBe(controller)
  })

  test("returns snapshot matching getSnapshot()", () => {
    const controller = new NvSceneController()
    const { result } = renderHook(() => useScene(controller))
    expect(result.current.snapshot).toEqual(controller.getSnapshot())
  })

  test("snapshot updates when controller state changes", () => {
    const controller = new NvSceneController()
    const { result } = renderHook(() => useScene(controller))

    const initialSnapshot = result.current.snapshot
    expect(initialSnapshot.currentLayout).toBe("1x1")

    // Change state
    act(() => {
      const container = document.createElement("div")
      controller.setContainerElement(container)
      controller.setLayout("2x2")
    })

    expect(result.current.snapshot.currentLayout).toBe("2x2")
    expect(result.current.snapshot).not.toBe(initialSnapshot)
  })

  test("returns same controller reference across re-renders", () => {
    const controller = new NvSceneController()
    const { result, rerender } = renderHook(() => useScene(controller))
    const firstScene = result.current.scene
    rerender()
    expect(result.current.scene).toBe(firstScene)
  })
})

describe("useNiivue", () => {
  beforeEach(() => {
    clearMockInstances()
  })

  test("returns undefined when index >= viewerCount", () => {
    const controller = new NvSceneController()
    const { result } = renderHook(() => useNiivue(controller, 0))
    expect(result.current).toBeUndefined()
  })

  test("returns the Niivue instance when viewer exists at index", () => {
    const controller = new NvSceneController()
    const container = document.createElement("div")
    controller.setContainerElement(container)

    const { result } = renderHook(() => useNiivue(controller, 0))

    act(() => {
      controller.setLayout("1x1")
    })

    expect(result.current).toBeDefined()
    expect(result.current).toBe(controller.getNiivue(0))
  })

  test("returns undefined after viewer is removed", () => {
    const controller = new NvSceneController()
    const container = document.createElement("div")
    controller.setContainerElement(container)
    // setLayout("1x2") creates 2 viewers filling both slots
    controller.setLayout("1x2")

    const { result } = renderHook(() => useNiivue(controller, 1))
    expect(result.current).toBeDefined()

    act(() => {
      controller.removeViewer(1)
    })

    expect(result.current).toBeUndefined()
  })
})

describe("useSceneEvent", () => {
  beforeEach(() => {
    clearMockInstances()
  })

  test("subscribes to events and calls callback when event fires", () => {
    const controller = new NvSceneController()
    const container = document.createElement("div")
    controller.setContainerElement(container)
    // setLayout fills all slots; use 1x2 so there's room after removing one
    controller.setLayout("1x2")

    const callback = mock((_nv: unknown, _index: number) => {})

    renderHook(() => useSceneEvent(controller, "viewerCreated", callback))

    // Remove one so addViewer can create a new one and fire viewerCreated
    controller.removeViewer(1)
    act(() => {
      controller.addViewer()
    })

    expect(callback).toHaveBeenCalled()
  })

  test("cleans up subscription on unmount", () => {
    const controller = new NvSceneController()
    const container = document.createElement("div")
    controller.setContainerElement(container)
    controller.setLayout("1x2")

    const callback = mock((_nv: unknown, _index: number) => {})

    const { unmount } = renderHook(() =>
      useSceneEvent(controller, "viewerCreated", callback),
    )

    unmount()

    // Remove and re-add a viewer after unmount — should not trigger the callback
    controller.removeViewer(1)
    controller.addViewer()
    expect(callback).not.toHaveBeenCalled()
  })

  test("uses latest callback without re-subscribing", () => {
    const controller = new NvSceneController()
    const container = document.createElement("div")
    controller.setContainerElement(container)
    controller.setLayout("1x2")

    const callback1 = mock((_nv: unknown, _index: number) => {})
    const callback2 = mock((_nv: unknown, _index: number) => {})

    const { rerender } = renderHook(
      ({ cb }) => useSceneEvent(controller, "viewerCreated", cb),
      { initialProps: { cb: callback1 } },
    )

    // Update the callback
    rerender({ cb: callback2 })

    // Remove one so addViewer can fire viewerCreated
    controller.removeViewer(1)
    act(() => {
      controller.addViewer()
    })

    // callback2 should be called (latest ref), not callback1
    expect(callback2).toHaveBeenCalled()
    expect(callback1).not.toHaveBeenCalled()
  })
})
