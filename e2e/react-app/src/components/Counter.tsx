import { useState } from 'react'

export interface CounterProps {
  label?: string
  initialCount?: number
  step?: number
  min?: number
  max?: number
  onChange?: (value: number) => void
}

export function Counter({
  label = 'Counter',
  initialCount = 0,
  step = 1,
  min = 0,
  max = Number.POSITIVE_INFINITY,
  onChange,
}: CounterProps) {
  const [count, setCount] = useState(initialCount)

  const update = (next: number) => {
    const clamped = Math.min(max, Math.max(min, next))
    setCount(clamped)
    onChange?.(clamped)
  }

  const atMax = count >= max
  const atMin = count <= min

  return (
    <section className="counter" aria-label={label}>
      <h3>{label}</h3>
      <p>
        Count: <output aria-live="polite" data-testid="count">{count}</output>
      </p>
      <div className="counter__actions">
        <button type="button" onClick={() => update(count - step)} disabled={atMin}>
          Decrement
        </button>
        <button type="button" onClick={() => update(count + step)} disabled={atMax}>
          Increment
        </button>
        <button type="button" onClick={() => update(initialCount)} disabled={count === initialCount}>
          Reset
        </button>
      </div>
      {atMax && Number.isFinite(max) ? (
        <p role="note" className="counter__limit">
          Maximum of {max} reached
        </p>
      ) : null}
    </section>
  )
}
