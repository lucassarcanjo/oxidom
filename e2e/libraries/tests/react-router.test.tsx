// react-router v8: data router in memory (loader + Link), and BrowserRouter (History API)
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  createMemoryRouter, RouterProvider, Link, useLoaderData, BrowserRouter, Routes, Route, useNavigate, Outlet,
} from 'react-router'

function Layout() {
  return (
    <>
      <nav><Link to="/">Home</Link> <Link to="/users/7">User 7</Link></nav>
      <Outlet />
    </>
  )
}
function UserPage() {
  const user = useLoaderData() as { name: string }
  return <h1>{user.name}</h1>
}

describe('react-router', () => {
  test('memory data router: loader + Link navigation', async () => {
    const user = userEvent.setup()
    const router = createMemoryRouter(
      [{ path: '/', Component: Layout, children: [
        { index: true, element: <h1>Welcome</h1> },
        { path: 'users/:id', loader: async ({ params }) => ({ name: `User #${params.id}` }), Component: UserPage },
      ] }],
      { initialEntries: ['/'] },
    )
    render(<RouterProvider router={router} />)
    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'User 7' }))
    expect(await screen.findByRole('heading', { name: 'User #7' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/users/7')
  })

  test('BrowserRouter: pushState navigation, back and forward buttons', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/')
    function Home() {
      const navigate = useNavigate()
      return <button onClick={() => navigate('/settings?tab=2')}>Open settings</button>
    }
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/settings" element={<h1>Settings</h1>} />
        </Routes>
      </BrowserRouter>,
    )
    await user.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/settings')
    expect(window.location.search).toBe('?tab=2')
    window.history.back()
    expect(await screen.findByRole('button', { name: 'Open settings' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
    window.history.forward()
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(window.location.search).toBe('?tab=2')
  })
})
