import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface ModalProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  description?: string
}

/**
 * Accessible modal dialog rendered into document.body via a portal.
 * - role="dialog" + aria-modal + aria-labelledby/aria-describedby
 * - moves focus into the dialog on open and restores it on close
 * - Escape closes, clicking the backdrop closes, Tab is trapped inside
 * - locks body scroll while open
 */
export function Modal({ open, title, onClose, children, description }: ModalProps) {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const dialog = dialogRef.current!
    const first = dialog.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? dialog).focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (focusables.length === 0) {
        event.preventDefault()
        return
      }
      const firstEl = focusables[0]
      const lastEl = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault()
        lastEl.focus()
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault()
        firstEl.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus?.()
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className="modal-backdrop"
      data-testid="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className="modal"
      >
        <header className="modal__header">
          <h2 id={titleId}>{title}</h2>
        </header>
        {description ? <p id={descriptionId}>{description}</p> : null}
        <div className="modal__body">{children}</div>
        <button type="button" className="modal__close" aria-label="Close dialog" onClick={onClose}>
          ×
        </button>
      </div>
    </div>,
    document.body,
  )
}

export interface DeleteAccountDialogProps {
  username: string
  onConfirm: (username: string) => void
}

/** A realistic consumer of <Modal>: a destructive "type to confirm" flow. */
export function DeleteAccountDialog({ username, onConfirm }: DeleteAccountDialogProps) {
  const [open, setOpen] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const inputId = useId()

  const close = () => {
    setOpen(false)
    setConfirmation('')
  }

  return (
    <>
      <button type="button" className="danger" onClick={() => setOpen(true)}>
        Delete account
      </button>
      <Modal
        open={open}
        onClose={close}
        title="Delete account?"
        description={`This permanently deletes ${username} and all of its data.`}
      >
        <label htmlFor={inputId}>Type DELETE to confirm</label>
        <input
          id={inputId}
          autoComplete="off"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
        />
        <div className="modal__actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            disabled={confirmation !== 'DELETE'}
            onClick={() => {
              onConfirm(username)
              close()
            }}
          >
            Delete forever
          </button>
        </div>
      </Modal>
    </>
  )
}
