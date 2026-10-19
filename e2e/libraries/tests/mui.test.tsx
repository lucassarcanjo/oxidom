// @mui/material: Button, TextField, Dialog, Autocomplete (emotion styles)
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogActions from '@mui/material/DialogActions'
import Autocomplete from '@mui/material/Autocomplete'
import { useState } from 'react'

describe('@mui/material', () => {
  test('TextField + Button form', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    function Form() {
      const [v, setV] = useState('')
      return (
        <form onSubmit={(e) => { e.preventDefault(); onSubmit(v) }}>
          <TextField label="Email" value={v} onChange={(e) => setV(e.target.value)} required />
          <Button type="submit" variant="contained">Subscribe</Button>
        </form>
      )
    }
    render(<Form />)
    await user.type(screen.getByRole('textbox', { name: /email/i }), 'ada@example.com')
    await user.click(screen.getByRole('button', { name: 'Subscribe' }))
    expect(onSubmit).toHaveBeenCalledWith('ada@example.com')
  })

  test('Dialog opens and closes via action', async () => {
    const user = userEvent.setup()
    function App() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <Button onClick={() => setOpen(true)}>Delete</Button>
          <Dialog open={open} onClose={() => setOpen(false)}>
            <DialogTitle>Delete file?</DialogTitle>
            <DialogActions><Button onClick={() => setOpen(false)}>Cancel</Button></DialogActions>
          </Dialog>
        </>
      )
    }
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete file?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  test('Autocomplete filters and selects', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <Autocomplete
        options={['The Godfather', 'Pulp Fiction', 'Fight Club']}
        onChange={(_, v) => onChange(v)}
        renderInput={(params) => <TextField {...params} label="Movie" />}
      />,
    )
    const input = screen.getByRole('combobox', { name: 'Movie' })
    await user.type(input, 'pul')
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getAllByRole('option')).toHaveLength(1)
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledWith('Pulp Fiction')
    expect(input).toHaveValue('Pulp Fiction')
  })
})
