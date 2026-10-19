// react-hook-form: validation errors + successful submit
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'

type Values = { email: string; age: number; terms: boolean }

function Signup({ onSubmit }: { onSubmit: (v: Values) => void }) {
  const { register, handleSubmit, formState: { errors } } = useForm<Values>({ mode: 'onSubmit' })
  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" {...register('email', { required: 'Email is required', pattern: { value: /\S+@\S+/, message: 'Invalid email' } })} />
      {errors.email && <p role="alert">{errors.email.message}</p>}
      <label htmlFor="age">Age</label>
      <input id="age" type="number" {...register('age', { valueAsNumber: true, min: { value: 18, message: 'Too young' } })} />
      {errors.age && <p role="alert">{errors.age.message}</p>}
      <label><input type="checkbox" {...register('terms', { required: 'Accept the terms' })} /> I agree</label>
      {errors.terms && <p role="alert">{errors.terms.message}</p>}
      <button type="submit">Sign up</button>
    </form>
  )
}

describe('react-hook-form', () => {
  test('shows validation errors and focuses first invalid field', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Signup onSubmit={onSubmit} />)
    await user.type(screen.getByLabelText('Age'), '12')
    await user.click(screen.getByRole('button', { name: 'Sign up' }))
    const alerts = await screen.findAllByRole('alert')
    expect(alerts.map((a) => a.textContent)).toEqual(['Email is required', 'Too young', 'Accept the terms'])
    expect(screen.getByLabelText('Email')).toHaveFocus()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('submits typed values', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Signup onSubmit={onSubmit} />)
    await user.type(screen.getByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Age'), '36')
    await user.click(screen.getByLabelText('I agree'))
    await user.click(screen.getByRole('button', { name: 'Sign up' }))
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({ email: 'ada@example.com', age: 36, terms: true })
  })
})
