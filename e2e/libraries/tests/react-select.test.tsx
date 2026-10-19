// react-select (emotion styles, AutosizeInput, aria-live)
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Select from 'react-select'

const options = [
  { value: 'chocolate', label: 'Chocolate' },
  { value: 'strawberry', label: 'Strawberry' },
  { value: 'vanilla', label: 'Vanilla' },
]

describe('react-select', () => {
  test('opens, filters and selects an option', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<><label htmlFor="flavour">Flavour</label><Select inputId="flavour" options={options} onChange={onChange} /></>)
    const input = screen.getByLabelText('Flavour')
    await user.click(input)
    await user.type(input, 'van')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith(options[2], expect.objectContaining({ action: 'select-option' }))
    expect(screen.getByText('Vanilla')).toBeInTheDocument()
  })

  test('multi select adds and removes values', async () => {
    const user = userEvent.setup()
    render(<><label htmlFor="f2">Flavours</label><Select inputId="f2" isMulti options={options} /></>)
    const input = screen.getByLabelText('Flavours')
    await user.click(input)
    await user.click(screen.getByRole('option', { name: 'Chocolate' }))
    await user.click(input)
    await user.click(screen.getByRole('option', { name: 'Strawberry' }))
    expect(screen.getByText('Chocolate')).toBeInTheDocument()
    expect(screen.getByText('Strawberry')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove Chocolate' }))
    expect(screen.queryByText('Chocolate')).not.toBeInTheDocument()
  })
})
