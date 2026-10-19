import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Accordion, type AccordionItem } from '../components/Accordion'

const ITEMS: AccordionItem[] = [
  { id: 'shipping', title: 'Shipping', content: <p>We ship worldwide within 5 business days.</p> },
  { id: 'returns', title: 'Returns', content: <p>Free returns within 30 days.</p> },
  { id: 'warranty', title: 'Warranty', content: <p>Two years, parts and labour.</p> },
]

describe('<Accordion />', () => {
  it('renders a heading with a button for every item, all collapsed', () => {
    render(<Accordion items={ITEMS} />)

    const headings = screen.getAllByRole('heading', { level: 3 })
    expect(headings).toHaveLength(3)
    for (const name of ['Shipping', 'Returns', 'Warranty']) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveAttribute('aria-expanded', 'false')
    }
    expect(screen.queryAllByRole('region')).toHaveLength(0)
    expect(screen.getByText('Free returns within 30 days.')).not.toBeVisible()
  })

  it('expands a section and links button and region', () => {
    render(<Accordion items={ITEMS} />)
    const button = screen.getByRole('button', { name: 'Returns' })

    fireEvent.click(button)

    expect(button).toHaveAttribute('aria-expanded', 'true')
    const region = screen.getByRole('region', { name: 'Returns' })
    expect(button).toHaveAttribute('aria-controls', region.id)
    expect(region).toBeVisible()
    expect(region).toHaveTextContent('Free returns within 30 days.')
    expect(button.closest('.accordion__item')).toHaveClass('accordion__item--open')
  })

  it('collapses an open section when clicked again', () => {
    render(<Accordion items={ITEMS} defaultExpanded={['shipping']} />)
    expect(screen.getByRole('region', { name: 'Shipping' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Shipping' }))

    expect(screen.queryByRole('region', { name: 'Shipping' })).not.toBeInTheDocument()
    expect(screen.getByText(/ship worldwide/)).not.toBeVisible()
  })

  it('only keeps one section open by default', () => {
    render(<Accordion items={ITEMS} />)

    fireEvent.click(screen.getByRole('button', { name: 'Shipping' }))
    fireEvent.click(screen.getByRole('button', { name: 'Warranty' }))

    expect(screen.getAllByRole('region')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Shipping' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Warranty' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('allows multiple open sections when allowMultiple is set', () => {
    render(<Accordion items={ITEMS} allowMultiple />)

    for (const item of ITEMS) fireEvent.click(screen.getByRole('button', { name: item.title }))

    expect(screen.getAllByRole('region')).toHaveLength(3)
    ITEMS.forEach((item) => expect(screen.getByRole('button', { name: item.title })).toHaveAttribute('aria-expanded', 'true'))
  })

  it('respects the configured heading level and hides decorative icons', () => {
    const { container } = render(<Accordion items={ITEMS} headingLevel={4} />)

    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(3)
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull()
    const icons = container.querySelectorAll('[aria-hidden="true"]')
    expect(icons).toHaveLength(3)
    // aria-hidden content does not contribute to the accessible name
    expect(screen.getByRole('button', { name: 'Shipping' })).toHaveTextContent('Shipping+')
  })
})
