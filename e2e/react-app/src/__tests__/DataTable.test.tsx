import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DataTable } from '../components/DataTable'
import { generateRows, type UserRow } from '../data/generateRows'

const ROWS = generateRows(300)

function bodyRows() {
  // The first rowgroup is <thead>, the second is <tbody>.
  const [, tbody] = screen.getAllByRole('rowgroup')
  return within(tbody).getAllByRole('row')
}

function cellText(row: HTMLElement, column: number) {
  return within(row).getAllByRole('cell')[column].textContent
}

describe('<DataTable /> (300 rows)', () => {
  let rows: UserRow[]
  beforeEach(() => {
    rows = ROWS
  })

  it('renders the first page with a caption and column headers', () => {
    render(<DataTable rows={rows} pageSize={25} />)

    const table = screen.getByRole('table', { name: 'Users' })
    expect(table).toBeInTheDocument()
    const headers = within(table).getAllByRole('columnheader')
    expect(headers.map((h) => h.textContent)).toEqual(['', 'ID', 'Name', 'Email', 'Role', 'Age', 'City'])
    expect(bodyRows()).toHaveLength(25)
    expect(screen.getByRole('status')).toHaveTextContent('Showing 1–25 of 300')
    expect(screen.getByText('Page 1 of 12')).toBeInTheDocument()
  })

  it('renders cells with the generated data', () => {
    render(<DataTable rows={rows} pageSize={10} />)

    const first = bodyRows()[0]
    expect(cellText(first, 1)).toBe(String(rows[0].id))
    expect(cellText(first, 2)).toBe(rows[0].name)
    expect(within(first).getByRole('link', { name: rows[0].email })).toHaveAttribute(
      'href',
      `mailto:${rows[0].email}`,
    )
  })

  it('sorts by a column and toggles direction', () => {
    render(<DataTable rows={rows} pageSize={50} />)
    const ageHeader = screen.getByRole('columnheader', { name: 'Age' })
    expect(ageHeader).toHaveAttribute('aria-sort', 'none')

    fireEvent.click(within(ageHeader).getByRole('button'))
    expect(ageHeader).toHaveAttribute('aria-sort', 'ascending')
    const ascAges = bodyRows().map((r) => Number(cellText(r, 5)))
    expect(ascAges).toEqual([...ascAges].sort((a, b) => a - b))
    expect(ascAges[0]).toBe(Math.min(...rows.map((r) => r.age)))

    fireEvent.click(screen.getByRole('button', { name: 'Age' }))
    expect(ageHeader).toHaveAttribute('aria-sort', 'descending')
    expect(Number(cellText(bodyRows()[0], 5))).toBe(Math.max(...rows.map((r) => r.age)))
  })

  it('sorts text columns alphabetically and resets aria-sort on other columns', () => {
    render(<DataTable rows={rows} pageSize={30} />)

    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    const names = bodyRows().map((r) => cellText(r, 2)!)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))

    fireEvent.click(screen.getByRole('button', { name: 'City' }))
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'none')
    expect(screen.getByRole('columnheader', { name: 'City' })).toHaveAttribute('aria-sort', 'ascending')
  })

  it('filters rows by text and resets to the first page', () => {
    render(<DataTable rows={rows} pageSize={10} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText(/^Page 2 of/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filter rows'), { target: { value: 'lisbon' } })

    const expected = rows.filter((r) => r.city === 'Lisbon').length
    expect(screen.getByRole('status')).toHaveTextContent(`of ${expected}`)
    expect(screen.getByText(/^Page 1 of/)).toBeInTheDocument()
    for (const row of bodyRows()) expect(cellText(row, 6)).toBe('Lisbon')
  })

  it('shows an empty state when nothing matches', () => {
    render(<DataTable rows={rows} />)

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter rows' }), {
      target: { value: 'no-such-person' },
    })

    expect(screen.getByRole('status')).toHaveTextContent('No matching rows')
    expect(screen.getAllByRole('rowgroup')[1]).toBeEmptyDOMElement()
    expect(screen.getByRole('checkbox', { name: 'Select all rows on this page' })).toBeDisabled()
  })

  it('paginates with first / previous / next / last', () => {
    render(<DataTable rows={rows} pageSize={25} />)
    const pagination = screen.getByRole('navigation', { name: 'Pagination' })
    const next = within(pagination).getByRole('button', { name: 'Next' })
    const prev = within(pagination).getByRole('button', { name: 'Previous' })

    expect(prev).toBeDisabled()
    fireEvent.click(next)
    fireEvent.click(next)
    expect(within(pagination).getByText('Page 3 of 12')).toBeInTheDocument()
    expect(cellText(bodyRows()[0], 1)).toBe('51')

    fireEvent.click(within(pagination).getByRole('button', { name: 'Last' }))
    expect(next).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Showing 276–300 of 300')

    fireEvent.click(within(pagination).getByRole('button', { name: 'First' }))
    expect(prev).toBeDisabled()
    expect(cellText(bodyRows()[0], 1)).toBe('1')
  })

  it('selects individual rows', () => {
    const onSelectionChange = vi.fn()
    render(<DataTable rows={rows} pageSize={25} onSelectionChange={onSelectionChange} />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select row 3' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select row 7' }))

    expect(screen.getByRole('checkbox', { name: 'Select row 3' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Select row 3' }).closest('tr')).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByTestId('selected-count')).toHaveTextContent('2 selected')
    expect(onSelectionChange).toHaveBeenLastCalledWith([3, 7])
    expect(screen.getByRole('checkbox', { name: 'Select all rows on this page' })).toBePartiallyChecked()
  })

  it('selects and deselects every row on the current page', () => {
    render(<DataTable rows={rows} pageSize={25} />)
    const selectAll = screen.getByRole('checkbox', { name: 'Select all rows on this page' })

    fireEvent.click(selectAll)
    expect(selectAll).toBeChecked()
    expect(screen.getByTestId('selected-count')).toHaveTextContent('25 selected')
    expect(bodyRows().every((r) => r.classList.contains('row--selected'))).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(selectAll).not.toBeChecked()
    fireEvent.click(selectAll)
    expect(screen.getByTestId('selected-count')).toHaveTextContent('50 selected')

    fireEvent.click(selectAll)
    expect(screen.getByTestId('selected-count')).toHaveTextContent('25 selected')
  })

  it('keeps selection while sorting', () => {
    render(<DataTable rows={rows} pageSize={300} />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select row 42' }))
    fireEvent.click(screen.getByRole('button', { name: 'ID' }))
    fireEvent.click(screen.getByRole('button', { name: 'ID' }))

    expect(cellText(bodyRows()[0], 1)).toBe('300')
    expect(screen.getByRole('checkbox', { name: 'Select row 42' })).toBeChecked()
  })
})
