// downshift useCombobox: type to filter, select with keyboard
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useCombobox } from 'downshift'
import { useState } from 'react'

const books = ['Dune', 'Emma', 'Ulysses', 'Dracula']

function BookPicker({ onSelect }: { onSelect: (b: string | null | undefined) => void }) {
  const [items, setItems] = useState(books)
  const { isOpen, getLabelProps, getInputProps, getMenuProps, getItemProps, highlightedIndex } = useCombobox({
    items,
    onInputValueChange: ({ inputValue }) => setItems(books.filter((b) => b.toLowerCase().includes((inputValue ?? '').toLowerCase()))),
    onSelectedItemChange: ({ selectedItem }) => onSelect(selectedItem),
  })
  return (
    <div>
      <label {...getLabelProps()}>Book</label>
      <input {...getInputProps()} />
      <ul {...getMenuProps()}>
        {isOpen && items.map((item, index) => (
          <li key={item} {...getItemProps({ item, index })} style={{ fontWeight: highlightedIndex === index ? 'bold' : 'normal' }}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

describe('downshift', () => {
  test('filters and selects with the keyboard', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<BookPicker onSelect={onSelect} />)
    const input = screen.getByRole('combobox', { name: 'Book' })
    await user.type(input, 'd')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Dune', 'Dracula'])
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(onSelect).toHaveBeenCalledWith('Dracula')
    expect(input).toHaveValue('Dracula')
  })

  test('selects with the pointer and closes on blur', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<><BookPicker onSelect={onSelect} /><button>elsewhere</button></>)
    await user.click(screen.getByRole('combobox', { name: 'Book' }))
    await user.type(screen.getByRole('combobox'), 'u')
    await user.click(screen.getByRole('option', { name: 'Ulysses' }))
    expect(onSelect).toHaveBeenCalledWith('Ulysses')
    await user.type(screen.getByRole('combobox'), 'x')
    await user.click(screen.getByRole('button', { name: 'elsewhere' }))
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })
})
