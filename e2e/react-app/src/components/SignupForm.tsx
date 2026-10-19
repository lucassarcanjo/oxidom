import { useState, type ChangeEvent, type FocusEvent, type FormEvent } from 'react'

export type Plan = 'free' | 'pro' | 'team'

export interface SignupValues {
  name: string
  email: string
  password: string
  country: string
  bio: string
  plan: Plan
  newsletter: boolean
  terms: boolean
}

type FieldName = keyof SignupValues
type Errors = Partial<Record<FieldName, string>>

export const COUNTRIES = [
  { code: 'br', label: 'Brazil' },
  { code: 'de', label: 'Germany' },
  { code: 'jp', label: 'Japan' },
  { code: 'pt', label: 'Portugal' },
  { code: 'us', label: 'United States' },
] as const

export const BIO_LIMIT = 160

const INITIAL: SignupValues = {
  name: '',
  email: '',
  password: '',
  country: '',
  bio: '',
  plan: 'free',
  newsletter: false,
  terms: false,
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validate(values: SignupValues): Errors {
  const errors: Errors = {}
  if (values.name.trim().length < 2) errors.name = 'Name must be at least 2 characters'
  if (!values.email) errors.email = 'Email is required'
  else if (!EMAIL_RE.test(values.email)) errors.email = 'Enter a valid email address'
  if (values.password.length < 8) errors.password = 'Password must be at least 8 characters'
  else if (!/\d/.test(values.password)) errors.password = 'Password must contain a number'
  if (!values.country) errors.country = 'Please choose a country'
  if (values.bio.length > BIO_LIMIT) errors.bio = `Bio must be ${BIO_LIMIT} characters or fewer`
  if (!values.terms) errors.terms = 'You must accept the terms'
  return errors
}

export interface SignupFormProps {
  onSubmit: (values: SignupValues) => void | Promise<void>
}

export function SignupForm({ onSubmit }: SignupFormProps) {
  const [values, setValues] = useState<SignupValues>(INITIAL)
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({})
  const [showPassword, setShowPassword] = useState(false)
  const [submittedName, setSubmittedName] = useState<string | null>(null)

  const errors = validate(values)
  const isValid = Object.keys(errors).length === 0

  const handleChange = (
    event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) => {
    const { name, value, type } = event.target
    const next =
      type === 'checkbox' ? (event.target as HTMLInputElement).checked : value
    setValues((prev) => ({ ...prev, [name]: next }))
  }

  const handleBlur = (event: FocusEvent<HTMLElement & { name: string }>) => {
    const name = event.target.name as FieldName
    setTouched((prev) => (prev[name] ? prev : { ...prev, [name]: true }))
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!isValid) return
    await onSubmit(values)
    setSubmittedName(values.name.trim())
  }

  const fieldError = (name: FieldName) => (touched[name] ? errors[name] : undefined)

  const describedBy = (name: FieldName, hintId?: string) =>
    [hintId, fieldError(name) ? `${name}-error` : undefined].filter(Boolean).join(' ') || undefined

  const errorText = (name: FieldName) =>
    fieldError(name) ? (
      <p id={`${name}-error`} className="field__error">
        {errors[name]}
      </p>
    ) : null

  if (submittedName) {
    return (
      <div role="status" className="signup__success">
        <h2>Welcome aboard, {submittedName}!</h2>
        <p>Check your inbox to confirm your email.</p>
      </div>
    )
  }

  return (
    <form className="signup" aria-labelledby="signup-title" onSubmit={handleSubmit} noValidate>
      <h2 id="signup-title">Create your account</h2>

      <div className="field">
        <label htmlFor="name">Full name</label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          value={values.name}
          onChange={handleChange}
          onBlur={handleBlur}
          aria-invalid={Boolean(fieldError('name'))}
          aria-describedby={describedBy('name')}
          required
        />
        {errorText('name')}
      </div>

      <div className="field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={handleChange}
          onBlur={handleBlur}
          aria-invalid={Boolean(fieldError('email'))}
          aria-describedby={describedBy('email')}
          required
        />
        {errorText('email')}
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type={showPassword ? 'text' : 'password'}
          autoComplete="new-password"
          value={values.password}
          onChange={handleChange}
          onBlur={handleBlur}
          aria-invalid={Boolean(fieldError('password'))}
          aria-describedby={describedBy('password', 'password-hint')}
          required
        />
        <button type="button" aria-pressed={showPassword} onClick={() => setShowPassword((s) => !s)}>
          {showPassword ? 'Hide password' : 'Show password'}
        </button>
        <p id="password-hint" className="field__hint">
          At least 8 characters, including a number.
        </p>
        {errorText('password')}
      </div>

      <div className="field">
        <label htmlFor="country">Country</label>
        <select
          id="country"
          name="country"
          value={values.country}
          onChange={handleChange}
          onBlur={handleBlur}
          aria-invalid={Boolean(fieldError('country'))}
          aria-describedby={describedBy('country')}
          required
        >
          <option value="" disabled>
            Select a country
          </option>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </select>
        {errorText('country')}
      </div>

      <div className="field">
        <label htmlFor="bio">Short bio</label>
        <textarea
          id="bio"
          name="bio"
          rows={3}
          value={values.bio}
          onChange={handleChange}
          onBlur={handleBlur}
          aria-invalid={Boolean(fieldError('bio'))}
          aria-describedby={describedBy('bio', 'bio-count')}
        />
        <p id="bio-count" className={values.bio.length > BIO_LIMIT ? 'counter counter--over' : 'counter'}>
          {values.bio.length}/{BIO_LIMIT}
        </p>
        {errorText('bio')}
      </div>

      <fieldset className="field">
        <legend>Plan</legend>
        {(['free', 'pro', 'team'] as const).map((plan) => (
          <label key={plan}>
            <input
              type="radio"
              name="plan"
              value={plan}
              checked={values.plan === plan}
              onChange={handleChange}
            />
            {plan[0].toUpperCase() + plan.slice(1)}
          </label>
        ))}
      </fieldset>
      {values.plan !== 'free' ? (
        <p className="plan-note" data-testid="plan-note">
          The {values.plan} plan starts with a 14-day free trial.
        </p>
      ) : null}

      <div className="field field--inline">
        <input
          id="newsletter"
          name="newsletter"
          type="checkbox"
          checked={values.newsletter}
          onChange={handleChange}
        />
        <label htmlFor="newsletter">Send me product updates</label>
      </div>

      <div className="field field--inline">
        <input
          id="terms"
          name="terms"
          type="checkbox"
          checked={values.terms}
          onChange={handleChange}
          onBlur={handleBlur}
          aria-invalid={Boolean(fieldError('terms'))}
          aria-describedby={describedBy('terms')}
        />
        <label htmlFor="terms">I accept the terms of service</label>
        {errorText('terms')}
      </div>

      <button type="submit" disabled={!isValid}>
        Create account
      </button>
    </form>
  )
}
