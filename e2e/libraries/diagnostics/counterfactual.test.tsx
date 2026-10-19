// COUNTERFACTUALS: re-run a failing scenario after shimming ONLY the API identified as the root
// cause. If the scenario then passes, the root cause is verified. These shims are NOT used by
// tests/ (they are not documented setup for these libraries); they exist only as evidence.
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

describe('lexical typing needs InputEvent.getTargetRanges (beforeinput path)', () => {
  test('with getTargetRanges shimmed before lexical loads, user-event typing reaches the editor', async () => {
    const IE = (globalThis as any).InputEvent
    if (!('getTargetRanges' in IE.prototype)) IE.prototype.getTargetRanges = () => []
    vi.resetModules()
    const { LexicalComposer } = await import('@lexical/react/LexicalComposer')
    const { PlainTextPlugin } = await import('@lexical/react/LexicalPlainTextPlugin')
    const { ContentEditable } = await import('@lexical/react/LexicalContentEditable')
    const { LexicalErrorBoundary } = await import('@lexical/react/LexicalErrorBoundary')
    const { OnChangePlugin } = await import('@lexical/react/LexicalOnChangePlugin')
    const { $getRoot } = await import('lexical')
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <LexicalComposer initialConfig={{ namespace: 'cf', onError: (e: Error) => { throw e } }}>
        <PlainTextPlugin contentEditable={<ContentEditable aria-label="Comment" />} ErrorBoundary={LexicalErrorBoundary} />
        <OnChangePlugin onChange={(s: any) => s.read(() => onChange($getRoot().getTextContent()))} />
      </LexicalComposer>,
    )
    const ce = screen.getByRole('textbox', { name: 'Comment' })
    await user.click(ce)
    await user.keyboard('Hi')
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('Hi'))
  })
})

describe('tiptap typing needs Range#getClientRects/getBoundingClientRect + document.elementFromPoint', () => {
  test('with those three shimmed (zero rects / null), click + type updates the editor and fires onUpdate', async () => {
    const R = (globalThis as any).Range.prototype
    const zero = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} }
    if (typeof R.getClientRects !== 'function') R.getClientRects = () => Object.assign([], { item: () => null })
    if (typeof R.getBoundingClientRect !== 'function') R.getBoundingClientRect = () => zero
    if (typeof (document as any).elementFromPoint !== 'function') (document as any).elementFromPoint = () => null
    const { EditorContent, useEditor } = await import('@tiptap/react')
    const { default: StarterKit } = await import('@tiptap/starter-kit')
    const onUpdate = vi.fn()
    let ed: any
    function RT() {
      const e = useEditor({ extensions: [StarterKit], content: '<p>Hello world</p>', immediatelyRender: true, onUpdate: () => onUpdate() })
      ed = e
      return <EditorContent editor={e} data-testid="editor" />
    }
    const user = userEvent.setup()
    render(<RT />)
    const pm = screen.getByTestId('editor').querySelector('[contenteditable="true"]') as HTMLElement
    await user.click(pm)
    await waitFor(() => expect(pm).toHaveFocus())
    await user.keyboard('!')
    await waitFor(() => expect(ed.getText()).toMatch(/^(Hello world!|!Hello world)$/))
    expect(onUpdate).toHaveBeenCalled()
  })
})

describe('react-aria modal autoFocus needs `document instanceof window.Document`', () => {
  test('with Symbol.hasInstance fixed on window.Document, the autoFocus field keeps focus', async () => {
    const D = (window as any).Document
    if (!(document instanceof D)) {
      Object.defineProperty(D, Symbol.hasInstance, { configurable: true, value: (o: any) => o != null && o.nodeType === 9 })
    }
    const { Button, Dialog, DialogTrigger, Heading, Modal, TextField, Label, Input } = await import('react-aria-components')
    const user = userEvent.setup()
    render(
      <DialogTrigger>
        <Button>Sign up</Button>
        <Modal><Dialog><Heading slot="title">Sign up</Heading>
          <TextField autoFocus><Label>Email</Label><Input /></TextField>
        </Dialog></Modal>
      </DialogTrigger>,
    )
    await user.click(screen.getByRole('button', { name: 'Sign up' }))
    const dialog = await screen.findByRole('dialog', { name: 'Sign up' })
    expect(within(dialog).getByLabelText('Email')).toHaveFocus()
  })
})
