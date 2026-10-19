import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { THEME_COLORS, ThemedCard, ThemeProvider, ThemeToggle, useTheme } from '../components/Theme'

function ThemeLabel() {
  const { theme } = useTheme()
  return <p>Current theme: {theme}</p>
}

function App({ initialTheme }: { initialTheme?: 'light' | 'dark' }) {
  return (
    <ThemeProvider initialTheme={initialTheme}>
      <ThemeToggle />
      <ThemeLabel />
      <ThemedCard title="Usage">42 requests</ThemedCard>
    </ThemeProvider>
  )
}

describe('ThemeProvider', () => {
  it('applies the light theme by default', () => {
    render(<App />)
    const root = screen.getByTestId('theme-root')

    expect(root).toHaveClass('app', 'theme-light')
    expect(root).not.toHaveClass('theme-dark')
    expect(root).toHaveStyle({ backgroundColor: THEME_COLORS.light.background, color: THEME_COLORS.light.foreground })
    expect(screen.getByText('Current theme: light')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dark mode' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('toggles to dark mode and back', () => {
    render(<App />)
    const toggle = screen.getByRole('button', { name: 'Dark mode' })

    fireEvent.click(toggle)
    const root = screen.getByTestId('theme-root')
    expect(root).toHaveClass('theme-dark')
    expect(root).toHaveStyle(`background-color: ${THEME_COLORS.dark.background}`)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Current theme: dark')).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(root).toHaveClass('theme-light')
  })

  it('mirrors the theme onto the <html> element', () => {
    const { unmount } = render(<App initialTheme="dark" />)

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('dark')

    fireEvent.click(screen.getByRole('button', { name: 'Dark mode' }))
    expect(document.documentElement.dataset.theme).toBe('light')

    unmount()
    expect(document.documentElement).not.toHaveAttribute('data-theme')
  })

  it('styles themed cards from context', () => {
    render(<App initialTheme="dark" />)
    const card = screen.getByRole('article', { name: 'Usage' })

    expect(card).toHaveClass('card card--dark')
    expect(card).toHaveStyle({ borderStyle: 'solid', borderWidth: '1px', padding: '8px 12px' })
    expect(screen.getByRole('heading', { name: 'Usage' })).toHaveStyle({ color: THEME_COLORS.dark.accent })
    expect(card).toHaveTextContent('42 requests')
  })

  it('keeps theme state across rerenders and resets on remount', () => {
    const { rerender } = render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Dark mode' }))

    // initialTheme is only read on mount, so a rerender preserves state
    rerender(<App initialTheme="light" />)
    expect(screen.getByText('Current theme: dark')).toBeInTheDocument()

    // A different root element type remounts the tree
    rerender(
      <ThemeProvider initialTheme="light">
        <ThemeLabel />
      </ThemeProvider>,
    )
    expect(screen.getByText('Current theme: light')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dark mode' })).not.toBeInTheDocument()
  })

  it('exposes the context through a hook', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <ThemeProvider>{children}</ThemeProvider>
    const { result } = renderHook(() => useTheme(), { wrapper })

    expect(result.current.theme).toBe('light')
    act(() => result.current.toggleTheme())
    expect(result.current.theme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    act(() => result.current.setTheme('light'))
    expect(result.current.theme).toBe('light')
  })

  it('throws a helpful error outside the provider', () => {
    // React logs the error boundary message; keep the output clean.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<ThemeLabel />)).toThrow('useTheme must be used inside <ThemeProvider>')
    spy.mockRestore()
  })
})
