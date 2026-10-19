// lit: custom elements + shadow DOM + slots + reactive updates
import { LitElement, html, css } from 'lit'
import userEvent from '@testing-library/user-event'

class CounterButton extends LitElement {
  static properties = { count: { type: Number } }
  static styles = css`button { color: rebeccapurple; }`
  declare count: number
  constructor() { super(); this.count = 0 }
  render() {
    return html`<button part="btn" @click=${() => { this.count++; this.dispatchEvent(new CustomEvent('changed', { detail: this.count, bubbles: true, composed: true })) }}>
      <slot></slot>: ${this.count}</button>`
  }
}
if (!customElements.get('counter-button')) customElements.define('counter-button', CounterButton)

afterEach(() => { document.body.innerHTML = '' })

describe('lit', () => {
  test('defines a custom element and renders into its shadow root', async () => {
    document.body.innerHTML = '<counter-button count="3">Clicks</counter-button>'
    const el = document.querySelector('counter-button') as CounterButton
    expect(el).toBeInstanceOf(CounterButton)
    await el.updateComplete
    const btn = el.shadowRoot!.querySelector('button')!
    expect(btn.textContent).toContain(': 3')
    const slot = el.shadowRoot!.querySelector('slot')!
    expect(slot.assignedNodes().map((n) => n.textContent)).toEqual(['Clicks'])
  })

  test('click inside shadow DOM updates state and emits a composed event', async () => {
    const user = userEvent.setup()
    const el = document.createElement('counter-button') as CounterButton
    el.textContent = 'Clicks'
    const onChanged = vi.fn()
    document.body.addEventListener('changed', (e) => onChanged((e as CustomEvent).detail))
    document.body.appendChild(el)
    await el.updateComplete
    await user.click(el.shadowRoot!.querySelector('button')!)
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('button')!.textContent).toContain(': 1')
    expect(onChanged).toHaveBeenCalledWith(1)
  })
})
