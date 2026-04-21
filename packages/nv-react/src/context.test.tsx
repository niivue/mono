import { describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { clearMockInstances, registerNiivueMock } from './__mocks__/niivue'

registerNiivueMock()

import { NvSceneProvider, useSceneContext } from './context'
import { NvSceneController } from './nvscene-controller'

/** Helper component that reads context and renders the layout name */
function ContextReader() {
  const scene = useSceneContext()
  return <div data-testid="layout">{scene.currentLayout}</div>
}

/** Helper component that calls useSceneContext outside a provider */
function OrphanReader() {
  try {
    // biome-ignore lint/correctness/useHookAtTopLevel: testing error behavior
    useSceneContext()
    return <div data-testid="result">ok</div>
  } catch (err) {
    return <div data-testid="result">{(err as Error).message}</div>
  }
}

describe('NvSceneProvider', () => {
  test('provides the controller to children via context', () => {
    clearMockInstances()
    const scene = new NvSceneController()
    render(
      <NvSceneProvider scene={scene}>
        <ContextReader />
      </NvSceneProvider>,
    )
    expect(screen.getByTestId('layout').textContent).toBe('1x1')
  })

  test('provides updated controller when scene changes', () => {
    clearMockInstances()
    const scene = new NvSceneController()
    scene.currentLayout = '2x2'
    render(
      <NvSceneProvider scene={scene}>
        <ContextReader />
      </NvSceneProvider>,
    )
    expect(screen.getByTestId('layout').textContent).toBe('2x2')
  })

  test('renders children', () => {
    clearMockInstances()
    const scene = new NvSceneController()
    render(
      <NvSceneProvider scene={scene}>
        <div data-testid="child">Hello</div>
      </NvSceneProvider>,
    )
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })
})

describe('useSceneContext', () => {
  test('throws when used outside NvSceneProvider', () => {
    render(<OrphanReader />)
    const result = screen.getByTestId('result')
    expect(result.textContent).toBe(
      'useSceneContext must be used within an NvSceneProvider',
    )
  })

  test('returns the controller when inside a provider', () => {
    clearMockInstances()
    const scene = new NvSceneController()
    render(
      <NvSceneProvider scene={scene}>
        <ContextReader />
      </NvSceneProvider>,
    )
    // If it didn't throw, context was successfully read
    expect(screen.getByTestId('layout')).toBeInTheDocument()
  })
})
