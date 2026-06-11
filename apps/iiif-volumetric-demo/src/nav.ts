// Shared cross-page nav. Each working demo page has an empty
// `<div class="links" data-nav-links></div>` slot (typically in its header)
// and calls installNav() from its entry module. The function rebuilds the
// slot with the canonical list of pages so adding/removing a demo is a
// single-file edit here.
//
// The nav also renders a WebGPU/WebGL2 backend toggle that reloads the
// current page with the new `?backend=` query, so manual verification is
// symmetric across both NiiVue backends (see packages/niivue/AGENTS.md
// "Backend feature parity"). The toggle is hidden on pages that don't
// use NiiVue (e.g. stitch.html).

import { backendSwitchUrl, getBackendFromUrl } from './backend'

type Page = { href: string; label: string }

const PAGES: Page[] = [
  { href: '/index.html', label: 'volumes' },
  { href: '/sheet.html', label: 'sheet' },
  { href: '/osd-volume-desktop.html', label: 'osd desktop' },
  { href: '/omezarr.html', label: 'omezarr' },
  { href: '/range.html', label: 'range' },
  { href: '/multiplanar.html', label: 'multiplanar' },
  { href: '/overlay.html', label: 'overlay' },
  { href: '/microscopy.html', label: 'microscopy' },
  { href: '/drawing.html', label: 'drawing' },
  { href: '/wsi.html', label: 'wsi' },
]

// Endpoints exposed by the IIIF server — handy to reach from any page when
// debugging the server side.
const ENDPOINTS: Page[] = [
  { href: '/api', label: '/api' },
  { href: '/iiif/presentation', label: '/iiif/presentation' },
]

let stylesInstalled = false

function installActiveStyles(): void {
  if (stylesInstalled) return
  const css = `
    [data-nav-links] a[aria-current='page'] {
      color: #e8eaed;
      font-weight: 600;
      text-decoration: underline;
      text-decoration-color: #8ab4f8;
      text-underline-offset: 3px;
    }
    [data-nav-links] .sep {
      color: #2a2d31;
      margin: 0 4px;
      pointer-events: none;
    }
    [data-nav-links] .backend-toggle {
      display: inline-flex;
      gap: 0;
      margin-left: 8px;
      border: 1px solid #2a2d31;
      border-radius: 4px;
      overflow: hidden;
      vertical-align: middle;
    }
    [data-nav-links] .backend-toggle a {
      padding: 1px 7px;
      font-size: 11px;
      line-height: 1.4;
      color: #9aa0a6;
      text-decoration: none;
    }
    [data-nav-links] .backend-toggle a[aria-current='true'] {
      background: #2a2d31;
      color: #e8eaed;
      font-weight: 600;
    }
    [data-nav-links] .backend-toggle a[aria-disabled='true'] {
      color: #4a4d51;
      pointer-events: none;
      cursor: not-allowed;
    }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  stylesInstalled = true
}

function makeLink(page: Page, currentPath: string): HTMLAnchorElement {
  const a = document.createElement('a')
  a.textContent = page.label
  // Treat '/' and '/index.html' as the same page so the active marker
  // works whether Vite serves the index by name or as the root.
  const isActive =
    currentPath === page.href ||
    (page.href === '/index.html' && currentPath === '/')
  if (isActive) {
    a.setAttribute('aria-current', 'page')
  }
  // Preserve `?backend=` across navigation so the chosen backend sticks
  // (stitch.html doesn't use NiiVue and ignores the param, but the value
  // persists so the user lands on the right backend when navigating back).
  const backend = getBackendFromUrl()
  if (backend === 'webgpu') {
    a.href = `${page.href}?backend=webgpu`
  } else {
    a.href = page.href
  }
  return a
}

function appendSeparator(slot: HTMLElement): void {
  const sep = document.createElement('span')
  sep.className = 'sep'
  sep.textContent = '·'
  slot.appendChild(sep)
}

function buildBackendToggle(): HTMLSpanElement {
  const wgpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator
  const current = getBackendFromUrl()
  const wrap = document.createElement('span')
  wrap.className = 'backend-toggle'
  const mk = (
    backend: 'webgl2' | 'webgpu',
    label: string,
  ): HTMLAnchorElement => {
    const a = document.createElement('a')
    a.textContent = label
    a.href = backendSwitchUrl(backend)
    if (backend === current) a.setAttribute('aria-current', 'true')
    if (backend === 'webgpu' && !wgpuAvailable) {
      a.setAttribute('aria-disabled', 'true')
      a.title = 'WebGPU not available in this browser'
      a.removeAttribute('href')
    }
    return a
  }
  wrap.appendChild(mk('webgl2', 'WebGL2'))
  wrap.appendChild(mk('webgpu', 'WebGPU'))
  return wrap
}

export function installNav(): void {
  installActiveStyles()
  const here = window.location.pathname
  const slots = document.querySelectorAll<HTMLElement>('[data-nav-links]')
  for (const slot of slots) {
    slot.replaceChildren()
    for (const page of PAGES) {
      slot.appendChild(makeLink(page, here))
    }
    if (ENDPOINTS.length > 0) {
      appendSeparator(slot)
      for (const page of ENDPOINTS) {
        slot.appendChild(makeLink(page, here))
      }
    }
    slot.appendChild(buildBackendToggle())
  }
}
