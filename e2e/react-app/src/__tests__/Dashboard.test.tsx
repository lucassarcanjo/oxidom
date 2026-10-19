import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiUser, FetchUsers } from '../components/AsyncUserList'
import { Dashboard } from '../components/Dashboard'
import type { Todo } from '../components/TodoApp'

const USERS: ApiUser[] = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', active: true },
  { id: 2, name: 'Linus Torvalds', email: 'linus@example.com', active: true },
]

const TODOS: Todo[] = [
  { id: 1, text: 'Review PR', done: false },
  { id: 2, text: 'Update docs', done: false },
  { id: 3, text: 'Release', done: true },
]

function setup(overrides: Partial<Parameters<typeof Dashboard>[0]> = {}) {
  const fetchUsers = vi.fn<FetchUsers>(() => Promise.resolve(USERS))
  const onDeleteAccount = vi.fn()
  const utils = render(
    <Dashboard
      username="ada"
      fetchUsers={fetchUsers}
      initialTodos={TODOS}
      onDeleteAccount={onDeleteAccount}
      {...overrides}
    />,
  )
  return { ...utils, fetchUsers, onDeleteAccount }
}

describe('<Dashboard />', () => {
  it('renders the shell with landmarks, summary cards and tabs', () => {
    setup()

    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByRole('banner')).toHaveTextContent('Signed in as ada')
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Account' })).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Open tasks' })).toHaveTextContent('2')
    expect(within(screen.getByRole('tablist')).getAllByRole('tab')).toHaveLength(5)
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the overview counter and FAQ accordion', () => {
    setup()
    const panel = screen.getByRole('tabpanel', { name: 'Overview' })

    fireEvent.click(within(panel).getByRole('button', { name: 'Increment' }))
    expect(within(panel).getByTestId('count')).toHaveTextContent('1')

    fireEvent.click(within(panel).getByRole('button', { name: 'Can I export my data?' }))
    expect(within(panel).getByRole('region', { name: 'Can I export my data?' })).toHaveTextContent(
      'CSV and JSON exports',
    )
  })

  it('does not fetch team members until the Team tab is opened', async () => {
    const { fetchUsers } = setup()
    expect(fetchUsers).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: 'Team' }))

    const panel = screen.getByRole('tabpanel', { name: 'Team' })
    expect(within(panel).getByRole('status')).toHaveTextContent('Loading users…')
    expect(await within(panel).findAllByRole('listitem')).toHaveLength(2)
    expect(fetchUsers).toHaveBeenCalledTimes(1)
  })

  it('updates the open task summary from the Tasks tab', () => {
    setup()
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }))

    fireEvent.change(screen.getByLabelText('New todo'), { target: { value: 'Plan sprint' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByTestId('open-tasks')).toHaveTextContent('3')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Review PR' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Update docs' }))
    expect(screen.getByTestId('open-tasks')).toHaveTextContent('1')
  })

  it('selects rows in the Data tab and reflects them in the summary', () => {
    setup()
    fireEvent.click(screen.getByRole('tab', { name: 'Data' }))

    const table = screen.getByRole('table', { name: 'Users' })
    expect(within(table).getAllByRole('row')).toHaveLength(21) // header + 20 rows
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows on this page' }))
    expect(screen.getByTestId('selected-rows')).toHaveTextContent('20')

    fireEvent.change(screen.getByLabelText('Filter rows'), { target: { value: 'admin' } })
    fireEvent.click(screen.getByRole('button', { name: 'Age' }))
    expect(screen.getByRole('columnheader', { name: 'Age' })).toHaveAttribute('aria-sort', 'ascending')
  })

  it('switches theme for the whole dashboard', () => {
    setup({ initialTheme: 'dark' })
    const root = screen.getByTestId('theme-root')
    expect(root).toHaveClass('theme-dark')

    fireEvent.click(screen.getByRole('button', { name: 'Dark mode' }))

    expect(root).toHaveClass('theme-light')
    expect(root).toHaveStyle({ backgroundColor: '#ffffff' })
    for (const card of screen.getAllByRole('article')) expect(card).toHaveClass('card--light')
  })

  it('deletes the account through the confirmation dialog', () => {
    const { onDeleteAccount } = setup()

    // fireEvent does not move focus the way a real click does
    const trigger = screen.getByRole('button', { name: 'Delete account' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Delete account?' })
    expect(within(dialog).getByLabelText('Type DELETE to confirm')).toHaveFocus()

    fireEvent.change(within(dialog).getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete forever' }))

    expect(onDeleteAccount).toHaveBeenCalledWith('ada')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('keeps the disabled Billing tab inactive', () => {
    setup()
    fireEvent.click(screen.getByRole('tab', { name: 'Billing' }))
    expect(screen.getByRole('tab', { name: 'Billing' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Overview')
  })
})
