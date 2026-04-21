// biome-ignore-all lint/style/noNonNullAssertion: test file — assertions on mock instances are safe
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { render } from '@testing-library/react'
import {
  clearMockInstances,
  mockInstances,
  registerNiivueMock,
} from './__mocks__/niivue'

registerNiivueMock()

import { NvViewer } from './nvviewer'

describe('NvViewer', () => {
  beforeEach(() => {
    clearMockInstances()
  })

  test('renders a container div with position relative', () => {
    const { container } = render(<NvViewer />)
    const div = container.firstElementChild as HTMLElement
    expect(div).toBeDefined()
    expect(div.tagName).toBe('DIV')
    expect(div.style.position).toBe('relative')
  })

  test('creates a canvas element inside the container', () => {
    const { container } = render(<NvViewer />)
    const div = container.firstElementChild as HTMLElement
    const canvas = div.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas?.className).toBe('niivue-canvas')
  })

  test('creates a Niivue instance and attaches to canvas', () => {
    render(<NvViewer />)
    expect(mockInstances.length).toBeGreaterThanOrEqual(1)
    const nv = mockInstances[0]!
    expect(nv.attachToCanvas).toHaveBeenCalled()
  })

  test('sets sliceType to default AXIAL after attach', async () => {
    render(<NvViewer />)
    const nv = mockInstances[0]!
    // attachToCanvas returns a resolved promise; wait for microtask
    await Promise.resolve()
    expect(nv.sliceType).toBe(0) // SLICE_TYPE.AXIAL
  })

  test('sets sliceType to provided value after attach', async () => {
    // SLICE_TYPE.CORONAL = 1
    render(<NvViewer sliceType={1} />)
    const nv = mockInstances[0]!
    await Promise.resolve()
    expect(nv.sliceType).toBe(1)
  })

  test('passes className to the container div', () => {
    const { container } = render(<NvViewer className="my-viewer" />)
    const div = container.firstElementChild as HTMLElement
    expect(div.className).toBe('my-viewer')
  })

  test('passes style to the container div (merged with position: relative)', () => {
    const { container } = render(
      <NvViewer style={{ width: '500px', height: '400px' }} />,
    )
    const div = container.firstElementChild as HTMLElement
    expect(div.style.position).toBe('relative')
    expect(div.style.width).toBe('500px')
    expect(div.style.height).toBe('400px')
  })

  test('cleans up canvas on unmount', () => {
    const { container, unmount } = render(<NvViewer />)
    const div = container.firstElementChild as HTMLElement

    // Canvas should exist before unmount
    expect(div.querySelector('canvas')).not.toBeNull()

    unmount()

    // After unmount, the canvas should be removed from the container
    // (cleanup removes it from DOM)
    expect(div.querySelector('canvas')).toBeNull()
  })

  test('volume diffing: adding volumes calls addVolume', () => {
    const volumes = [{ url: 'brain.nii' }]
    render(<NvViewer volumes={volumes} />)
    const nv = mockInstances[0]!
    expect(nv.addVolume).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'brain.nii' }),
    )
  })

  test('volume diffing: adding multiple volumes', () => {
    const volumes = [{ url: 'a.nii' }, { url: 'b.nii' }]
    render(<NvViewer volumes={volumes} />)
    const nv = mockInstances[0]!
    expect(nv.addVolume).toHaveBeenCalledTimes(2)
  })

  test('volume diffing: no volumes results in no addVolume calls', () => {
    render(<NvViewer />)
    const nv = mockInstances[0]!
    expect(nv.addVolume).not.toHaveBeenCalled()
  })

  test('wires onLocationChange callback via addEventListener', () => {
    const onLocationChange = mock((_data: unknown) => {})
    render(<NvViewer onLocationChange={onLocationChange} />)
    const nv = mockInstances[0]!

    // Simulate Niivue emitting locationChange
    nv.emitEvent('locationChange', { x: 1, y: 2, z: 3 })
    expect(onLocationChange).toHaveBeenCalledWith({ x: 1, y: 2, z: 3 })
  })

  test('wires onImageLoaded callback via addEventListener', () => {
    const onImageLoaded = mock((_vol: unknown) => {})
    render(<NvViewer onImageLoaded={onImageLoaded} />)
    const nv = mockInstances[0]!

    // Simulate Niivue emitting volumeLoaded
    const fakeVol = { url: 'test.nii', name: 'test.nii' }
    nv.emitEvent('volumeLoaded', { volume: fakeVol })
    expect(onImageLoaded).toHaveBeenCalledWith(fakeVol)
  })

  // --- Volume visual prop diffing ---

  describe('volume visual prop diffing', () => {
    test('changing colormap calls setVolume with new colormap', () => {
      const volumes1 = [{ url: 'brain.nii', colormap: 'gray' }]
      const { rerender } = render(<NvViewer volumes={volumes1} />)
      const nv = mockInstances[0]!

      // Simulate that the volume is loaded in nv.volumes
      const fakeVol = {
        url: 'brain.nii',
        name: 'brain.nii',
        colormap: 'gray',
        calMin: 0,
        calMax: 255,
        opacity: 1.0,
      }
      nv.volumes = [fakeVol]

      // Re-render with a different colormap
      const volumes2 = [{ url: 'brain.nii', colormap: 'hot' }]
      rerender(<NvViewer volumes={volumes2} />)

      expect(nv.setVolume).toHaveBeenCalledWith(
        0,
        expect.objectContaining({ colormap: 'hot' }),
      )
    })

    test('changing calMin/calMax calls setVolume with new values', () => {
      const volumes1 = [{ url: 'brain.nii', calMin: 0, calMax: 255 }]
      const { rerender } = render(<NvViewer volumes={volumes1} />)
      const nv = mockInstances[0]!

      const fakeVol = {
        url: 'brain.nii',
        name: 'brain.nii',
        colormap: 'gray',
        calMin: 0,
        calMax: 255,
        opacity: 1.0,
      }
      nv.volumes = [fakeVol]

      const volumes2 = [{ url: 'brain.nii', calMin: 50, calMax: 200 }]
      rerender(<NvViewer volumes={volumes2} />)

      expect(nv.setVolume).toHaveBeenCalledWith(
        0,
        expect.objectContaining({ calMin: 50, calMax: 200 }),
      )
    })

    test('changing opacity calls setVolume with new opacity', () => {
      const volumes1 = [{ url: 'brain.nii', opacity: 1.0 }]
      const { rerender } = render(<NvViewer volumes={volumes1} />)
      const nv = mockInstances[0]!

      const fakeVol = {
        url: 'brain.nii',
        name: 'brain.nii',
        colormap: 'gray',
        calMin: 0,
        calMax: 255,
        opacity: 1.0,
      }
      nv.volumes = [fakeVol]

      const volumes2 = [{ url: 'brain.nii', opacity: 0.5 }]
      rerender(<NvViewer volumes={volumes2} />)

      expect(nv.setVolume).toHaveBeenCalledWith(
        0,
        expect.objectContaining({ opacity: 0.5 }),
      )
    })

    test('same visual props do not trigger setVolume', () => {
      const volumes1 = [
        {
          url: 'brain.nii',
          colormap: 'gray',
          calMin: 0,
          calMax: 255,
          opacity: 1.0,
        },
      ]
      const { rerender } = render(<NvViewer volumes={volumes1} />)
      const nv = mockInstances[0]!

      const fakeVol = {
        url: 'brain.nii',
        name: 'brain.nii',
        colormap: 'gray',
        calMin: 0,
        calMax: 255,
        opacity: 1.0,
      }
      nv.volumes = [fakeVol]

      // Reset call counts
      nv.setVolume.mockClear()

      // Re-render with same props (new array reference but same values)
      const volumes2 = [
        {
          url: 'brain.nii',
          colormap: 'gray',
          calMin: 0,
          calMax: 255,
          opacity: 1.0,
        },
      ]
      rerender(<NvViewer volumes={volumes2} />)

      expect(nv.setVolume).not.toHaveBeenCalled()
    })

    test('does not re-add a volume when only visual props change', () => {
      const volumes1 = [{ url: 'brain.nii', colormap: 'gray' }]
      const { rerender } = render(<NvViewer volumes={volumes1} />)
      const nv = mockInstances[0]!

      const fakeVol = { url: 'brain.nii', name: 'brain.nii', colormap: 'gray' }
      nv.volumes = [fakeVol]

      // Clear the addVolume count
      nv.addVolume.mockClear()

      const volumes2 = [{ url: 'brain.nii', colormap: 'hot' }]
      rerender(<NvViewer volumes={volumes2} />)

      // Should NOT re-add the volume
      expect(nv.addVolume).not.toHaveBeenCalled()
    })
  })
})
