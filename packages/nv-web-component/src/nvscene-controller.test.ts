import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  attachToCanvasResults,
  clearMockInstances,
  mockInstances,
  registerNiivueMock,
  SLICE_TYPE,
} from './__mocks__/niivue'

registerNiivueMock()

import { NvSceneController, type SliceLayoutTile } from './nvscene-controller'

class TestElement {
  className = ''
  style: Record<string, string> = {}
  width = 0
  height = 0
  children: TestElement[] = []
  parent: TestElement | null = null

  appendChild(child: TestElement): void {
    child.parent = this
    this.children.push(child)
  }

  remove(): void {
    if (!this.parent) return
    this.parent.children = this.parent.children.filter(
      (child) => child !== this,
    )
    this.parent = null
  }
}

const createElement = (): TestElement => new TestElement()

const flushPromises = (): Promise<void> => Promise.resolve()

describe('NvSceneController', () => {
  let controller: NvSceneController
  let container: HTMLElement

  beforeEach(() => {
    clearMockInstances()
    globalThis.document = {
      createElement,
    } as unknown as Document
    controller = new NvSceneController()
    container = createElement() as unknown as HTMLElement
    controller.setContainerElement(container)
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'document')
  })

  test('waits for canvas attachment before loading volumes', async () => {
    let resolveAttach: () => void = () => {}
    attachToCanvasResults.push(
      new Promise<void>((resolve) => {
        resolveAttach = resolve
      }),
    )
    const viewerReady = controller.addViewer()

    const loadPromise = controller.loadVolume(0, { url: 'brain.nii.gz' })
    expect(mockInstances[0]?.addVolume).not.toHaveBeenCalled()

    resolveAttach()
    await viewerReady
    await loadPromise

    expect(mockInstances[0]?.addVolume).toHaveBeenCalledWith({
      url: 'brain.nii.gz',
    })
  })

  test('preserves slice layout requested while attachment is pending', async () => {
    let resolveAttach: () => void = () => {}
    attachToCanvasResults.push(
      new Promise<void>((resolve) => {
        resolveAttach = resolve
      }),
    )
    const addPromise = controller.addViewer()
    const layout: SliceLayoutTile[] = [
      { sliceType: SLICE_TYPE.CORONAL, position: [0, 0, 1, 1] },
    ]

    controller.setViewerSliceLayout(0, layout)
    resolveAttach()
    await addPromise
    await flushPromises()

    expect(mockInstances[0]?.customLayout).toBe(layout)
  })

  test('removes a viewer when attachment fails', async () => {
    const expectedError = new Error('attach failed')
    attachToCanvasResults.push(Promise.reject(expectedError))
    const addPromise = controller.addViewer()

    await expect(addPromise).rejects.toThrow('attach failed')

    expect(controller.getSnapshot().viewerCount).toBe(0)
    expect((container as unknown as TestElement).children).toHaveLength(0)
    expect(mockInstances[0]?.destroy).toHaveBeenCalled()
  })
})
