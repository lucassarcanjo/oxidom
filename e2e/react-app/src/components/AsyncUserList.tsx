import { useCallback, useEffect, useId, useMemo, useState } from 'react'

export interface ApiUser {
  id: number
  name: string
  email: string
  active: boolean
}

/** The data-fetching dependency is injected so tests can mock it with vi.fn(). */
export type FetchUsers = (options: { signal: AbortSignal }) => Promise<ApiUser[]>

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; users: ApiUser[] }

export interface AsyncUserListProps {
  fetchUsers: FetchUsers
  title?: string
}

export function AsyncUserList({ fetchUsers, title = 'Team members' }: AsyncUserListProps) {
  const searchId = useId()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [onlyActive, setOnlyActive] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    fetchUsers({ signal: controller.signal }).then(
      (users) => {
        if (!controller.signal.aborted) setState({ status: 'success', users })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        setState({ status: 'error', message })
      },
    )
    return () => controller.abort()
  }, [fetchUsers, reloadToken])

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

  const visibleUsers = useMemo(() => {
    if (state.status !== 'success') return []
    const q = query.trim().toLowerCase()
    return state.users.filter(
      (u) => (!onlyActive || u.active) && (!q || u.name.toLowerCase().includes(q)),
    )
  }, [state, query, onlyActive])

  return (
    <section className="user-list" aria-labelledby={`${searchId}-title`} aria-busy={state.status === 'loading'}>
      <header>
        <h2 id={`${searchId}-title`}>{title}</h2>
        <button type="button" onClick={reload} disabled={state.status === 'loading'}>
          Refresh
        </button>
      </header>

      {state.status === 'loading' ? (
        <p role="status" className="spinner">
          Loading users…
        </p>
      ) : null}

      {state.status === 'error' ? (
        <div role="alert" className="error">
          <p>Could not load users: {state.message}</p>
          <button type="button" onClick={reload}>
            Try again
          </button>
        </div>
      ) : null}

      {state.status === 'success' ? (
        <>
          <div className="user-list__filters">
            <label htmlFor={searchId}>Search users</label>
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label>
              <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
              Only active
            </label>
          </div>
          {visibleUsers.length === 0 ? (
            <p className="empty">No users found</p>
          ) : (
            <ul aria-label="Users">
              {visibleUsers.map((user) => (
                <li key={user.id} className={user.active ? 'user' : 'user user--inactive'}>
                  <strong>{user.name}</strong> <a href={`mailto:${user.email}`}>{user.email}</a>{' '}
                  <span className="status" aria-label={user.active ? 'active' : 'inactive'}>
                    {user.active ? '●' : '○'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="user-list__summary">
            {visibleUsers.length} of {state.users.length} users
          </p>
        </>
      ) : null}
    </section>
  )
}
