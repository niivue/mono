import { beforeEach, describe, expect, test } from "bun:test"
import { render } from "@testing-library/react"
import { clearMockInstances, registerNiivueMock } from "./__mocks__/niivue"

registerNiivueMock()

import { NvScene } from "./nvscene"
import { NvSceneController } from "./nvscene-controller"

describe("NvScene", () => {
  let controller: NvSceneController

  beforeEach(() => {
    clearMockInstances()
    controller = new NvSceneController()
  })

  test("renders a div element", () => {
    const { container } = render(<NvScene scene={controller} />)
    const div = container.firstElementChild
    expect(div).toBeDefined()
    expect(div?.tagName).toBe("DIV")
  })

  test("calls setContainerElement with the div ref on mount", () => {
    render(<NvScene scene={controller} />)
    expect(controller.containerElement).not.toBeNull()
    expect(controller.containerElement).toBeInstanceOf(HTMLDivElement)
  })

  test("calls setContainerElement(null) on unmount", () => {
    const { unmount } = render(<NvScene scene={controller} />)
    expect(controller.containerElement).not.toBeNull()
    unmount()
    expect(controller.containerElement).toBeNull()
  })

  test("sets initial layout when no viewers exist", () => {
    render(<NvScene scene={controller} initialLayout="2x2" />)
    expect(controller.currentLayout).toBe("2x2")
  })

  test("defaults initialLayout to 1x1", () => {
    render(<NvScene scene={controller} />)
    expect(controller.currentLayout).toBe("1x1")
  })

  test("passes className to the container div", () => {
    const { container } = render(
      <NvScene scene={controller} className="my-scene" />,
    )
    const div = container.firstElementChild as HTMLElement
    expect(div.className).toBe("my-scene")
  })

  test("passes style to the container div", () => {
    const { container } = render(
      <NvScene scene={controller} style={{ border: "1px solid red" }} />,
    )
    const div = container.firstElementChild as HTMLElement
    expect(div.style.border).toBe("1px solid red")
  })

  test("creates at least one viewer on mount with default layout", () => {
    render(<NvScene scene={controller} />)
    expect(controller.viewers.length).toBeGreaterThanOrEqual(1)
  })
})
