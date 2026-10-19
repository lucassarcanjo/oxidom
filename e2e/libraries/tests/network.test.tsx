// axios (XHR adapter against a real local HTTP server) and msw (fetch/XHR interception)
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import axios from 'axios'
import { http as mswHttp, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'

let srv: http.Server
let base = ''
beforeAll(async () => {
  srv = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null }))
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => srv.close(() => r())))

describe('axios', () => {
  test('GET + POST JSON against a local server (default adapter)', async () => {
    const api = axios.create({ baseURL: base })
    const g = await api.get('/items', { params: { q: 'x' } })
    expect(g.status).toBe(200)
    expect(g.data).toEqual({ method: 'GET', url: '/items?q=x', body: null })
    const p = await api.post('/items', { name: 'pen' })
    expect(p.data.body).toEqual({ name: 'pen' })
  })

  test('uses the XMLHttpRequest adapter, as in a browser', async () => {
    const api = axios.create({ baseURL: base, adapter: 'xhr' })
    const g = await api.get('/xhr')
    expect(g.data.url).toBe('/xhr')
  })
})

describe('msw', () => {
  const server = setupServer(
    mswHttp.get('http://localhost:3000/api/user', () => HttpResponse.json({ name: 'Ada' })),
    mswHttp.post('http://localhost:3000/api/todos', async ({ request }) => HttpResponse.json({ id: 1, ...(await request.json() as object) }, { status: 201 })),
  )
  beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  function Profile() {
    const [name, setName] = useState<string | null>(null)
    const [err, setErr] = useState<string | null>(null)
    return (
      <>
        <button onClick={async () => {
          const r = await fetch('/api/user')
          if (!r.ok) { setErr(`HTTP ${r.status}`); return }
          setName((await r.json()).name)
        }}>Load</button>
        {name && <p>Hello {name}</p>}
        {err && <p role="alert">{err}</p>}
      </>
    )
  }

  test('fetch with a relative URL is intercepted (component test)', async () => {
    const user = userEvent.setup()
    render(<Profile />)
    await user.click(screen.getByRole('button', { name: 'Load' }))
    expect(await screen.findByText('Hello Ada')).toBeInTheDocument()
  })

  test('per-test handler override returns an error', async () => {
    server.use(mswHttp.get('http://localhost:3000/api/user', () => new HttpResponse(null, { status: 500 })))
    const user = userEvent.setup()
    render(<Profile />)
    await user.click(screen.getByRole('button', { name: 'Load' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500')
  })

  test('axios request is intercepted by msw', async () => {
    const r = await axios.post('http://localhost:3000/api/todos', { title: 'Write tests' })
    expect(r.status).toBe(201)
    expect(r.data).toEqual({ id: 1, title: 'Write tests' })
  })
})
