import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemeName = 'light' | 'dark'

export const THEME_COLORS: Record<ThemeName, { background: string; foreground: string; accent: string }> = {
  light: { background: '#ffffff', foreground: '#111111', accent: '#0055cc' },
  dark: { background: '#1e1e1e', foreground: '#f5f5f5', accent: '#66aaff' },
}

interface ThemeContextValue {
  theme: ThemeName
  setTheme: (theme: ThemeName) => void
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>')
  return ctx
}

export interface ThemeProviderProps {
  initialTheme?: ThemeName
  children: ReactNode
}

export function ThemeProvider({ initialTheme = 'light', children }: ThemeProviderProps) {
  const [theme, setTheme] = useState<ThemeName>(initialTheme)

  // Mirror the theme onto <html> like real apps do (for CSS variables / color-scheme).
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    root.style.setProperty('color-scheme', theme)
    return () => {
      delete root.dataset.theme
      root.style.removeProperty('color-scheme')
    }
  }, [theme])

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggleTheme: () => setTheme((t) => (t === 'light' ? 'dark' : 'light')) }),
    [theme],
  )

  const colors = THEME_COLORS[theme]

  return (
    <ThemeContext.Provider value={value}>
      <div
        data-testid="theme-root"
        className={`app theme-${theme}`}
        style={{ backgroundColor: colors.background, color: colors.foreground, minHeight: '100%' }}
      >
        {children}
      </div>
    </ThemeContext.Provider>
  )
}

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  return (
    <button type="button" aria-pressed={theme === 'dark'} onClick={toggleTheme} className="theme-toggle">
      Dark mode
    </button>
  )
}

export function ThemedCard({ title, children }: { title: string; children?: ReactNode }) {
  const { theme } = useTheme()
  const colors = THEME_COLORS[theme]
  return (
    <article
      className={`card card--${theme}`}
      style={{ borderColor: colors.accent, borderWidth: 1, borderStyle: 'solid', padding: '8px 12px' }}
      aria-label={title}
    >
      <h3 style={{ color: colors.accent }}>{title}</h3>
      {children}
    </article>
  )
}
