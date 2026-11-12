// Iframes (ROADMAP Stage 4 `browsing-contexts` part 2, DESIGN §46): child browsing contexts, the window's frame
// accessors and named properties, and frame load events, side by side with jsdom.
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const APIS = { jsdom: require('jsdom'), oxidom: require('../../lib/index.cjs') };

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe.each(Object.keys(APIS))('iframes [%s]', (kind) => {
  const { JSDOM, VirtualConsole } = APIS[kind];
  const make = (html, options = {}) => new JSDOM(html, { virtualConsole: new VirtualConsole(), url: 'http://example.com/', ...options });

  it('gives connected frames a window and a document', () => {
    const { window } = make('<iframe name=a></iframe><iframe id=b src="http://example.invalid/x"></iframe>');
    const [a, b] = window.document.querySelectorAll('iframe');
    expect(a.contentDocument.documentElement.outerHTML).toBe('<html><head></head><body></body></html>');
    expect([a.contentDocument.URL, a.contentDocument.readyState]).toEqual(['about:blank', 'complete']);
    expect(a.contentWindow.document).toBe(a.contentDocument);
    expect([a.contentWindow.parent, a.contentWindow.top, a.contentWindow.frameElement, window.frameElement]).toEqual([window, window, a, null]);
    // another URL is fetched only with `resources: "usable"`: the document stays empty and loading
    expect([b.contentDocument.URL, b.contentDocument.readyState, b.contentDocument.childNodes.length]).toEqual(['http://example.invalid/x', 'loading', 0]);
    const detached = window.document.createElement('iframe');
    expect([detached.contentWindow, detached.contentDocument]).toEqual([null, null]);
    const noWindow = window.document.implementation.createHTMLDocument('');
    expect(noWindow.body.appendChild(noWindow.createElement('iframe')).contentWindow).toBe(null);
  });

  it('lists frame windows on the parent window, by index and by name', () => {
    const { window } = make('<iframe name=a></iframe><div id=x></div><form name=f></form><img name=f>');
    const { document } = window;
    const a = document.querySelector('iframe');
    expect([window.length, window[0] === a.contentWindow, window.a === a.contentWindow, document.a === a.contentWindow]).toEqual([1, true, true, true]);
    expect(window.x).toBe(document.getElementById('x'));
    expect([String(window.f), window.f.length]).toEqual(['[object HTMLCollection]', 2]);
    expect([window.nothing, window.document === document]).toEqual([undefined, true]);
    const b = document.body.appendChild(document.createElement('iframe'));
    expect([window.length, window[1] === b.contentWindow]).toEqual([2, true]);
    const old = a.contentWindow;
    a.remove();
    expect([window.length, window[0] === b.contentWindow, window[1], a.contentWindow === old, window.a]).toEqual([1, true, undefined, true, undefined]);
    document.body.appendChild(a);
    expect([window.length, a.contentWindow === old]).toEqual([2, false]);
    window.x = 1;
    expect(window.x).toBe(1);
  });

  it('fires load on a frame: at once when attached without listeners, else after its document loads', async () => {
    const { window } = make('<iframe></iframe>');
    const { document } = window;
    const events = [];
    const parsed = document.querySelector('iframe').contentWindow;
    parsed.addEventListener('load', () => events.push('parsed window load'));
    const f = document.createElement('iframe');
    f.onload = () => events.push('f load');
    document.body.appendChild(f);
    events.push(`f appended ${f.contentDocument.readyState}`);
    const g = document.body.appendChild(document.createElement('iframe'));
    g.addEventListener('load', () => events.push('g load'));
    g.src = 'about:blank';
    events.push(`g src ${g.contentDocument.readyState}`);
    const h = document.createElement('iframe');
    let sync = false;
    document.body.appendChild(h);
    h.contentDocument.addEventListener('load', () => (sync = true));
    await tick();
    // (the parsed frame's window `load` comes in a tick, which runs before or after these microtasks)
    expect(events.filter((e) => e !== 'parsed window load')).toEqual(['f appended loading', 'g src loading', 'f load', 'g load']);
    expect(events).toContain('parsed window load');
    // attached without listeners: its document was complete (and its `load` over) before the listener was added
    expect([sync, h.contentDocument.readyState]).toEqual([false, 'complete']);
  });

  it('runs scripts in the frame window when the parent runs them', () => {
    const { window } = make('<iframe></iframe><script>window.r = [frames.length, frames[0].document.body.outerHTML, typeof frames[0].eval]</script>', { runScripts: 'dangerously' });
    expect(window.r).toEqual([1, '<body></body>', 'function']);
    expect(window[0].eval('window.parent === top && typeof parent.r')).toBe('object');
    const js = make('<iframe src="javascript:\'<b>hi\'"></iframe>', { runScripts: 'dangerously' }).window;
    expect(js.document.querySelector('iframe').contentDocument.body.innerHTML).toBe('&lt;b&gt;hi');
  });

  it('closes frame windows with their parent', () => {
    const { window } = make('<iframe></iframe>');
    const child = window[0];
    let fired = false;
    child.setTimeout(() => (fired = true), 0);
    window.close();
    return tick().then(() => expect(fired).toBe(false));
  });
});
