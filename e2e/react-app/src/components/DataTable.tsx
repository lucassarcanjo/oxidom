import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { UserRow } from '../data/generateRows'

export type SortKey = 'id' | 'name' | 'email' | 'role' | 'age' | 'city'
export type SortDirection = 'ascending' | 'descending'

interface Column {
  key: SortKey
  label: string
  numeric?: boolean
}

const COLUMNS: Column[] = [
  { key: 'id', label: 'ID', numeric: true },
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'role', label: 'Role' },
  { key: 'age', label: 'Age', numeric: true },
  { key: 'city', label: 'City' },
]

export interface DataTableProps {
  rows: UserRow[]
  caption?: string
  pageSize?: number
  onSelectionChange?: (selectedIds: number[]) => void
}

function compare(a: UserRow, b: UserRow, key: SortKey): number {
  const av = a[key]
  const bv = b[key]
  if (typeof av === 'number' && typeof bv === 'number') return av - bv
  return String(av).localeCompare(String(bv)) || a.id - b.id
}

export function DataTable({ rows, caption = 'Users', pageSize = 25, onSelectionChange }: DataTableProps) {
  const filterId = useId()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection } | null>(null)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set())
  const selectAllRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.email.includes(q) ||
        r.role.toLowerCase().includes(q) ||
        r.city.toLowerCase().includes(q),
    )
  }, [rows, query])

  const sorted = useMemo(() => {
    if (!sort) return filtered
    const factor = sort.direction === 'ascending' ? 1 : -1
    return [...filtered].sort((a, b) => factor * compare(a, b, sort.key))
  }, [filtered, sort])

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const start = (currentPage - 1) * pageSize
  const pageRows = sorted.slice(start, start + pageSize)

  const selectedOnPage = pageRows.filter((r) => selected.has(r.id)).length
  const allOnPageSelected = pageRows.length > 0 && selectedOnPage === pageRows.length
  const someOnPageSelected = selectedOnPage > 0 && !allOnPageSelected

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someOnPageSelected
  }, [someOnPageSelected])

  const updateSelection = (next: Set<number>) => {
    setSelected(next)
    onSelectionChange?.([...next].sort((a, b) => a - b))
  }

  const toggleRow = (id: number) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    updateSelection(next)
  }

  const togglePage = () => {
    const next = new Set(selected)
    if (allOnPageSelected) pageRows.forEach((r) => next.delete(r.id))
    else pageRows.forEach((r) => next.add(r.id))
    updateSelection(next)
  }

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev?.key === key
        ? { key, direction: prev.direction === 'ascending' ? 'descending' : 'ascending' }
        : { key, direction: 'ascending' },
    )
  }

  const rangeText =
    sorted.length === 0
      ? 'No matching rows'
      : `Showing ${start + 1}–${start + pageRows.length} of ${sorted.length}`

  return (
    <section className="data-table" aria-label={`${caption} table`}>
      <div className="data-table__toolbar">
        <label htmlFor={filterId}>Filter rows</label>
        <input
          id={filterId}
          type="search"
          value={query}
          placeholder="Name, email, role or city"
          onChange={(e) => {
            setQuery(e.target.value)
            setPage(1)
          }}
        />
        <span role="status" className="data-table__range">
          {rangeText}
        </span>
        <span data-testid="selected-count">{selected.size} selected</span>
      </div>

      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">
              <input
                ref={selectAllRef}
                type="checkbox"
                aria-label="Select all rows on this page"
                checked={allOnPageSelected}
                disabled={pageRows.length === 0}
                onChange={togglePage}
              />
            </th>
            {COLUMNS.map((col) => {
              const ariaSort = sort?.key === col.key ? sort.direction : 'none'
              return (
                <th key={col.key} scope="col" aria-sort={ariaSort} className={col.numeric ? 'numeric' : undefined}>
                  <button type="button" onClick={() => toggleSort(col.key)}>
                    {col.label}
                  </button>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {pageRows.map((row) => {
            const isSelected = selected.has(row.id)
            return (
              <tr key={row.id} aria-selected={isSelected} className={isSelected ? 'row row--selected' : 'row'}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select row ${row.id}`}
                    checked={isSelected}
                    onChange={() => toggleRow(row.id)}
                  />
                </td>
                <td className="numeric">{row.id}</td>
                <td>{row.name}</td>
                <td>
                  <a href={`mailto:${row.email}`}>{row.email}</a>
                </td>
                <td>
                  <span className={`badge badge--${row.role.toLowerCase()}`}>{row.role}</span>
                </td>
                <td className="numeric">{row.age}</td>
                <td>{row.city}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <nav aria-label="Pagination" className="data-table__pagination">
        <button type="button" onClick={() => setPage(1)} disabled={currentPage === 1}>
          First
        </button>
        <button type="button" onClick={() => setPage(currentPage - 1)} disabled={currentPage === 1}>
          Previous
        </button>
        <span aria-current="page">
          Page {currentPage} of {pageCount}
        </span>
        <button type="button" onClick={() => setPage(currentPage + 1)} disabled={currentPage === pageCount}>
          Next
        </button>
        <button type="button" onClick={() => setPage(pageCount)} disabled={currentPage === pageCount}>
          Last
        </button>
      </nav>
    </section>
  )
}
