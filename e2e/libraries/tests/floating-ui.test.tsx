// @floating-ui/react: popover via useClick/useDismiss/useRole; tooltip via useHover
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  useFloating, useInteractions, useClick, useDismiss, useRole, useHover,
  FloatingFocusManager, FloatingPortal, autoUpdate, offset, flip, shift,
} from '@floating-ui/react'
import { useState } from 'react'

function Popover() {
  const [open, setOpen] = useState(false)
  const { refs, floatingStyles, context } = useFloating({
    open, onOpenChange: setOpen, middleware: [offset(4), flip(), shift()], whileElementsMounted: autoUpdate,
  })
  const { getReferenceProps, getFloatingProps } = useInteractions([useClick(context), useDismiss(context), useRole(context)])
  return (
    <>
      <button ref={refs.setReference} {...getReferenceProps()}>Filters</button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context}>
            <div ref={refs.setFloating} style={floatingStyles} {...getFloatingProps()} aria-label="Filter panel">
              <input aria-label="Search" />
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  )
}

function Tooltip() {
  const [open, setOpen] = useState(false)
  const { refs, floatingStyles, context } = useFloating({ open, onOpenChange: setOpen })
  const { getReferenceProps, getFloatingProps } = useInteractions([useHover(context), useRole(context, { role: 'tooltip' })])
  return (
    <>
      <button ref={refs.setReference} {...getReferenceProps()}>Help</button>
      {open && <div ref={refs.setFloating} style={floatingStyles} {...getFloatingProps()}>Helpful text</div>}
    </>
  )
}

describe('@floating-ui/react', () => {
  test('popover opens on click, focuses content, closes on Escape', async () => {
    const user = userEvent.setup()
    render(<Popover />)
    await user.click(screen.getByRole('button', { name: 'Filters' }))
    const dialog = await screen.findByRole('dialog', { name: 'Filter panel' })
    expect(dialog).toBeInTheDocument()
    // computePosition resolves asynchronously (floating-ui docs: flush with act)
    await act(async () => {})
    expect(dialog.style.position).toBe('absolute')
    await waitFor(() => expect(screen.getByLabelText('Search')).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  test('tooltip shows on hover', async () => {
    const user = userEvent.setup()
    render(<Tooltip />)
    await user.hover(screen.getByRole('button', { name: 'Help' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Helpful text')
    await user.unhover(screen.getByRole('button', { name: 'Help' }))
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })
})
