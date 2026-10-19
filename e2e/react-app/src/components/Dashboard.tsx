import { useMemo, useState } from 'react'
import { generateRows, type UserRow } from '../data/generateRows'
import { Accordion } from './Accordion'
import { AsyncUserList, type FetchUsers } from './AsyncUserList'
import { Counter } from './Counter'
import { DataTable } from './DataTable'
import { DeleteAccountDialog } from './Modal'
import { Tabs } from './Tabs'
import { ThemedCard, ThemeProvider, ThemeToggle, type ThemeName } from './Theme'
import { TodoApp, type Todo } from './TodoApp'

export interface DashboardProps {
  username: string
  fetchUsers: FetchUsers
  rows?: UserRow[]
  initialTodos?: Todo[]
  initialTheme?: ThemeName
  onDeleteAccount?: (username: string) => void
}

const FAQ = [
  { id: 'billing', title: 'How does billing work?', content: <p>You are billed monthly per active seat.</p> },
  { id: 'export', title: 'Can I export my data?', content: <p>Yes, CSV and JSON exports are available.</p> },
  { id: 'sso', title: 'Do you support SSO?', content: <p>SAML SSO is available on the Team plan.</p> },
]

export function Dashboard({
  username,
  fetchUsers,
  rows: rowsProp,
  initialTodos = [],
  initialTheme = 'light',
  onDeleteAccount = () => {},
}: DashboardProps) {
  const rows = useMemo(() => rowsProp ?? generateRows(300), [rowsProp])
  const [openTasks, setOpenTasks] = useState(() => initialTodos.filter((t) => !t.done).length)
  const [selectedRows, setSelectedRows] = useState(0)

  return (
    <ThemeProvider initialTheme={initialTheme}>
      <header className="dashboard__header">
        <h1>Dashboard</h1>
        <p>
          Signed in as <strong>{username}</strong>
        </p>
        <nav aria-label="Account">
          <ThemeToggle />
          <DeleteAccountDialog username={username} onConfirm={onDeleteAccount} />
        </nav>
      </header>
      <main>
        <section aria-label="Summary" className="dashboard__summary">
          <ThemedCard title="Open tasks">
            <p data-testid="open-tasks">{openTasks}</p>
          </ThemedCard>
          <ThemedCard title="Selected rows">
            <p data-testid="selected-rows">{selectedRows}</p>
          </ThemedCard>
        </section>
        <Tabs
          label="Dashboard sections"
          tabs={[
            {
              id: 'overview',
              label: 'Overview',
              content: (
                <>
                  <Counter label="Deploys today" max={10} />
                  <h2>FAQ</h2>
                  <Accordion items={FAQ} />
                </>
              ),
            },
            {
              id: 'tasks',
              label: 'Tasks',
              content: (
                <TodoApp
                  initialTodos={initialTodos}
                  onChange={(todos) => setOpenTasks(todos.filter((t) => !t.done).length)}
                />
              ),
            },
            { id: 'team', label: 'Team', content: <AsyncUserList fetchUsers={fetchUsers} /> },
            {
              id: 'data',
              label: 'Data',
              content: (
                <DataTable rows={rows} pageSize={20} onSelectionChange={(ids) => setSelectedRows(ids.length)} />
              ),
            },
            { id: 'billing', label: 'Billing', content: <p>Billing</p>, disabled: true },
          ]}
        />
      </main>
    </ThemeProvider>
  )
}
