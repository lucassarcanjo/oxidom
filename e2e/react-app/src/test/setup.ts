// Global test setup shared by every DOM environment (jsdom, happy-dom, oxidom).
//
// - Registers the @testing-library/jest-dom matchers on Vitest's `expect`
//   (toBeInTheDocument, toHaveTextContent, toHaveStyle, ...).
// - Unmounts React trees rendered with @testing-library/react after each test.
//   RTL also auto-registers this when `afterEach` is a global (globals: true),
//   but real projects commonly register it explicitly; cleanup() is idempotent.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
