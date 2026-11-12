// <nv-hero>: the home page's live viewer. NiiVue loads after the page renders.
class NvHero extends HTMLElement {
  async connectedCallback() {
    const canvas = this.querySelector('canvas')
    if (!canvas) return
    const base = this.dataset.examplesBase ?? ''
    // The wheel scrolls the page, not the slices: stop it here before it
    // reaches NiiVue's handler.
    this.addEventListener('wheel', (e) => e.stopPropagation(), {
      capture: true,
      passive: true,
    })
    try {
      const { createHeroScene } = await import('./heroScene')
      await createHeroScene(canvas, (p) => new URL(p, base).href)
      canvas.classList.add('ready')
    } catch {
      // The page reads fine without the viewer.
    }
  }
}

customElements.define('nv-hero', NvHero)
