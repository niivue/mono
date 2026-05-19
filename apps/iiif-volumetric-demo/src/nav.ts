// Shared cross-page nav. Each working demo page has an empty
// `<div class="links" data-nav-links></div>` slot (typically in its header)
// and calls installNav() from its entry module. The function rebuilds the
// slot with the canonical list of pages so adding/removing a demo is a
// single-file edit here.

type Page = { href: string; label: string }

const PAGES: Page[] = [
  { href: '/index.html', label: 'volumes' },
  { href: '/sheet.html', label: 'sheet' },
  { href: '/stitch.html', label: 'stitch' },
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
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  stylesInstalled = true
}

function makeLink(page: Page, currentPath: string): HTMLAnchorElement {
  const a = document.createElement('a')
  a.href = page.href
  a.textContent = page.label
  // Treat '/' and '/index.html' as the same page so the active marker
  // works whether Vite serves the index by name or as the root.
  const isActive =
    currentPath === page.href ||
    (page.href === '/index.html' && currentPath === '/')
  if (isActive) {
    a.setAttribute('aria-current', 'page')
  }
  return a
}

function appendSeparator(slot: HTMLElement): void {
  const sep = document.createElement('span')
  sep.className = 'sep'
  sep.textContent = '·'
  slot.appendChild(sep)
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
  }
}
