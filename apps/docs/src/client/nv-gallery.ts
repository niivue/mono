// <nv-gallery>: filters the server-rendered gallery cards by search text and
// section, and keeps each section's count in step with what is shown.
class NvGallery extends HTMLElement {
  connectedCallback() {
    const search = this.querySelector<HTMLInputElement>('.search')
    const chips = Array.from(
      this.querySelectorAll<HTMLButtonElement>('.chips button'),
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
