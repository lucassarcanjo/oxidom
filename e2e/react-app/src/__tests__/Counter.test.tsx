import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Counter } from '../components/Counter'

describe('<Counter />', () => {
  it('renders the label and the initial count', () => {
    render(<Counter label="Clicks" initialCount={3} />)

    expect(screen.getByRole('heading', { name: 'Clicks' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Clicks' })).toBeInTheDocument()
    expect(screen.getByTestId('count')).toHaveTextContent('3')
  })

  it('increments and decrements by the configured step', () => {
    render(<Counter step={5} initialCount={10} />)

    fireEvent.click(screen.getByRole('button', { name: 'Increment' }))
    fireEvent.click(screen.getByRole('button', { name: 'Increment' }))
    expect(screen.getByTestId('count')).toHaveTextContent('20')

    fireEvent.click(screen.getByRole('button', { name: 'Decrement' }))
    expect(screen.getByTestId('count')).toHaveTextContent('15')
  })

  it('disables decrement at the minimum and increment at the maximum', () => {
    render(<Counter initialCount={0} max={2} />)

    const decrement = screen.getByRole('button', { name: 'Decrement' })
    const increment = screen.getByRole('button', { name: 'Increment' })
    expect(decrement).toBeDisabled()
    expect(increment).toBeEnabled()
    expect(screen.queryByRole('note')).not.toBeInTheDocument()

    fireEvent.click(increment)
    fireEvent.click(increment)

    expect(increment).toBeDisabled()
    expect(decrement).toBeEnabled()
    expect(screen.getByRole('note')).toHaveTextContent('Maximum of 2 reached')
  })

  it('resets to the initial value', () => {
    render(<Counter initialCount={4} />)
    const reset = screen.getByRole('button', { name: 'Reset' })
    expect(reset).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Increment' }))
    expect(reset).toBeEnabled()
    fireEvent.click(reset)

    expect(screen.getByTestId('count')).toHaveTextContent('4')
    expect(reset).toBeDisabled()
  })

  it('reports every change through onChange', () => {
    const onChange = vi.fn()
    render(<Counter onChange={onChange} />)

    const increment = screen.getByRole('button', { name: /increment/i })
    for (let i = 0; i < 5; i++) fireEvent.click(increment)

    expect(onChange).toHaveBeenCalledTimes(5)
    expect(onChange).toHaveBeenLastCalledWith(5)
  })

  it('keeps state across a rerender with new props', () => {
    const { rerender } = render(<Counter label="Before" />)
    fireEvent.click(screen.getByRole('button', { name: 'Increment' }))

    rerender(<Counter label="After" />)

    expect(screen.queryByRole('heading', { name: 'Before' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'After' })).toBeInTheDocument()
    expect(screen.getByTestId('count')).toHaveTextContent('1')
  })

  it('removes everything from the document on unmount', () => {
    const { unmount, container } = render(<Counter label="Temporary" />)
    expect(container).not.toBeEmptyDOMElement()

    unmount()

    expect(screen.queryByRole('heading', { name: 'Temporary' })).toBeNull()
    expect(container).toBeEmptyDOMElement()
  })
})
