// focus-trap + tabbable (vanilla). Per both READMEs' "Testing in JSDom" section,
// displayCheck: 'none' is used (applied identically for all DOMs).
import userEvent from '@testing-library/user-event'
import { createFocusTrap } from 'focus-trap'
import { tabbable, isFocusable } from 'tabbable'

function mount(html: string) {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}
afterEach(() => { document.body.innerHTML = '' })

describe('tabbable', () => {
  test('finds tabbable nodes in tab order', () => {
    const root = mount(`
      <button id="b1">one</button>
      <a href="#x" id="a1">link</a>
      <input id="i1" tabindex="2">
      <button disabled>off</button>
      <div tabindex="-1" id="d1">neg</div>
      <span>plain</span>
      <textarea id="t1"></textarea>`)
    const ids = tabbable(root, { displayCheck: 'none' }).map((e) => e.id)
    expect(ids).toEqual(['i1', 'b1', 'a1', 't1'])
    expect(isFocusable(root.querySelector('#d1')!, { displayCheck: 'none' })).toBe(true)
  })
})

describe('focus-trap', () => {
  test('traps Tab inside the container and releases on deactivate', async () => {
    const user = userEvent.setup()
    const root = mount(`
      <button id="outside">outside</button>
      <div id="trap"><button id="first">first</button><button id="last">last</button></div>`)
    const trap = createFocusTrap(root.querySelector('#trap') as HTMLElement, {
      tabbableOptions: { displayCheck: 'none' },
    })
    trap.activate()
    // initial focus is delayed by a setTimeout(0) (focus-trap option delayInitialFocus, default true)
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('first'))
    await user.tab()
    expect(document.activeElement?.id).toBe('last')
    await user.tab()
    expect(document.activeElement?.id).toBe('first')
    await user.tab({ shift: true })
    expect(document.activeElement?.id).toBe('last')
    trap.deactivate()
  })

  test('Escape deactivates', async () => {
    const user = userEvent.setup()
    const root = mount(`<div id="trap"><button>x</button></div>`)
    const onDeactivate = vi.fn()
    createFocusTrap(root.querySelector('#trap') as HTMLElement, {
      tabbableOptions: { displayCheck: 'none' },
      onDeactivate,
    }).activate()
    await user.keyboard('{Escape}')
    expect(onDeactivate).toHaveBeenCalled()
  })
})
