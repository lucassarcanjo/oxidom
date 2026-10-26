// Script execution (ROADMAP Stage 4 `browsing-contexts` part 1, DESIGN §45): `runScripts`, script elements,
// inline event handlers, `<noscript>` parsing and a `JSDOM` document's load sequence, side by side with jsdom.
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const APIS = { jsdom: require('jsdom'), rsdom: require('../../lib/index.cjs') };

describe.each(Object.keys(APIS))('script execution [%s]', (kind) => {
  const { JSDOM, VirtualConsole } = APIS[kind];
  const make = (html, options = {}) => new JSDOM(html, { virtualConsole: new VirtualConsole(), ...options });

  it('runs parsed and inserted scripts only with runScripts: "dangerously"', () => {
    const html = '<body><script>document.body.appendChild(document.createElement("hr"))</script></body>';
    expect(make(html).window.document.body.children.length).toBe(1);
    const outside = make(html, { runScripts: 'outside-only' }).window;
    outside.eval('document.body.appendChild(document.createElement("p"))');
    expect(outside.document.body.children.length).toBe(2);
    const { window } = make(html, { runScripts: 'dangerously' });
    expect(window.document.body.children.length).toBe(2);
    const s = window.document.createElement('script');
    s.textContent = 'window.ran = [document.currentScript === window.s, this === window]';
    window.s = s;
    window.document.body.appendChild(s);
    expect(window.ran).toEqual([true, true]);
    expect(window.document.currentScript).toBe(null);
    window.document.body.innerHTML = '<script>window.inner = 1</script>';
    expect(window.inner).toBe(undefined);
    // A fragment-parsed script is "already started", and so is its clone (HTML, WPT
    // svg-script-fragment-parsed-not-executed-on-clone.html); jsdom runs the clone (DESIGN §45)
    window.document.body.appendChild(window.document.body.firstChild.cloneNode(true));
    expect(window.inner).toBe(kind === 'jsdom' ? 1 : undefined);
  });

  it('shares one global between scripts, with fresh JS globals', () => {
    const { window } = make('<script>var a = 1; b = 2; Object.prototype.c = 3</script><script>window.d = a + b</script>', { runScripts: 'dangerously' });
    expect([window.a, window.d, new window.Object().c, window.Object === Object]).toEqual([1, 3, 3, false]);
  });

  it('runs a script once: empty and non-JavaScript ones wait, a src makes it run', () => {
    const { window } = make('<body>', { runScripts: 'dangerously' });
    const { document } = window;
    window.n = 0;
    const s = document.body.appendChild(document.createElement('script'));
    s.appendChild(document.createTextNode('n++'));
    s.appendChild(document.createTextNode('n++'));
    const t = document.createElement('script');
    t.type = 'text/plain';
    t.textContent = 'n += 10';
    document.body.appendChild(t);
    expect(window.n).toBe(1);
  });

  it('compiles inline event handlers with the document, form and element in scope', () => {
    const { window } = make('<form id=f><input name=q value=v><button type=button onclick="window.got = [elements.length, id, typeof getElementById]" id=b></button></form>', { runScripts: 'dangerously' });
    const b = window.document.getElementById('b');
    expect(typeof b.onclick).toBe('function');
    b.click();
    expect(window.got).toEqual([2, 'b', 'function']);
    b.setAttribute('onclick', 'window.second = event.type');
    b.click();
    expect(window.second).toBe('click');
    b.removeAttribute('onclick');
    expect(b.onclick).toBe(null);
    const plain = make('<div onclick="x()">').window.document.querySelector('div');
    expect(plain.onclick).toBe(null);
  });

  it('reports errors from scripts and handlers to the window', () => {
    const { window } = make('<body onclick="throw new Error(\'h\')"><script>onerror = (m, f, l) => { window.seen = [m, f, l > 0]; }; throw new Error("s")</script>', {
      runScripts: 'dangerously',
      url: 'http://example.com/',
    });
    expect(window.seen[0]).toMatch(/s$/);
    expect(window.seen.slice(1)).toEqual(['http://example.com/', true]);
    window.document.body.click();
    expect(window.seen[0]).toMatch(/h$/);
  });

  it('parses <noscript> as text only when scripts run', () => {
    const html = '<body><noscript><div></div></noscript>';
    expect(make(html).window.document.querySelector('noscript').firstChild.nodeName).toBe('DIV');
    expect(make(html, { runScripts: 'dangerously' }).window.document.querySelector('noscript').firstChild.nodeName).toBe('#text');
  });

  it('goes through the load sequence', async () => {
    const { window } = make('<body onload="window.order.push(\'body onload\')">', { runScripts: 'dangerously' });
    window.order = [window.document.readyState];
    window.document.addEventListener('readystatechange', () => window.order.push(window.document.readyState));
    window.document.addEventListener('DOMContentLoaded', () => window.order.push('DOMContentLoaded'));
    window.addEventListener('load', () => window.order.push('load'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(window.order).toEqual(['loading', 'interactive', 'DOMContentLoaded', 'complete', 'body onload', 'load']);
  });
});
