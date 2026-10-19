// framer-motion: motion components + AnimatePresence exit (rAF / WAAPI / matchMedia)
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'

function Toast() {
  const [show, setShow] = useState(false)
  return (
    <>
      <button onClick={() => setShow((s) => !s)}>Toggle</button>
      <AnimatePresence>
        {show && (
          <motion.div key="toast" role="status" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.05 }}>
            Saved!
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

describe('framer-motion', () => {
  test('AnimatePresence mounts and removes after exit animation', async () => {
    const user = userEvent.setup()
    render(<Toast />)
    await user.click(screen.getByRole('button', { name: 'Toggle' }))
    expect(screen.getByRole('status')).toHaveTextContent('Saved!')
    await user.click(screen.getByRole('button', { name: 'Toggle' }))
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument(), { timeout: 3000 })
  })

  test('animates to target styles and fires onAnimationComplete', async () => {
    const onComplete = vi.fn()
    render(<motion.div data-testid="box" initial={{ opacity: 0 }} animate={{ opacity: 0.5 }} transition={{ duration: 0.05 }} onAnimationComplete={onComplete} />)
    await waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 3000 })
    expect(screen.getByTestId('box').style.opacity).toBe('0.5')
  })
})
