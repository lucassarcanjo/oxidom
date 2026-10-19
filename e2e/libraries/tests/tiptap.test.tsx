// @tiptap/react + StarterKit (ProseMirror: contenteditable, Selection, Range, MutationObserver)
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'

let editorRef: Editor | null = null
function RichText({ onUpdate }: { onUpdate?: (html: string) => void }) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: '<p>Hello world</p>',
    immediatelyRender: true,
    onUpdate: ({ editor }) => onUpdate?.(editor.getHTML()),
  })
  editorRef = editor
  return (
    <div>
      <button onClick={() => editor?.chain().focus().selectAll().toggleBold().run()}>Bold</button>
      <EditorContent editor={editor} data-testid="editor" />
    </div>
  )
}

describe('@tiptap/react', () => {
  test('renders content and applies bold via toolbar', async () => {
    const user = userEvent.setup()
    render(<RichText />)
    const pm = await waitFor(() => {
      const el = screen.getByTestId('editor').querySelector('[contenteditable="true"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    expect(pm).toHaveTextContent('Hello world')
    await user.click(screen.getByRole('button', { name: 'Bold' }))
    expect(pm.querySelector('strong')).toHaveTextContent('Hello world')
    expect(editorRef!.getHTML()).toBe('<p><strong>Hello world</strong></p>')
  })

  test('typing into the editor updates the document', async () => {
    const user = userEvent.setup()
    const onUpdate = vi.fn()
    render(<RichText onUpdate={onUpdate} />)
    await waitFor(() => expect(editorRef).not.toBeNull())
    const pm = screen.getByTestId('editor').querySelector('[contenteditable="true"]') as HTMLElement
    await user.click(pm)
    await waitFor(() => expect(pm).toHaveFocus())
    await user.keyboard('!')
    await waitFor(() => expect(editorRef!.getText()).toMatch(/^(Hello world!|!Hello world)$/))
    expect(onUpdate).toHaveBeenCalled()
  })
})
