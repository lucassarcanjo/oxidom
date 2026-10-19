// @tanstack/react-table v9: render + client-side sorting by clicking a header
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  createColumnHelper, tableFeatures, useTable, rowSortingFeature, createSortedRowModel, sortFn_alphanumeric,
} from '@tanstack/react-table'

type Person = { name: string; age: number }
const features = tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel(), sortFns: { alphanumeric: sortFn_alphanumeric } })
const helper = createColumnHelper<typeof features, Person>()
const columns = helper.columns([
  helper.accessor('name', { header: 'Name' }),
  helper.accessor('age', { header: 'Age' }),
])
const data: Person[] = [
  { name: 'Charles', age: 41 }, { name: 'Ada', age: 36 }, { name: 'Barbara', age: 52 },
]

function People() {
  const table = useTable({ features, columns, data })
  return (
    <table>
      <thead>
        {table.getHeaderGroups().map((g) => (
          <tr key={g.id}>
            {g.headers.map((h) => (
              <th key={h.id}>
                <button onClick={h.column.getToggleSortingHandler()}>
                  <table.FlexRender header={h} />
                </button>
                {{ asc: ' ▲', desc: ' ▼' }[h.column.getIsSorted() as string] ?? null}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((r) => (
          <tr key={r.id}>{r.getAllCells().map((c) => <td key={c.id}><table.FlexRender cell={c} /></td>)}</tr>
        ))}
      </tbody>
    </table>
  )
}

const names = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent)

describe('@tanstack/react-table', () => {
  test('renders rows and sorts by header click', async () => {
    const user = userEvent.setup()
    render(<People />)
    expect(screen.getAllByRole('columnheader')).toHaveLength(2)
    expect(names()).toEqual(['Charles', 'Ada', 'Barbara'])
    await user.click(screen.getByRole('button', { name: 'Name' }))
    expect(names()).toEqual(['Ada', 'Barbara', 'Charles'])
    await user.click(screen.getByRole('button', { name: /Name/ }))
    expect(names()).toEqual(['Charles', 'Barbara', 'Ada'])
  })
})
