import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TodoApp, type Todo } from '../components/TodoApp'

const seed: Todo[] = [
  { id: 1, text: 'Write tests', done: false },
  { id: 2, text: 'Ship feature', done: false },
  { id: 3, text: 'Drink coffee', done: true },
]

function addTodo(text: string) {
  fireEvent.change(screen.getByLabelText('New todo'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
}

function getList() {
  return screen.getByRole('list', { name: 'Todo list' })
}

describe('<TodoApp />', () => {
  it('renders an empty state when there are no todos', () => {
    render(<TodoApp />)

    expect(screen.getByRole('heading', { level: 2, name: 'Todos' })).toBeInTheDocument()
    expect(screen.getByText('Nothing to show')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.getByTestId('remaining')).toHaveTextContent('0 items left')
    expect(screen.getByRole('button', { name: 'Clear completed' })).toBeDisabled()
  })

  it('adds a todo through the form and clears the input', () => {
    const onChange = vi.fn()
    render(<TodoApp onChange={onChange} />)

    addTodo('  Buy milk  ')

    const items = within(getList()).getAllByRole('listitem')
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent('Buy milk')
    expect(screen.getByLabelText('New todo')).toHaveValue('')
    expect(screen.getByTestId('remaining')).toHaveTextContent('1 item left')
    expect(onChange).toHaveBeenCalledWith([{ id: 1, text: 'Buy milk', done: false }])
  })

  it('submits with the Enter key via form submit', () => {
    render(<TodoApp />)
    const input = screen.getByPlaceholderText('What needs to be done?')

    fireEvent.change(input, { target: { value: 'Read a book' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Add todo' }))

    expect(screen.getByText('Read a book')).toBeInTheDocument()
  })

  it('validates empty and duplicate todos', () => {
    render(<TodoApp initialTodos={seed} />)

    addTodo('   ')
    const input = screen.getByLabelText('New todo')
    expect(screen.getByRole('alert')).toHaveTextContent('Todo text is required')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Todo text is required')

    addTodo('write TESTS')
    expect(screen.getByRole('alert')).toHaveTextContent('"write TESTS" is already on the list')
    expect(within(getList()).getAllByRole('listitem')).toHaveLength(3)

    fireEvent.change(input, { target: { value: 'write TESTS!' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('toggles a todo and updates the counters', () => {
    render(<TodoApp initialTodos={seed} />)
    expect(screen.getByTestId('remaining')).toHaveTextContent('2 items left')

    const checkbox = screen.getByRole('checkbox', { name: 'Write tests' })
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)

    expect(checkbox).toBeChecked()
    expect(checkbox.closest('li')).toHaveClass('todo', 'todo--done')
    expect(screen.getByTestId('remaining')).toHaveTextContent('1 item left')
    expect(screen.getByTestId('done-count')).toHaveTextContent('2 done')
  })

  it('deletes a todo', () => {
    render(<TodoApp initialTodos={seed} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete Ship feature' }))

    expect(screen.queryByText('Ship feature')).not.toBeInTheDocument()
    expect(within(getList()).getAllByRole('listitem')).toHaveLength(2)
  })

  it('filters by all / active / done', () => {
    render(<TodoApp initialTodos={seed} />)
    const filters = screen.getByRole('group', { name: 'Filter todos' })

    fireEvent.click(within(filters).getByRole('button', { name: 'Active' }))
    expect(within(filters).getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(getList()).getAllByRole('checkbox').map((c) => c.closest('li')!.textContent)).toEqual([
      'Write tests×',
      'Ship feature×',
    ])

    fireEvent.click(within(filters).getByRole('button', { name: 'Done' }))
    expect(within(getList()).getByRole('checkbox', { name: 'Drink coffee' })).toBeChecked()
    expect(within(getList()).getAllByRole('listitem')).toHaveLength(1)

    fireEvent.click(within(filters).getByRole('button', { name: 'All' }))
    expect(within(getList()).getAllByRole('listitem')).toHaveLength(3)
    expect(within(filters).getByRole('button', { name: 'All' })).toHaveClass('filter--active')
  })

  it('shows the empty state when a filter matches nothing', () => {
    render(<TodoApp initialTodos={seed.filter((t) => !t.done)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.getByText('Nothing to show')).toBeInTheDocument()
  })

  it('clears completed todos', () => {
    render(<TodoApp initialTodos={seed} />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Write tests' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear completed' }))

    const remaining = within(getList()).getAllByRole('checkbox')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toHaveAccessibleName('Ship feature')
    expect(screen.getByRole('button', { name: 'Clear completed' })).toBeDisabled()
  })

  it('handles a longer session of adds and toggles', () => {
    render(<TodoApp />)

    for (let i = 1; i <= 30; i++) addTodo(`Task ${i}`)
    for (let i = 1; i <= 30; i += 3) fireEvent.click(screen.getByRole('checkbox', { name: `Task ${i}` }))

    expect(within(getList()).getAllByRole('listitem')).toHaveLength(30)
    expect(screen.getByTestId('remaining')).toHaveTextContent('20 items left')
    expect(screen.getByTestId('done-count')).toHaveTextContent('10 done')

    fireEvent.click(screen.getByRole('button', { name: 'Clear completed' }))
    expect(within(getList()).getAllByRole('listitem')).toHaveLength(20)
  })
})
