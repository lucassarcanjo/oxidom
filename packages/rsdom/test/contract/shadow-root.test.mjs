// ShadowRoot and Element.attachShadow, without retargeting (ROADMAP Stage 1, DESIGN §22). The upstream coverage is
// conformance/parity (`--item shadow-root`: WPT shadow-dom interface, ownership and encapsulation files); these
// cases add what libraries do with a shadow tree (MUI's `instanceof ShadowRoot`, focus traps reading
// `activeElement` and `getRootNode()`, events from inside a shadow tree reaching document listeners) and the
// tree paths that run inside rsdom natives (connectivity, the id map, adoption, cloning, innerHTML). Every
// assertion runs on jsdom, happy-dom and rsdom; jsdom wins disagreements. Event retargeting (DESIGN §42) is
// asserted like jsdom's; happy-dom 21 does not retarget.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

describe.each(DOMS)('shadow root [%s]', (kind) => {
  let w;
  let d;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });
  const host = (tag = 'div') => d.body.appendChild(d.createElement(tag));

  it('interface objects and attachShadow validation', () => {
    // PINNED to jsdom: happy-dom 21 has a per-window DocumentFragment subclass between them
    if (kind !== 'happy-dom') expect(Object.getPrototypeOf(w.ShadowRoot.prototype)).toBe(w.DocumentFragment.prototype);
    expect(errName(() => new w.ShadowRoot())).toBe('TypeError');
    expect('attachShadow' in w.Element.prototype).toBe(true);
    expect('attachShadow' in w.Node.prototype).toBe(false);
    const s = host().attachShadow({ mode: 'open' });
    expect(s).toBeInstanceOf(w.ShadowRoot);
    if (kind !== 'happy-dom') expect(s instanceof w.DocumentFragment).toBe(true); // PINNED to jsdom: see above
    expect(Object.prototype.toString.call(s)).toBe('[object ShadowRoot]');
    expect(s.nodeType).toBe(11);
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom 21's ShadowRoot has nodeName '' and lax validation
    expect(s.nodeName).toBe('#document-fragment');
    expect(errName(() => d.createElement('div').attachShadow())).toBe('TypeError');
    expect(errName(() => d.createElement('div').attachShadow({}))).toBe('TypeError');
    expect(errName(() => d.createElement('div').attachShadow({ mode: 'OPEN' }))).toBe('TypeError');
    expect(errName(() => d.createElement('input').attachShadow({ mode: 'open' }))).toBe('NotSupportedError');
    expect(errName(() => d.createElementNS('http://www.w3.org/2000/svg', 'div').attachShadow({ mode: 'open' }))).toBe('NotSupportedError');
    expect(errName(() => d.createElement('font-face').attachShadow({ mode: 'open' }))).toBe('NotSupportedError');
    expect(errName(() => d.createElement('x-widget').attachShadow({ mode: 'closed' }))).toBe('ok');
    for (const tag of ['article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span']) {
      expect(errName(() => d.createElement(tag).attachShadow({ mode: 'open' }))).toBe('ok');
    }
    const el = d.createElement('div');
    el.attachShadow({ mode: 'closed' });
    expect(errName(() => el.attachShadow({ mode: 'open' }))).toBe('NotSupportedError');
  });

  it('mode, host and shadowRoot', () => {
    const open = host();
    const so = open.attachShadow({ mode: 'open' });
    expect(so.mode).toBe('open');
    expect(so.host).toBe(open);
    expect(open.shadowRoot).toBe(so);
    expect(open.shadowRoot).toBe(open.shadowRoot);
    const closed = host();
    const sc = closed.attachShadow({ mode: 'closed' });
    expect(sc.mode).toBe('closed');
    expect(sc.host).toBe(closed);
    expect(closed.shadowRoot).toBe(null);
    expect(d.createElement('div').shadowRoot).toBe(null);
    expect(so.parentNode).toBe(null);
    expect(so.parentElement).toBe(null);
    expect(so.ownerDocument).toBe(d);
  });

  it('library checks: instanceof ShadowRoot and getRootNode()', () => {
    // @mui/utils contains(): `parent.getRootNode() instanceof ShadowRoot` (every MUI Modal and Dialog)
    const h = host();
    const s = h.attachShadow({ mode: 'open' });
    const inner = s.appendChild(d.createElement('button'));
    expect(inner.getRootNode()).toBe(s);
    expect(inner.getRootNode() instanceof w.ShadowRoot).toBe(true);
    expect(d.body.getRootNode() instanceof w.ShadowRoot).toBe(false);
    expect(inner.getRootNode({ composed: true })).toBe(d);
    expect(inner.getRootNode({ composed: false })).toBe(s);
    expect(s.getRootNode()).toBe(s);
    expect(s.getRootNode({ composed: true })).toBe(d);
    const detached = d.createElement('div');
    const ds = detached.attachShadow({ mode: 'open' });
    const t = ds.appendChild(d.createTextNode('x'));
    if (kind !== 'happy-dom') expect(t.getRootNode({ composed: true })).toBe(detached); // PINNED to jsdom: happy-dom 21 returns the shadow root
    expect(h.contains(inner)).toBe(false);
    expect(s.contains(inner)).toBe(true);
    expect(d.contains(inner)).toBe(false);
  });

  it('a shadow tree is connected with its host', () => {
    const h = d.createElement('div');
    const s = h.attachShadow({ mode: 'open' });
    const inner = s.appendChild(d.createElement('span'));
    const nested = inner.attachShadow({ mode: 'open' }).appendChild(d.createElement('b'));
    expect([s.isConnected, inner.isConnected, nested.isConnected]).toEqual([false, false, false]);
    d.body.appendChild(h);
    expect([s.isConnected, inner.isConnected, nested.isConnected]).toEqual([true, true, true]);
    const late = s.appendChild(d.createElement('i'));
    expect(late.isConnected).toBe(true);
    h.remove();
    expect([s.isConnected, inner.isConnected, nested.isConnected, late.isConnected]).toEqual([false, false, false, false]);
  });

  it('getElementById and selectors stay inside their tree', () => {
    const h = host();
    const s = h.attachShadow({ mode: 'open' });
    s.innerHTML = '<div id="a" class="c"><span id="b"></span></div>';
    const a = s.firstChild;
    const doc = d.body.appendChild(d.createElement('p'));
    doc.id = 'b';
    expect(d.getElementById('a')).toBe(null);
    expect(d.querySelector('#a')).toBe(null);
    expect(d.querySelectorAll('.c').length).toBe(0);
    expect(d.getElementById('b')).toBe(doc);
    expect(s.getElementById('a')).toBe(a);
    expect(s.getElementById('b')).toBe(a.firstChild);
    expect(s.querySelector('#b')).toBe(a.firstChild);
    expect(s.querySelectorAll('.c').length).toBe(1);
    // an id set (or changed) while connected inside the shadow tree
    a.id = 'z';
    expect(s.getElementById('z')).toBe(a);
    expect(d.getElementById('z')).toBe(null);
    a.id = 'b';
    expect(d.getElementById('b')).toBe(doc);
    expect(s.getElementById('b')).toBe(a);
    // and after the host leaves the document
    h.remove();
    expect(s.getElementById('b')).toBe(a);
    a.remove();
    expect(s.getElementById('b')).toBe(null);
    expect(d.getElementById('b')).toBe(doc);
    // named properties do not see shadow trees
    const s2 = host().attachShadow({ mode: 'open' });
    s2.appendChild(d.createElement('div')).id = 'shadowOnly';
    expect('shadowOnly' in w).toBe(false);
  });

  it('innerHTML, textContent and serialization of the host', () => {
    const h = host();
    h.innerHTML = '<em>light</em>';
    const s = h.attachShadow({ mode: 'open' });
    expect(s.innerHTML).toBe('');
    s.innerHTML = 'hello<span>world</span>';
    expect(s.childNodes.length).toBe(2);
    expect(s.firstChild.data).toBe('hello');
    expect(s.lastChild).toBeInstanceOf(w.HTMLSpanElement);
    expect(s.innerHTML).toBe('hello<span>world</span>');
    expect(s.textContent).toBe('helloworld');
    expect(h.innerHTML).toBe('<em>light</em>');
    expect(h.textContent).toBe('light');
    expect(h.outerHTML).toBe('<div><em>light</em></div>');
    s.innerHTML = '';
    expect(s.childNodes.length).toBe(0);
  });

  it('cloning, importing and adopting', () => {
    const h = host();
    const s = h.attachShadow({ mode: 'open' });
    s.appendChild(d.createElement('span'));
    const other = d.implementation.createHTMLDocument('');
    if (kind !== 'happy-dom') { // PINNED to jsdom: happy-dom 21 clones, imports and adopts shadow roots
      expect(errName(() => s.cloneNode())).toBe('NotSupportedError');
      expect(errName(() => s.cloneNode(true))).toBe('NotSupportedError');
      expect(errName(() => other.importNode(s, true))).toBe('NotSupportedError');
      expect(errName(() => other.adoptNode(s))).toBe('HierarchyRequestError');
    }
    const c = h.cloneNode(true);
    expect(c.shadowRoot).toBe(null);
    expect(errName(() => c.attachShadow({ mode: 'open' }))).toBe('ok');
    other.adoptNode(h);
    expect(h.ownerDocument).toBe(other);
    if (kind !== 'happy-dom') { // PINNED to jsdom: happy-dom 21 leaves the shadow tree in the old document
      expect(s.ownerDocument).toBe(other);
      expect(s.firstChild.ownerDocument).toBe(other);
    }
    expect(s.isConnected).toBe(false);
  });

  it('a host cannot go into its own shadow tree', () => {
    const h = host();
    const s = h.attachShadow({ mode: 'open' });
    const inner = s.appendChild(d.createElement('div'));
    if (kind !== 'happy-dom') { // PINNED to jsdom: happy-dom 21 recurses until a RangeError
      expect(errName(() => s.appendChild(h))).toBe('HierarchyRequestError');
      expect(errName(() => inner.appendChild(h))).toBe('HierarchyRequestError');
      expect(errName(() => inner.appendChild(d.body))).toBe('HierarchyRequestError');
    }
    // appending a shadow root moves its children, as for any DocumentFragment
    const s2 = d.createElement('div').attachShadow({ mode: 'open' });
    s2.appendChild(d.createElement('b'));
    inner.appendChild(s2);
    expect(s2.childNodes.length).toBe(0);
    expect(inner.firstChild.localName).toBe('b');
  });

  it('focus inside a shadow tree: activeElement is retargeted to the host', () => {
    const h = host();
    const s = h.attachShadow({ mode: 'open' });
    const input = s.appendChild(d.createElement('input'));
    expect(s.activeElement).toBe(null);
    input.focus();
    expect(d.activeElement).toBe(h);
    expect(s.activeElement).toBe(input);
    const nestedHost = s.appendChild(d.createElement('div'));
    const ns = nestedHost.attachShadow({ mode: 'closed' });
    const deep = ns.appendChild(d.createElement('button'));
    deep.focus();
    expect(d.activeElement).toBe(h);
    expect(s.activeElement).toBe(nestedHost);
    expect(ns.activeElement).toBe(deep);
    h.remove();
    expect(d.activeElement).toBe(d.body);
    expect(s.activeElement).toBe(null);
  });

  it('events: composed events cross the host, others stop at the shadow root', () => {
    const h = host();
    const s = h.attachShadow({ mode: 'open' });
    const inner = s.appendChild(d.createElement('button'));
    const log = [];
    for (const [name, t] of [['inner', inner], ['root', s], ['host', h], ['doc', d], ['win', w]]) {
      t.addEventListener('ping', (e) => log.push(`${name}:${e.eventPhase}`));
      t.addEventListener('ping', () => log.push(`${name}:capture`), true);
    }
    inner.dispatchEvent(new w.Event('ping', { bubbles: true }));
    expect(log).toEqual(['root:capture', 'inner:capture', 'inner:2', 'root:3']);
    log.length = 0;
    inner.dispatchEvent(new w.Event('ping', { bubbles: true, composed: true }));
    expect(log.filter((x) => x.endsWith('capture'))).toEqual(['win:capture', 'doc:capture', 'host:capture', 'root:capture', 'inner:capture']);
    expect(log.filter((x) => !x.endsWith('capture'))).toEqual(['inner:2', 'root:3', 'host:2', 'doc:3', 'win:3'].map((x) => {
      // jsdom: at the host the retargeted target is the host itself, so its listeners run AT_TARGET (2)
      if (kind === 'happy-dom' && x === 'host:2') return 'host:3'; // happy-dom 21 does not retarget
      return x;
    }));
    // a click from inside a shadow tree reaches document listeners (React's root listener, user-event)
    let target = null;
    d.addEventListener('click', (e) => { target = e.target; });
    inner.click();
    // happy-dom 21 does not retarget
    if (kind === 'happy-dom') expect(target).toBe(inner);
    else expect(target).toBe(h);
    let path = null;
    inner.addEventListener('pong', (e) => { path = e.composedPath(); });
    inner.dispatchEvent(new w.Event('pong', { composed: true }));
    expect(path).toEqual([inner, s, h, d.body, d.documentElement, d, w]);
  });

  it('events: relatedTarget is retargeted and the targets are cleared after dispatch', () => {
    const h = host();
    const s = h.attachShadow({ mode: 'closed' });
    const a = s.appendChild(d.createElement('button'));
    const b = s.appendChild(d.createElement('button'));
    const outside = d.body.appendChild(d.createElement('button'));
    const seen = [];
    for (const [name, t] of [['b', b], ['host', h], ['doc', d]]) {
      t.addEventListener('focusin', (e) => seen.push(`${name}:${e.target === b ? 'b' : e.target === h ? 'host' : '?'}:${e.relatedTarget === a ? 'a' : e.relatedTarget === h ? 'host' : e.relatedTarget === outside ? 'outside' : String(e.relatedTarget)}`));
    }
    const ev = new w.FocusEvent('focusin', { bubbles: true, composed: true, relatedTarget: a });
    b.dispatchEvent(ev);
    if (kind === 'happy-dom') return; // happy-dom 21 does not retarget
    // inside the tree both are visible; outside, the target and the related target are both the host, so the
    // event stops at the shadow root (DOM "dispatch": a parent equal to the retargeted relatedTarget ends the path)
    expect(seen).toEqual(['b:b:a']);
    expect(ev.target).toBe(null);
    expect(ev.relatedTarget).toBe(null);
    seen.length = 0;
    const ev2 = new w.FocusEvent('focusin', { bubbles: true, composed: true, relatedTarget: outside });
    b.dispatchEvent(ev2);
    expect(seen).toEqual(['b:b:outside', 'host:host:outside', 'doc:host:outside']);
    expect(ev2.target).toBe(h); // the last shadow-adjusted target is the host, outside the shadow tree: kept
    let path = null;
    d.addEventListener('pong', (e) => { path = e.composedPath(); });
    b.dispatchEvent(new w.Event('pong', { bubbles: true, composed: true }));
    expect(path).toEqual([h, d.body, d.documentElement, d, w]);
  });

  it('MutationObserver on the host does not see the shadow tree', async () => {
    const h = host();
    const s = h.attachShadow({ mode: 'open' });
    const hostRecs = [];
    const rootRecs = [];
    new w.MutationObserver((r) => hostRecs.push(...r)).observe(h, { childList: true, subtree: true });
    new w.MutationObserver((r) => rootRecs.push(...r)).observe(s, { childList: true, subtree: true });
    s.appendChild(d.createElement('span'));
    await new Promise((r) => setTimeout(r, 0));
    expect(hostRecs.length).toBe(0);
    expect(rootRecs.length).toBe(1);
    expect(rootRecs[0].target).toBe(s);
  });
});
