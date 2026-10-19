import { useMemo, useRef, useState, type FormEvent } from 'react'

export interface Todo {
  id: number
  text: string
  done: boolean
}

export type TodoFilter = 'all' | 'active' | 'done'

const FILTERS: { value: TodoFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'done', label: 'Done' },
]

export interface TodoAppProps {
  initialTodos?: Todo[]
  onChange?: (todos: Todo[]) => void
}

export function TodoApp({ initialTodos = [], onChange }: TodoAppProps) {
  const [todos, setTodos] = useState<Todo[]>(initialTodos)
  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState<TodoFilter>('all')
  const [error, setError] = useState<string | null>(null)
  const nextId = useRef(initialTodos.reduce((max, t) => Math.max(max, t.id), 0) + 1)

  const commit = (next: Todo[]) => {
    setTodos(next)
    onChange?.(next)
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text) {
      setError('Todo text is required')
      return
    }
    if (todos.some((t) => t.text.toLowerCase() === text.toLowerCase())) {
      setError(`"${text}" is already on the list`)
      return
    }
    commit([...todos, { id: nextId.current++, text, done: false }])
    setDraft('')
    setError(null)
  }

  const toggle = (id: number) =>
    commit(todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)))

  const remove = (id: number) => commit(todos.filter((t) => t.id !== id))

  const clearDone = () => commit(todos.filter((t) => !t.done))

  const visible = useMemo(() => {
    switch (filter) {
      case 'active':
        return todos.filter((t) => !t.done)
      case 'done':
        return todos.filter((t) => t.done)
      default:
        return todos
    }
  }, [todos, filter])

  const remaining = todos.filter((t) => !t.done).length
  const doneCount = todos.length - remaining

  return (
    <section className="todo-app" aria-labelledby="todo-heading">
      <h2 id="todo-heading">Todos</h2>
      <form onSubmit={handleSubmit} aria-label="Add todo" noValidate>
        <label htmlFor="new-todo">New todo</label>
        <input
          id="new-todo"
          name="todo"
          type="text"
          placeholder="What needs to be done?"
          value={draft}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'new-todo-error' : undefined}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(null)
          }}
        />
        <button type="submit">Add</button>
        {error ? (
          <p id="new-todo-error" role="alert" className="error">
            {error}
          </p>
        ) : null}
      </form>

      <div role="group" aria-label="Filter todos" className="todo-app__filters">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            className={filter === f.value ? 'filter filter--active' : 'filter'}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="todo-app__empty">Nothing to show</p>
      ) : (
        <ul aria-label="Todo list" className="todo-app__list">
          {visible.map((todo) => (
            <li key={todo.id} className={todo.done ? 'todo todo--done' : 'todo'}>
              <label>
                <input type="checkbox" checked={todo.done} onChange={() => toggle(todo.id)} />
                <span>{todo.text}</span>
              </label>
              <button type="button" aria-label={`Delete ${todo.text}`} onClick={() => remove(todo.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <footer className="todo-app__footer">
        <span data-testid="remaining">
          {remaining} {remaining === 1 ? 'item' : 'items'} left
        </span>
        <span data-testid="done-count">{doneCount} done</span>
        <button type="button" onClick={clearDone} disabled={doneCount === 0}>
          Clear completed
        </button>
      </footer>
    </section>
  )
}
