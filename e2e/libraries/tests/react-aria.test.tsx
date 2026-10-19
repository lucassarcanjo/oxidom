// react-aria-components: Modal/Dialog (FocusScope -> TreeWalker), ComboBox, Tabs
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  Button, Dialog, DialogTrigger, Heading, Modal, TextField, Label, Input,
  ComboBox, ListBox, ListBoxItem, Popover,
  Tabs, TabList, Tab, TabPanel,
} from 'react-aria-components'

describe('react-aria-components', () => {
  test('modal dialog contains focus and closes on Escape', async () => {
    const user = userEvent.setup()
    render(
      <DialogTrigger>
        <Button>Sign up</Button>
        <Modal>
          <Dialog>
            <Heading slot="title">Sign up</Heading>
            <TextField autoFocus><Label>Email</Label><Input /></TextField>
            <TextField><Label>Password</Label><Input type="password" /></TextField>
            <Button slot="close">Submit</Button>
          </Dialog>
        </Modal>
      </DialogTrigger>,
    )
    await user.click(screen.getByRole('button', { name: 'Sign up' }))
    const dialog = await screen.findByRole('dialog', { name: 'Sign up' })
    expect(within(dialog).getByLabelText('Email')).toHaveFocus()
    await user.tab()
    expect(within(dialog).getByLabelText('Password')).toHaveFocus()
    await user.tab()
    expect(within(dialog).getByRole('button', { name: 'Submit' })).toHaveFocus()
    await user.tab() // FocusScope wraps (uses a TreeWalker over tabbable nodes)
    expect(within(dialog).getByLabelText('Email')).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  test('ComboBox filters and selects', async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    render(
      <ComboBox onSelectionChange={onSelectionChange}>
        <Label>Animal</Label>
        <Input />
        <Button>v</Button>
        <Popover>
          <ListBox>
            <ListBoxItem id="aardvark">Aardvark</ListBoxItem>
            <ListBoxItem id="cat">Cat</ListBoxItem>
            <ListBoxItem id="dog">Dog</ListBoxItem>
          </ListBox>
        </Popover>
      </ComboBox>,
    )
    await user.type(screen.getByRole('combobox', { name: 'Animal' }), 'ca')
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getAllByRole('option')).toHaveLength(1)
    await user.click(within(listbox).getByRole('option', { name: 'Cat' }))
    expect(onSelectionChange).toHaveBeenCalledWith('cat')
    expect(screen.getByRole('combobox')).toHaveValue('Cat')
  })

  test('Tabs switch with arrow keys', async () => {
    const user = userEvent.setup()
    render(
      <Tabs>
        <TabList aria-label="History">
          <Tab id="founding">Founding</Tab>
          <Tab id="moon">Moon landing</Tab>
        </TabList>
        <TabPanel id="founding">Founded in 1776</TabPanel>
        <TabPanel id="moon">Landed in 1969</TabPanel>
      </Tabs>,
    )
    await user.click(screen.getByRole('tab', { name: 'Founding' }))
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Moon landing' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Landed in 1969')
  })
})
