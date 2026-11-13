// <nv-gallery>: filters the server-rendered gallery cards by search text and
// section, keeps each section's count in step with what is shown, and
// switches between the card grid and a text list (remembered per browser).
const VIEW_KEY = 'nv-gallery-view'

class NvGallery extends HTMLElement {
  connectedCallback() {
    const search = this.querySelector<HTMLInputElement>('.search')
    const chips = Array.from(
      this.querySelectorAll<HTMLButtonElement>('fieldset.chips button'),
    )
    const groups = Array.from(this.querySelectorAll<HTMLElement>('section'))
    const count = this.querySelector<HTMLElement>('.count')
    const empty = this.querySelector<HTMLElement>('.empty')
    const total = this.querySelectorAll('.card').length
    let active = ''
    const update = () => {
      const terms = (search?.value ?? '')
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
      let shown = 0
      for (const group of groups) {
        let inGroup = 0
        const sectionMatches = !active || group.dataset.section === active
        for (const card of group.querySelectorAll<HTMLElement>('.card')) {
          const text = card.dataset.text ?? ''
          card.hidden = !sectionMatches || !terms.every((t) => text.includes(t))
          if (!card.hidden) inGroup++
        }
        group.hidden = inGroup === 0
        const groupCount = group.querySelector('.group-count')
        if (groupCount) groupCount.textContent = String(inGroup)
        shown += inGroup
      }
      if (count) {
        count.textContent =
          terms.length || active ? `${shown} of ${total} examples` : ''
      }
      if (empty) empty.hidden = shown > 0
    }
    const views = Array.from(
      this.querySelectorAll<HTMLButtonElement>('.view button'),
    )
    const setView = (view: string) => {
      this.dataset.view = view
      for (const v of views) {
        v.setAttribute('aria-pressed', String(v.dataset.view === view))
      }
    }
    try {
      if (localStorage.getItem(VIEW_KEY) === 'list') setView('list')
    } catch {}
    for (const v of views) {
      v.addEventListener('click', () => {
        const view = v.dataset.view ?? 'grid'
        setView(view)
        try {
          localStorage.setItem(VIEW_KEY, view)
        } catch {}
      })
    }
    search?.addEventListener('input', update)
    for (const chip of chips) {
      chip.addEventListener('click', () => {
        active = chip.dataset.section ?? ''
        for (const c of chips) {
          c.setAttribute('aria-pressed', String(c === chip))
        }
        update()
      })
    }
  }
}

customElements.define('nv-gallery', NvGallery)
