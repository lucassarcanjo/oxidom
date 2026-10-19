// Root-cause FACTS behind the failures in tests/. One assertion-free probe per fact; every
// value is recorded to results/raw/diag-facts-<env>.json (this test always passes).
import fs from 'node:fs'
import path from 'node:path'

const facts: Record<string, unknown> = {}
const tryFact = (name: string, fn: () => unknown) => {
  try { facts[name] = fn() } catch (e: any) { facts[name] = `throws ${e?.name}: ${String(e?.message).slice(0, 120)}` }
}

test('root-cause facts', async () => {
  const g = globalThis as any
  tryFact('typeof NodeFilter', () => typeof g.NodeFilter)
  tryFact('typeof document.createTreeWalker', () => typeof document.createTreeWalker)
  tryFact('typeof ShadowRoot', () => typeof g.ShadowRoot)
  tryFact('typeof Element.prototype.attachShadow', () => typeof (Element.prototype as any).attachShadow)
  tryFact('typeof customElements', () => typeof g.customElements)
  tryFact('typeof XMLHttpRequest', () => typeof g.XMLHttpRequest)
  tryFact('typeof document.elementFromPoint', () => typeof (document as any).elementFromPoint)
  tryFact('typeof Range.prototype.getClientRects', () => typeof g.Range?.prototype?.getClientRects)
  tryFact('typeof Range.prototype.getBoundingClientRect', () => typeof g.Range?.prototype?.getBoundingClientRect)
  tryFact("'getTargetRanges' in new InputEvent('input')", () => 'getTargetRanges' in new g.InputEvent('input'))
  tryFact('document instanceof window.Document', () => document instanceof (window as any).Document)
  tryFact('document.defaultView.Document === globalThis.Document', () => (document.defaultView as any).Document === g.Document)
  tryFact('selection after collapse(text,1): rangeCount', () => {
    const p = document.createElement('p'); p.textContent = 'abc'; document.body.appendChild(p)
    const s = window.getSelection()!; s.removeAllRanges(); s.collapse(p.firstChild!, 1)
    const out = { anchorIsText: s.anchorNode === p.firstChild, rangeCount: s.rangeCount, getRangeAt0: (() => { try { const r = s.getRangeAt(0); return `${r.startOffset}` } catch (e: any) { return `throws ${e.name}` } })() }
    p.remove(); return out
  })
  tryFact('selection after setBaseAndExtent: rangeCount', () => {
    const p = document.createElement('p'); p.textContent = 'abc'; document.body.appendChild(p)
    const s = window.getSelection()!; s.removeAllRanges(); s.setBaseAndExtent(p.firstChild!, 0, p.firstChild!, 2)
    const out = { rangeCount: s.rangeCount, text: String(s) }
    p.remove(); return out
  })
  // History traversal: pushState then back() must fire popstate and restore the URL.
  facts['history.back() fires popstate'] = await new Promise((resolve) => {
    window.history.replaceState(null, '', '/a')
    window.history.pushState({ n: 1 }, '', '/b')
    let fired = false
    const on = () => { fired = true }
    window.addEventListener('popstate', on)
    window.history.back()
    setTimeout(() => { window.removeEventListener('popstate', on); resolve({ fired, pathname: location.pathname }) }, 100)
  })
  tryFact('dispatching ErrorEvent for listener exceptions', () => 'see tests/ unhandled errors')
  const env = process.env.DOM_ENV ?? 'jsdom'
  const dir = path.resolve(process.cwd(), 'results/raw')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `diag-facts-${env}.json`), JSON.stringify({ env, facts }, null, 2))
})
