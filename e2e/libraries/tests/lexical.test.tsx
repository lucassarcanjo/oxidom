// lexical + @lexical/react (contenteditable, Selection, beforeinput, MutationObserver)
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from 'lexical'

let editorRef: LexicalEditor | null = null
function Capture() {
  const [editor] = useLexicalComposerContext()
  editorRef = editor
  return null
}

function Editor({ onChange }: { onChange: (text: string) => void }) {
  return (
    <LexicalComposer initialConfig={{ namespace: 'test', onError: (e) => { throw e }, nodes: [] }}>
      <PlainTextPlugin
        contentEditable={<ContentEditable aria-label="Comment" />}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <OnChangePlugin onChange={(state) => state.read(() => onChange($getRoot().getTextContent()))} />
      <Capture />
    </LexicalComposer>
  )
}

describe('lexical', () => {
  test('programmatic update is reconciled to the DOM', async () => {
    const onChange = vi.fn()
    render(<Editor onChange={onChange} />)
    const ce = screen.getByRole('textbox', { name: 'Comment' })
    expect(ce).toHaveAttribute('contenteditable', 'true')
    await act(async () => {
      editorRef!.update(() => {
        const p = $createParagraphNode()
        p.append($createTextNode('Hello lexical'))
        $getRoot().clear().append(p)
      })
    })
    await waitFor(() => expect(ce).toHaveTextContent('Hello lexical'))
    expect(onChange).toHaveBeenLastCalledWith('Hello lexical')
  })

  test('typing with user-event reaches the editor state', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Editor onChange={onChange} />)
    const ce = screen.getByRole('textbox', { name: 'Comment' })
    await user.click(ce)
    await user.keyboard('Hi')
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('Hi'))
    expect(ce).toHaveTextContent('Hi')
  })
})
