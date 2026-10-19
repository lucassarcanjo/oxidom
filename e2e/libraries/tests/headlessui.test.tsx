// @headlessui/react v2: Menu, Listbox, Dialog
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  Menu, MenuButton, MenuItems, MenuItem,
  Listbox, ListboxButton, ListboxOptions, ListboxOption,
  Dialog, DialogPanel, DialogTitle,
} from '@headlessui/react'
import { useState } from 'react'

describe('@headlessui/react', () => {
  test('Menu opens and activates an item', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Menu>
        <MenuButton>Options</MenuButton>
        <MenuItems>
          <MenuItem><button onClick={() => onClick('edit')}>Edit</button></MenuItem>
          <MenuItem><button onClick={() => onClick('archive')}>Archive</button></MenuItem>
        </MenuItems>
      </Menu>,
    )
    await user.click(screen.getByRole('button', { name: 'Options' }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }))
    expect(onClick).toHaveBeenCalledWith('archive')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  test('Listbox selects with the keyboard', async () => {
    const user = userEvent.setup()
    function People() {
      const [p, setP] = useState('Durward')
      return (
        <Listbox value={p} onChange={setP}>
          <ListboxButton>{p}</ListboxButton>
          <ListboxOptions>
            {['Durward', 'Kenton', 'Therese'].map((n) => (
              <ListboxOption key={n} value={n}>{n}</ListboxOption>
            ))}
          </ListboxOptions>
        </Listbox>
      )
    }
    render(<People />)
    await user.click(screen.getByRole('button', { name: 'Durward' }))
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
    await user.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(screen.getByRole('button')).toHaveTextContent('Kenton')
  })

  test('Dialog opens, closes on Escape', async () => {
    const user = userEvent.setup()
    function App() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>Deactivate</button>
          <Dialog open={open} onClose={() => setOpen(false)}>
            <DialogPanel>
              <DialogTitle>Deactivate account</DialogTitle>
              <button onClick={() => setOpen(false)}>Cancel</button>
            </DialogPanel>
          </Dialog>
        </>
      )
    }
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Deactivate' }))
    expect(await screen.findByRole('dialog', { name: 'Deactivate account' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
