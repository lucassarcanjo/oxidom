/**
 * "Heavy" table suite: 1000 rows (~17k DOM nodes) rendered at once, repeated
 * filtering and sorting. Every large real-world suite has a few files like this and they
 * tend to dominate wall-clock time, so it is an important benchmark subject.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DataTable, type SortKey } from '../components/DataTable'
import { generateRows } from '../data/generateRows'

const ROW_COUNT = 1000
const ROWS = generateRows(ROW_COUNT, 7)

function tbody() {
  return screen.getByRole('table').querySelector('tbody')!
}

// Note: happy-dom 21.0.3 does not implement HTMLTableSectionElement.rows
// (tbody.rows is undefined), so rows and cells are read with querySelectorAll,
// which is what most real-world tests do anyway.
function bodyRows() {
  return tbody().querySelectorAll('tr')
}

function renderedRowCount() {
  return bodyRows().length
}

// Heavy files commonly raise the per-test timeout; jsdom needs several seconds
// for role queries over ~10k elements.
describe('<DataTable /> heavy (1000 rows, single page)', { timeout: 30_000 }, () => {
  it('renders every row', () => {
    render(<DataTable rows={ROWS} pageSize={ROW_COUNT} caption="All users" />)

    expect(screen.getByRole('table', { name: 'All users' })).toBeInTheDocument()
    expect(renderedRowCount()).toBe(ROW_COUNT)
    expect(screen.getByRole('status')).toHaveTextContent(`Showing 1–${ROW_COUNT} of ${ROW_COUNT}`)
    expect(screen.getAllByRole('link')).toHaveLength(ROW_COUNT)
  })

  it('filters repeatedly and keeps counts in sync', () => {
    render(<DataTable rows={ROWS} pageSize={ROW_COUNT} />)
    const filter = screen.getByLabelText('Filter rows')

    const queries = ['a', 'ad', 'ada', 'ada l', 'berlin', 'admin', 'viewer', 'oslo', 'knuth', 'zzz', '']
    for (const q of queries) {
      fireEvent.change(filter, { target: { value: q } })
      const expected = ROWS.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.email.includes(q) ||
          r.role.toLowerCase().includes(q) ||
          r.city.toLowerCase().includes(q),
      ).length
      expect(renderedRowCount()).toBe(expected)
      expect(screen.getByRole('status')).toHaveTextContent(
        expected === 0 ? 'No matching rows' : `of ${expected}`,
      )
    }
    expect(renderedRowCount()).toBe(ROW_COUNT)
  })

  it('finds matching rows with role queries after filtering', () => {
    render(<DataTable rows={ROWS} pageSize={ROW_COUNT} />)

    fireEvent.change(screen.getByLabelText('Filter rows'), { target: { value: 'hopper' } })

    const rows = within(tbody()).getAllByRole('row')
    expect(rows.length).toBe(ROWS.filter((r) => r.name.includes('Hopper')).length)
    for (const row of rows) expect(row).toHaveTextContent(/Hopper/)
  })

  it.each<[SortKey, number]>([
    ['id', 1],
    ['name', 2],
  ])('sorts all rows by %s in both directions', (key, column) => {
    render(<DataTable rows={ROWS} pageSize={ROW_COUNT} />)
    const label = { id: 'ID', name: 'Name', age: 'Age', city: 'City', email: 'Email', role: 'Role' }[key]
    const button = screen.getByRole('button', { name: label })

    const readColumn = () =>
      Array.from(bodyRows(), (row) => row.querySelectorAll('td')[column].textContent!)
    const cmp = (a: string, b: string) =>
      key === 'id' || key === 'age' ? Number(a) - Number(b) : a.localeCompare(b)

    fireEvent.click(button)
    const asc = readColumn()
    expect(asc).toHaveLength(ROW_COUNT)
    for (let i = 1; i < asc.length; i++) expect(cmp(asc[i - 1], asc[i])).toBeLessThanOrEqual(0)

    fireEvent.click(button)
    const desc = readColumn()
    for (let i = 1; i < desc.length; i++) expect(cmp(desc[i - 1], desc[i])).toBeGreaterThanOrEqual(0)
  })

  it('selects all rows and then filters down the selection view', () => {
    render(<DataTable rows={ROWS} pageSize={ROW_COUNT} />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows on this page' }))
    expect(screen.getByTestId('selected-count')).toHaveTextContent(`${ROW_COUNT} selected`)
    expect(tbody().querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(ROW_COUNT)

    fireEvent.change(screen.getByLabelText('Filter rows'), { target: { value: 'editor' } })
    const editorRows = tbody().querySelectorAll('tr.row--selected')
    expect(editorRows.length).toBe(ROWS.filter((r) => r.role === 'Editor').length)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows on this page' }))
    expect(screen.getByTestId('selected-count')).toHaveTextContent(
      `${ROW_COUNT - editorRows.length} selected`,
    )
  })
})
