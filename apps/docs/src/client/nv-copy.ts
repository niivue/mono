// <nv-copy data-text="…"><button>Label</button></nv-copy>: copies the text.
// The text is in the page so the click handler copies without awaiting a
// fetch first, which some browsers treat as leaving the user gesture.
class NvCopy extends HTMLElement {
  connectedCallback() {
    const button = this.querySelector('button')
    if (!button) return
    const label = button.textContent
    const text = this.dataset.text ?? ''
    button.addEventListener('click', () => {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          button.textContent = 'Copied'
        })
        .catch(() => {
          button.textContent = 'Copy failed'
        })
        .finally(() => {
          setTimeout(() => {
            button.textContent = label
          }, 1500)
        })
    })
  }
}

customElements.define('nv-copy', NvCopy)
