import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BIO_LIMIT, SignupForm, validate, type SignupValues } from '../components/SignupForm'

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Full name'), 'Grace Hopper')
  await user.type(screen.getByLabelText('Email'), 'grace@example.com')
  await user.type(screen.getByLabelText('Password'), 'cobol1959')
  await user.selectOptions(screen.getByLabelText('Country'), 'United States')
  await user.click(screen.getByLabelText('I accept the terms of service'))
}

describe('validate()', () => {
  it('reports every missing field for an empty form', () => {
    const errors = validate({
      name: '',
      email: '',
      password: '',
      country: '',
      bio: '',
      plan: 'free',
      newsletter: false,
      terms: false,
    })
    expect(Object.keys(errors).sort()).toEqual(['country', 'email', 'name', 'password', 'terms'])
  })
})

describe('<SignupForm />', () => {
  it('associates every control with its label', () => {
    render(<SignupForm onSubmit={() => {}} />)

    expect(screen.getByRole('form', { name: 'Create your account' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveAttribute('autocomplete', 'name')
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveAttribute('type', 'email')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(screen.getByRole('combobox', { name: 'Country' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Short bio' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Plan' })).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByRole('radio', { name: 'Free' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Send me product updates' })).not.toBeChecked()
  })

  it('keeps submit disabled until the form is valid', async () => {
    const user = userEvent.setup()
    render(<SignupForm onSubmit={() => {}} />)
    const submit = screen.getByRole('button', { name: 'Create account' })

    expect(submit).toBeDisabled()
    await fillValidForm(user)
    expect(submit).toBeEnabled()

    await user.click(screen.getByLabelText('I accept the terms of service'))
    expect(submit).toBeDisabled()
  })

  it('shows validation messages only after a field is blurred', async () => {
    const user = userEvent.setup()
    render(<SignupForm onSubmit={() => {}} />)
    const email = screen.getByLabelText('Email')

    await user.type(email, 'not-an-email')
    expect(screen.queryByText('Enter a valid email address')).not.toBeInTheDocument()
    expect(email).toHaveAttribute('aria-invalid', 'false')

    await user.tab()
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument()
    expect(email).toBeInvalid()
    expect(email).toHaveAccessibleDescription('Enter a valid email address')

    await user.clear(email)
    await user.type(email, 'ok@example.com')
    expect(screen.queryByText('Enter a valid email address')).not.toBeInTheDocument()
    expect(email).toHaveAttribute('aria-invalid', 'false')
  })

  it('validates password length and digits and links the hint', async () => {
    const user = userEvent.setup()
    render(<SignupForm onSubmit={() => {}} />)
    const password = screen.getByLabelText('Password')

    await user.type(password, 'short')
    await user.tab()
    expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument()
    expect(password).toHaveAccessibleDescription(
      'At least 8 characters, including a number. Password must be at least 8 characters',
    )

    await user.type(password, 'withoutdigits')
    expect(screen.getByText('Password must contain a number')).toBeInTheDocument()

    await user.type(password, '1')
    expect(password).toHaveAccessibleDescription('At least 8 characters, including a number.')
  })

  it('toggles password visibility', async () => {
    const user = userEvent.setup()
    render(<SignupForm onSubmit={() => {}} />)
    const password = screen.getByLabelText('Password')

    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(password).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(password).toHaveAttribute('type', 'password')
  })

  it('selects a country, a plan and toggles the newsletter', async () => {
    const user = userEvent.setup()
    render(<SignupForm onSubmit={() => {}} />)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Country' }), 'pt')
    expect(screen.getByRole('combobox')).toHaveValue('pt')
    expect(screen.getByRole<HTMLOptionElement>('option', { name: 'Portugal' }).selected).toBe(true)
    expect(screen.getByRole('combobox')).toHaveDisplayValue('Portugal')

    await user.click(screen.getByRole('radio', { name: 'Team' }))
    expect(screen.getByRole('radio', { name: 'Team' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Free' })).not.toBeChecked()
    expect(screen.getByTestId('plan-note')).toHaveTextContent('The team plan starts with a 14-day free trial.')

    await user.click(screen.getByRole('checkbox', { name: 'Send me product updates' }))
    expect(screen.getByRole('checkbox', { name: 'Send me product updates' })).toBeChecked()
  })

  it('counts bio characters and flags overly long bios', () => {
    render(<SignupForm onSubmit={() => {}} />)
    const bio = screen.getByLabelText('Short bio')

    fireEvent.change(bio, { target: { value: 'Rear admiral, compiler pioneer.' } })
    expect(screen.getByText(`31/${BIO_LIMIT}`)).toBeInTheDocument()

    fireEvent.change(bio, { target: { value: 'x'.repeat(BIO_LIMIT + 5) } })
    fireEvent.blur(bio)
    expect(screen.getByText(`${BIO_LIMIT + 5}/${BIO_LIMIT}`)).toHaveClass('counter--over')
    expect(screen.getByText(`Bio must be ${BIO_LIMIT} characters or fewer`)).toBeInTheDocument()
  })

  it('exposes the current values through the form', async () => {
    const user = userEvent.setup()
    render(<SignupForm onSubmit={() => {}} />)

    await fillValidForm(user)
    await user.click(screen.getByRole('radio', { name: 'Pro' }))

    expect(screen.getByRole('form')).toHaveFormValues({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      country: 'us',
      plan: 'pro',
      newsletter: false,
      terms: true,
    })
  })

  it('submits the collected values and shows a success message', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn<(values: SignupValues) => Promise<void>>().mockResolvedValue(undefined)
    render(<SignupForm onSubmit={onSubmit} />)

    await fillValidForm(user)
    await user.type(screen.getByLabelText('Short bio'), 'Invented the first compiler.')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'cobol1959',
      country: 'us',
      bio: 'Invented the first compiler.',
      plan: 'free',
      newsletter: false,
      terms: true,
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Welcome aboard, Grace Hopper!')
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
  })

  it('walks through the fields in tab order', async () => {
    const user = userEvent.setup()
    render(<SignupForm onSubmit={() => {}} />)

    await user.tab()
    expect(screen.getByLabelText('Full name')).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('Email')).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('Password')).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('Country')).toHaveFocus()
  })
})
