// @radix-ui/react-dialog, react-select, react-dropdown-menu, react-tabs
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as Dialog from '@radix-ui/react-dialog'
import * as Select from '@radix-ui/react-select'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Tabs from '@radix-ui/react-tabs'
import { useState } from 'react'

function EditProfile({ onSave }: { onSave: (name: string) => void }) {
  const [name, setName] = useState('Ada')
  return (
    <Dialog.Root>
      <Dialog.Trigger>Edit profile</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content aria-describedby={undefined}>
          <Dialog.Title>Edit profile</Dialog.Title>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <Dialog.Close onClick={() => onSave(name)}>Save</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

describe('@radix-ui/react-dialog', () => {
  test('opens, traps focus, edits and saves', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<EditProfile onSave={onSave} />)
    await user.click(screen.getByRole('button', { name: 'Edit profile' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit profile' })
    expect(dialog).toBeInTheDocument()
    // FocusScope moves focus to the first tabbable element inside the dialog
    expect(screen.getByLabelText('Name')).toHaveFocus()
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'Grace')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith('Grace')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  test('Escape closes and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    render(<EditProfile onSave={() => {}} />)
    const trigger = screen.getByRole('button', { name: 'Edit profile' })
    await user.click(trigger)
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })
})

describe('@radix-ui/react-select', () => {
  test('picks an option with the pointer', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <Select.Root onValueChange={onValueChange}>
        <Select.Trigger aria-label="Fruit">
          <Select.Value placeholder="Pick a fruit" />
        </Select.Trigger>
        <Select.Portal>
          <Select.Content position="popper">
            <Select.Viewport>
              <Select.Item value="apple">
                <Select.ItemText>Apple</Select.ItemText>
              </Select.Item>
              <Select.Item value="banana">
                <Select.ItemText>Banana</Select.ItemText>
              </Select.Item>
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>,
    )
    await user.click(screen.getByRole('combobox', { name: 'Fruit' }))
    await user.click(await screen.findByRole('option', { name: 'Banana' }))
    expect(onValueChange).toHaveBeenCalledWith('banana')
    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveTextContent('Banana')
  })
})

describe('@radix-ui/react-dropdown-menu', () => {
  test('opens with the pointer and selects with the keyboard', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>Actions</DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item onSelect={() => onSelect('copy')}>Copy</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => onSelect('delete')}>Delete</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>,
    )
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(onSelect).toHaveBeenCalledWith('delete')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })
})

describe('@radix-ui/react-tabs', () => {
  test('switches panels by click and arrow keys', async () => {
    const user = userEvent.setup()
    render(
      <Tabs.Root defaultValue="account">
        <Tabs.List aria-label="Settings">
          <Tabs.Trigger value="account">Account</Tabs.Trigger>
          <Tabs.Trigger value="password">Password</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="account">Account panel</Tabs.Content>
        <Tabs.Content value="password">Password panel</Tabs.Content>
      </Tabs.Root>,
    )
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Account panel')
    await user.click(screen.getByRole('tab', { name: 'Password' }))
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Password panel')
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'Account' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Account' })).toHaveAttribute('aria-selected', 'true')
  })
})
