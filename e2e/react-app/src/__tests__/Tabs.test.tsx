import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Tabs, type TabItem } from '../components/Tabs'

const TABS: TabItem[] = [
  { id: 'profile', label: 'Profile', content: <p>Profile settings</p> },
  { id: 'security', label: 'Security', content: <p>Two-factor authentication</p> },
  { id: 'billing', label: 'Billing', content: <p>Invoices</p>, disabled: true },
  { id: 'notifications', label: 'Notifications', content: <p>Email preferences</p> },
]

function renderTabs(props: Partial<Parameters<typeof Tabs>[0]> = {}) {
  return render(<Tabs label="Account settings" tabs={TABS} {...props} />)
}

describe('<Tabs />', () => {
  it('exposes a tablist with tabs and a single visible tabpanel', () => {
    renderTabs()

    const tablist = screen.getByRole('tablist', { name: 'Account settings' })
    const tabs = within(tablist).getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Profile', 'Security', 'Billing', 'Notifications'])

    // Hidden panels are excluded from the accessibility tree by default.
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(4)
    expect(screen.getByRole('tabpanel', { name: 'Profile' })).toHaveTextContent('Profile settings')
  })

  it('wires aria-selected, aria-controls and aria-labelledby', () => {
    renderTabs()
    const profile = screen.getByRole('tab', { name: 'Profile' })
    const security = screen.getByRole('tab', { name: 'Security' })

    expect(profile).toHaveAttribute('aria-selected', 'true')
    expect(security).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { selected: true })).toBe(profile)

    const panel = screen.getByRole('tabpanel')
    expect(profile.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel).toHaveAttribute('aria-labelledby', profile.id)
  })

  it('uses a roving tabindex', () => {
    renderTabs({ defaultTabId: 'security' })

    expect(screen.getByRole('tab', { name: 'Security' })).toHaveAttribute('tabindex', '0')
    for (const name of ['Profile', 'Billing', 'Notifications']) {
      expect(screen.getByRole('tab', { name })).toHaveAttribute('tabindex', '-1')
    }
  })

  it('switches panels on click and notifies onChange', () => {
    const onChange = vi.fn()
    renderTabs({ onChange })

    fireEvent.click(screen.getByRole('tab', { name: 'Security' }))

    expect(onChange).toHaveBeenCalledWith('security')
    expect(screen.getByRole('tab', { name: 'Security' })).toHaveClass('tab--active')
    expect(screen.getByRole('tabpanel', { name: 'Security' })).toHaveTextContent('Two-factor authentication')
    expect(screen.queryByText('Profile settings')).not.toBeInTheDocument()
  })

  it('hides inactive panels from view', () => {
    renderTabs()
    const panels = screen.getAllByRole('tabpanel', { hidden: true })

    expect(panels[0]).toBeVisible()
    expect(panels[1]).not.toBeVisible()
    expect(panels[1]).toHaveAttribute('hidden')

    fireEvent.click(screen.getByRole('tab', { name: 'Notifications' }))
    expect(panels[0]).not.toBeVisible()
    expect(panels[3]).toBeVisible()
  })

  it('ignores clicks on disabled tabs', () => {
    const onChange = vi.fn()
    renderTabs({ onChange })

    const billing = screen.getByRole('tab', { name: 'Billing' })
    expect(billing).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(billing)

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('Profile')
  })

  it('moves focus and selection with arrow keys, skipping disabled tabs', () => {
    renderTabs()
    const tablist = screen.getByRole('tablist')
    screen.getByRole('tab', { name: 'Profile' }).focus()

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Security' })).toHaveFocus()

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Notifications' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Notifications' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(tablist, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Profile' })).toHaveFocus()

    fireEvent.keyDown(tablist, { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'Notifications' })).toHaveFocus()
  })

  it('supports Home and End keys', () => {
    renderTabs({ defaultTabId: 'security' })
    const tablist = screen.getByRole('tablist')

    fireEvent.keyDown(tablist, { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Notifications' })).toHaveFocus()

    fireEvent.keyDown(tablist, { key: 'Home' })
    expect(screen.getByRole('tab', { name: 'Profile' })).toHaveFocus()
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Profile settings')

    // Unrelated keys are ignored
    fireEvent.keyDown(tablist, { key: 'a' })
    expect(screen.getByRole('tab', { name: 'Profile' })).toHaveFocus()
  })
})
