import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export interface TabItem {
  id: string
  label: string
  content: ReactNode
  disabled?: boolean
}

export interface TabsProps {
  label: string
  tabs: TabItem[]
  defaultTabId?: string
  onChange?: (tabId: string) => void
}

/**
 * WAI-ARIA tabs with automatic activation and a roving tabindex.
 * https://www.w3.org/WAI/ARIA/apg/patterns/tabs/
 */
export function Tabs({ label, tabs, defaultTabId, onChange }: TabsProps) {
  const baseId = useId()
  const [activeId, setActiveId] = useState(
    defaultTabId ?? tabs.find((t) => !t.disabled)?.id ?? tabs[0]?.id,
  )
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())

  const enabled = tabs.filter((t) => !t.disabled)

  const activate = (id: string, focus = false) => {
    setActiveId(id)
    onChange?.(id)
    if (focus) tabRefs.current.get(id)?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = enabled.findIndex((t) => t.id === activeId)
    let next: TabItem | undefined
    switch (event.key) {
      case 'ArrowRight':
        next = enabled[(index + 1) % enabled.length]
        break
      case 'ArrowLeft':
        next = enabled[(index - 1 + enabled.length) % enabled.length]
        break
      case 'Home':
        next = enabled[0]
        break
      case 'End':
        next = enabled[enabled.length - 1]
        break
      default:
        return
    }
    event.preventDefault()
    if (next) activate(next.id, true)
  }

  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} onKeyDown={handleKeyDown}>
        {tabs.map((tab) => {
          const selected = tab.id === activeId
          return (
            <button
              key={tab.id}
              ref={(el) => {
                if (el) tabRefs.current.set(tab.id, el)
                else tabRefs.current.delete(tab.id)
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.id}`}
              aria-disabled={tab.disabled || undefined}
              tabIndex={selected ? 0 : -1}
              className={selected ? 'tab tab--active' : 'tab'}
              onClick={() => {
                if (!tab.disabled) activate(tab.id)
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      {tabs.map((tab) => {
        const selected = tab.id === activeId
        return (
          <div
            key={tab.id}
            role="tabpanel"
            id={`${baseId}-panel-${tab.id}`}
            aria-labelledby={`${baseId}-tab-${tab.id}`}
            hidden={!selected}
            tabIndex={0}
            className="tabs__panel"
          >
            {selected ? tab.content : null}
          </div>
        )
      })}
    </div>
  )
}
