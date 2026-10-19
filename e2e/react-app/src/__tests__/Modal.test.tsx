import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DeleteAccountDialog, Modal } from '../components/Modal'

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open settings
      </button>
      <Modal
        open={open}
        title="Settings"
        onClose={() => {
          onClose()
          setOpen(false)
        }}
      >
        <label>
          Display name <input defaultValue="Ada" />
        </label>
        <button type="button">Save</button>
      </Modal>
    </div>
  )
}

describe('<Modal />', () => {
  it('renders nothing when closed', () => {
    render(<Modal open={false} title="Hidden" onClose={() => {}}>content</Modal>)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.body).not.toHaveStyle({ overflow: 'hidden' })
  })

  it('opens an accessible modal dialog in a portal', async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Open settings' }))

    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toBeVisible()
    // Rendered through a portal into document.body, outside the render container
    expect(container).not.toContainElement(dialog)
    expect(document.body).toContainElement(dialog)
    expect(document.body).toHaveStyle({ overflow: 'hidden' })
  })

  it('moves focus to the first focusable element inside the dialog', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Open settings' }))

    expect(screen.getByLabelText('Display name')).toHaveFocus()
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement)
  })

  it('closes on Escape and restores focus to the trigger', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    const trigger = screen.getByRole('button', { name: 'Open settings' })

    await user.click(trigger)
    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(document.body.style.overflow).toBe('')
  })

  it('closes when the backdrop is clicked but not when the dialog is clicked', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open settings' }))

    await user.click(screen.getByRole('dialog'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.click(screen.getByTestId('modal-backdrop'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open settings' }))

    const input = screen.getByLabelText('Display name')
    const save = screen.getByRole('button', { name: 'Save' })
    const close = screen.getByRole('button', { name: 'Close dialog' })

    expect(input).toHaveFocus()
    await user.tab()
    expect(save).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()
    await user.tab()
    expect(input).toHaveFocus()
    await user.tab({ shift: true })
    expect(close).toHaveFocus()
  })
})

describe('<DeleteAccountDialog />', () => {
  it('requires typing DELETE before confirming', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<DeleteAccountDialog username="ada" onConfirm={onConfirm} />)

    await user.click(screen.getByRole('button', { name: 'Delete account' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete account?' })
    expect(dialog).toHaveAccessibleDescription('This permanently deletes ada and all of its data.')

    const confirm = within(dialog).getByRole('button', { name: 'Delete forever' })
    expect(confirm).toBeDisabled()

    await user.type(within(dialog).getByLabelText('Type DELETE to confirm'), 'DELET')
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type DELETE to confirm'), 'E')
    expect(confirm).toBeEnabled()

    await user.click(confirm)
    expect(onConfirm).toHaveBeenCalledWith('ada')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('cancel discards the typed confirmation', async () => {
    const user = userEvent.setup()
    render(<DeleteAccountDialog username="ada" onConfirm={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Delete account' }))
    await user.type(screen.getByRole('textbox'), 'DELETE')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete account' }))
    expect(screen.getByRole('textbox', { name: 'Type DELETE to confirm' })).toHaveValue('')
  })

  it('also closes via fireEvent.keyDown(Escape) on the document', () => {
    render(<DeleteAccountDialog username="ada" onConfirm={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
