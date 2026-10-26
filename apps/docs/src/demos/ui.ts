// Small control-bar builder for the live demos. Each call appends one control
// to the bar above the canvas and wires its change handler, so a demo reads
// like the example pages without needing its own HTML.

export type Option = string | [label: string, value: string]

export class DemoUI {
  private readonly outputs: HTMLElement[] = []

  constructor(private readonly bar: HTMLElement) {}

  /** Remove every control and status line this demo added. */
  dispose(): void {
    this.bar.replaceChildren()
    for (const el of this.outputs) el.remove()
  }

  private add<T extends HTMLElement>(label: string, el: T): T {
    const wrap = document.createElement('label')
    wrap.className = 'demo-control'
    if (label) wrap.append(`${label} `)
    wrap.append(el)
    this.bar.append(wrap)
    return el
  }

  select(
    label: string,
    options: Option[],
    value: string,
    onChange: (value: string) => void,
  ): HTMLSelectElement {
    const el = document.createElement('select')
    for (const opt of options) {
      const [text, v] = typeof opt === 'string' ? [opt, opt] : opt
      el.add(new Option(text, v, false, v === value))
    }
    el.onchange = () => onChange(el.value)
    return this.add(label, el)
  }

  slider(
    label: string,
    min: number,
    max: number,
    value: number,
    onInput: (value: number) => void,
    step = 1,
  ): HTMLInputElement {
    const el = document.createElement('input')
    el.type = 'range'
    el.min = String(min)
    el.max = String(max)
    el.step = String(step)
    el.value = String(value)
    el.oninput = () => onInput(Number(el.value))
    return this.add(label, el)
  }

  checkbox(
    label: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
  ): HTMLInputElement {
    const el = document.createElement('input')
    el.type = 'checkbox'
    el.checked = checked
    el.onchange = () => onChange(el.checked)
    return this.add(label, el)
  }

  button(label: string, onClick: () => void): HTMLButtonElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.textContent = label
    el.onclick = onClick
    this.bar.append(el)
    return el
  }

  /** A text line under the canvas; returns a setter for its content. */
  status(text = ''): (text: string) => void {
    const el = document.createElement('output')
    el.className = 'demo-status'
    el.textContent = text
    this.bar.parentElement?.append(el)
    this.outputs.push(el)
    return (t) => {
      el.textContent = t
    }
  }
}
