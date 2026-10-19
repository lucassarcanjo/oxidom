import { act, fireEvent, render, screen, waitFor, waitForElementToBeRemoved, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AsyncUserList, type ApiUser, type FetchUsers } from '../components/AsyncUserList'

const USERS: ApiUser[] = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', active: true },
  { id: 2, name: 'Alan Turing', email: 'alan@example.com', active: false },
  { id: 3, name: 'Grace Hopper', email: 'grace@example.com', active: true },
  { id: 4, name: 'Edsger Dijkstra', email: 'edsger@example.com', active: true },
]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Simulates network latency like a real fetch wrapper would. */
function delayed<T>(value: T, ms = 10): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

describe('<AsyncUserList />', () => {
  it('shows a loading state, then the users', async () => {
    const fetchUsers = vi.fn<FetchUsers>(() => delayed(USERS))
    render(<AsyncUserList fetchUsers={fetchUsers} />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading users…')
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()

    const list = await screen.findByRole('list', { name: 'Users' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(4)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('4 of 4 users')).toBeInTheDocument()
    expect(fetchUsers).toHaveBeenCalledTimes(1)
    expect(fetchUsers).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) })
  })

  it('renders links and status labels for each user', async () => {
    render(<AsyncUserList fetchUsers={() => Promise.resolve(USERS)} />)

    const link = await screen.findByRole('link', { name: 'grace@example.com' })
    expect(link).toHaveAttribute('href', 'mailto:grace@example.com')
    expect(screen.getAllByLabelText('active')).toHaveLength(3)
    expect(screen.getByLabelText('inactive').closest('li')).toHaveClass('user--inactive')
  })

  it('waits for the spinner to disappear', async () => {
    render(<AsyncUserList fetchUsers={() => delayed(USERS, 20)} />)

    await waitForElementToBeRemoved(() => screen.queryByText('Loading users…'))

    expect(screen.getByRole('heading', { name: 'Team members' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Team members' })).toHaveAttribute('aria-busy', 'false')
  })

  it('shows an error and recovers with "Try again"', async () => {
    const fetchUsers = vi
      .fn<FetchUsers>()
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce(USERS.slice(0, 2))
    render(<AsyncUserList fetchUsers={fetchUsers} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load users: 503 Service Unavailable')

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await screen.findAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(fetchUsers).toHaveBeenCalledTimes(2)
  })

  it('filters loaded users by name and activity', async () => {
    render(<AsyncUserList fetchUsers={() => delayed(USERS)} />)
    const search = await screen.findByRole('searchbox', { name: 'Search users' })

    fireEvent.change(search, { target: { value: 'a' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(4)

    fireEvent.change(search, { target: { value: 'tur' } })
    expect(screen.getByRole('listitem')).toHaveTextContent('Alan Turing')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Only active' }))
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
    expect(screen.getByText('No users found')).toBeInTheDocument()
    expect(screen.getByText('0 of 4 users')).toBeInTheDocument()
  })

  it('refreshes and shows the latest data', async () => {
    const fetchUsers = vi
      .fn<FetchUsers>()
      .mockResolvedValueOnce(USERS.slice(0, 1))
      .mockImplementationOnce(() => delayed(USERS, 15))
    render(<AsyncUserList fetchUsers={fetchUsers} />)

    expect(await screen.findAllByRole('listitem')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(screen.getByRole('status')).toBeInTheDocument()

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(4))
  })

  it('ignores a response that resolves after unmount', async () => {
    const pending = deferred<ApiUser[]>()
    const consoleError = vi.spyOn(console, 'error')
    const fetchUsers = vi.fn<FetchUsers>(() => pending.promise)
    const { unmount } = render(<AsyncUserList fetchUsers={fetchUsers} />)

    const { signal } = fetchUsers.mock.calls[0][0]
    expect(signal.aborted).toBe(false)
    unmount()
    expect(signal.aborted).toBe(true)

    await act(async () => {
      pending.resolve(USERS)
      await pending.promise
    })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('handles an empty response', async () => {
    const pending = deferred<ApiUser[]>()
    render(<AsyncUserList fetchUsers={() => pending.promise} title="Guests" />)
    expect(screen.getByRole('status')).toBeInTheDocument()

    await act(async () => pending.resolve([]))

    expect(screen.getByText('No users found')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Guests' })).toBeInTheDocument()
  })
})
