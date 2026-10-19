// Shared setup for every DOM (jsdom, happy-dom, rsdom) -- identical for all three.
//
// 1. jest-dom matchers + RTL cleanup (same as e2e/react-app/src/test/setup.ts).
// 2. Documented test-setup shims ("polyfills"). Only shims that library docs / the
//    Jest & Vitest docs tell jsdom users to add are allowed here. Each one is
//    installed ONLY IF THE API IS MISSING, so a DOM that implements it natively is
//    exercised with its own implementation. Which shims were actually installed
//    in each DOM is recorded by tests/_env-probe.test.ts.
//    Set LIBS_POLYFILLS=0 to run with no shims at all.
//
//    - window.matchMedia            Jest docs "Mocking methods which are not implemented in JSDOM";
//                                   needed by MUI useMediaQuery, framer-motion reduced-motion.
//    - ResizeObserver               Radix (use-size), floating-ui autoUpdate, react-aria, headlessui.
//    - Element#scrollIntoView       Radix Select / headless UI / downshift scroll the active option.
//    - Element#hasPointerCapture,
//      setPointerCapture,
//      releasePointerCapture        Radix Select (pointer-down on trigger).
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const applied: string[] = []
;(globalThis as any).__libsPolyfillsApplied = applied

if (process.env.LIBS_POLYFILLS !== '0') {
  if (typeof window.matchMedia !== 'function') {
    applied.push('matchMedia')
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    })
  }
  if (typeof (globalThis as any).ResizeObserver !== 'function') {
    applied.push('ResizeObserver')
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(globalThis as any).ResizeObserver = ResizeObserver
    ;(window as any).ResizeObserver = ResizeObserver
  }
  const EP = Element.prototype as any
  if (typeof EP.scrollIntoView !== 'function') {
    applied.push('scrollIntoView')
    EP.scrollIntoView = function () {}
  }
  if (typeof EP.hasPointerCapture !== 'function') {
    applied.push('hasPointerCapture')
    EP.hasPointerCapture = function () {
      return false
    }
  }
  if (typeof EP.setPointerCapture !== 'function') {
    applied.push('setPointerCapture')
    EP.setPointerCapture = function () {}
  }
  if (typeof EP.releasePointerCapture !== 'function') {
    applied.push('releasePointerCapture')
    EP.releasePointerCapture = function () {}
  }
}
