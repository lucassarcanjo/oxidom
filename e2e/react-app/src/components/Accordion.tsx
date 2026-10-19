import { useId, useState, type ReactNode } from 'react'

export interface AccordionItem {
  id: string
  title: string
  content: ReactNode
}

export interface AccordionProps {
  items: AccordionItem[]
  allowMultiple?: boolean
  defaultExpanded?: string[]
  headingLevel?: 2 | 3 | 4
}

export function Accordion({ items, allowMultiple = false, defaultExpanded = [], headingLevel = 3 }: AccordionProps) {
  const baseId = useId()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(defaultExpanded))
  const Heading = `h${headingLevel}` as const

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const isOpen = prev.has(id)
      const next = new Set(allowMultiple ? prev : [])
      if (isOpen) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="accordion">
      {items.map((item) => {
        const open = expanded.has(item.id)
        const buttonId = `${baseId}-button-${item.id}`
        const panelId = `${baseId}-panel-${item.id}`
        return (
          <div key={item.id} className={open ? 'accordion__item accordion__item--open' : 'accordion__item'}>
            <Heading className="accordion__heading">
              <button
                type="button"
                id={buttonId}
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => toggle(item.id)}
              >
                <span>{item.title}</span>
                <span aria-hidden="true" className="accordion__icon">
                  {open ? '−' : '+'}
                </span>
              </button>
            </Heading>
            <div
              id={panelId}
              role="region"
              aria-labelledby={buttonId}
              hidden={!open}
              className="accordion__panel"
            >
              {item.content}
            </div>
          </div>
        )
      })}
    </div>
  )
}
