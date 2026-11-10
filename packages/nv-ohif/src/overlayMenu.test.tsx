import { afterEach, describe, expect, it } from 'bun:test'
import type NiiVue from '@niivue/niivue'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  getNiivueEntryForViewport,
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
import { overlayMenuComponent, overlayMenuState } from './overlayMenu'
import { getNiivueToolbarModule, NIIVUE_TOOLBAR_BUTTONS } from './toolbar'

afterEach(() => unregisterNiivue('vp-1'))

const study = [
  { displaySetInstanceUID: 'ds-base', SeriesDescription: 'T1' },
  {
    displaySetInstanceUID: 'ds-a',
    SeriesDescription: 'PET',
    url: 'https://x/a.nii.gz',
  },
  { displaySetInstanceUID: 'ds-b', SeriesNumber: 7, url: 'https://x/b.nii' },
  { displaySetInstanceUID: 'ds-c', url: 'https://x/c.nii' },
  {
    displaySetInstanceUID: 'ds-seg',
    Modality: 'SEG',
    instances: [
      { imageId: 'wadors:https://h/studies/1/series/2/instances/3/frames/1' },
    ],
  },
]

// A NiiVue viewport with base T1 and overlays a (bottom) then b (top).
function viewport() {
  const a = { hdr: {}, colormap: 'Warm', opacity: 0.5 }
  const b = { hdr: {}, colormap: 'redyell', opacity: 0.8, visible: false }
  registerNiivue('vp-1', { volumes: [{ hdr: {} }, a, b] } as unknown as NiiVue)
  updateNiivueViewport('vp-1', {
    displaySets: [study[0] ?? {}],
    overlays: new Map([
      ['ds-a', a.hdr as never],
      ['ds-b', b.hdr as never],
    ]),
  })
  const entry = getNiivueEntryForViewport('vp-1')
  if (!entry) throw new Error('entry missing')
  return entry
}

const services = {
  services: {
    viewportGridService: { getActiveViewportId: () => 'vp-1' },
    displaySetService: { getActiveDisplaySets: () => study },
  },
}

// The element with this aria-label in a rendered tree.
function byLabel(node: unknown, label: string): ReactElement | undefined {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = byLabel(child, label)
      if (hit) return hit
    }
    return undefined
  }
  const element = node as ReactElement<Record<string, unknown>>
  if (element.props?.['aria-label'] === label) return element
  return byLabel(element.props?.children, label)
}

describe('overlayMenuState', () => {
  it('lists the overlays top layer first and the series left to add', () => {
    const { overlays, candidates } = overlayMenuState(viewport(), study)
    expect(overlays).toEqual([
      {
        uid: 'ds-b',
        label: 'Series 7',
        visible: false,
        opacity: 0.8,
        colormap: 'redyell',
        canMoveUp: false,
        canMoveDown: true,
      },
      {
        uid: 'ds-a',
        label: 'PET',
        visible: true,
        opacity: 0.5,
        colormap: 'Warm',
        canMoveUp: true,
        canMoveDown: false,
      },
    ])
    expect(candidates).toEqual([{ uid: 'ds-c', label: 'ds-c' }])
  })
})

describe('NiivueOverlayMenu', () => {
  it('renders a disabled button with the reason when evaluated disabled', () => {
    viewport()
    const Menu = overlayMenuComponent({ servicesManager: services })
    const html = renderToStaticMarkup(
      <Menu label="Overlays" disabled disabledText="No base" />,
    )
    expect(html).toBe(
      '<button type="button" disabled="" title="No base">Overlays</button>',
    )
  })

  it('renders the add list and one control row per overlay', () => {
    viewport()
    const Menu = overlayMenuComponent({ servicesManager: services })
    const html = renderToStaticMarkup(<Menu />)
    expect(html).toContain('<option value="ds-c">ds-c</option>')
    // An overlay colormap missing from the menu list stays selectable.
    expect(html).toContain(
      '<option value="redyell" selected="">redyell</option>',
    )
    expect(html).toContain('<option value="warm" selected="">Warm</option>')
    expect(html.match(/aria-label="Remove /g)).toHaveLength(2)
  })

  it('sends each control to its overlay command on the NIIVUE context', () => {
    viewport()
    const calls: unknown[][] = []
    const Menu = overlayMenuComponent({
      servicesManager: services,
      commandsManager: { runCommand: (...args) => calls.push(args) },
    })
    const tree = Menu({})
    const click = (label: string) =>
      (byLabel(tree, label)?.props as { onClick: () => void }).onClick()
    const change = (label: string, target: Record<string, unknown>) =>
      (
        byLabel(tree, label)?.props as {
          onChange: (e: { target: Record<string, unknown> }) => void
        }
      ).onChange({ target })
    click('Move Series 7 down')
    click('Move PET up')
    click('Remove PET')
    change('Show Series 7', { checked: true })
    change('PET colormap', { value: 'hot' })
    change('PET opacity', { value: '0.25' })
    change('Add overlay', { value: 'ds-c' })
    const a = { displaySetInstanceUID: 'ds-a' }
    expect(calls).toEqual([
      [
        'niivueMoveOverlay',
        { displaySetInstanceUID: 'ds-b', direction: 'down' },
        'NIIVUE',
      ],
      ['niivueMoveOverlay', { ...a, direction: 'up' }, 'NIIVUE'],
      ['niivueRemoveOverlay', a, 'NIIVUE'],
      [
        'niivueSetOverlayVisible',
        { displaySetInstanceUID: 'ds-b', visible: true },
        'NIIVUE',
      ],
      ['setViewportColormap', { ...a, colormap: 'hot' }, 'NIIVUE'],
      ['setViewportColormap', { ...a, opacity: 0.25 }, 'NIIVUE'],
      ['niivueAddOverlay', { displaySetInstanceUID: 'ds-c' }, 'NIIVUE'],
    ])
  })

  it('is the uiType component of the Overlays button, gated like Overlay', () => {
    const button = NIIVUE_TOOLBAR_BUTTONS.find(
      (b) => b.id === 'NiivueOverlayMenu',
    )
    const module = getNiivueToolbarModule({ servicesManager: services })
    expect(
      module.find((e) => e.name === button?.uiType)?.defaultComponent,
    ).toBeFunction()
    expect(button?.props.evaluate).toBe('evaluate.niivue.overlay')
  })
})
