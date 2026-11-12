// ROADMAP M4 acceptance: an RTL-free React smoke test in plain Node using createWindow(): createRoot, render,
// click, onChange from a checkbox and a text input via dispatched events (DTL's setNativeValue pattern).
// The minimal globals react-dom needs are installed here (the Vitest environment is area C's job).
import { createRequire } from 'node:module';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow } = require('../../lib/index.cjs');

const GLOBALS = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
let saved;
let React;
let ReactDOMClient;
let window;
let document;

beforeAll(() => {
  ({ window, document } = createWindow());
  // react-dom probes `'animation' in div.style` at import time (area A's CSSStyleDeclaration).
  expect('style' in window.HTMLElement.prototype).toBe(true);
  saved = GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  React = require('react');
  ReactDOMClient = require('react-dom/client');
});

afterAll(() => {
  for (const [k, d] of saved) {
    if (d === undefined) delete globalThis[k];
    else Object.defineProperty(globalThis, k, d);
  }
});

/** DTL fireEvent.change(el, {target: {value}}): prototype setter (bypasses React's tracker) + input event. */
function setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
}

describe('React 19 on oxidom (no RTL)', () => {
  it('renders, handles clicks and onChange from checkbox and text input', async () => {
    const h = React.createElement;
    const log = [];
    function App() {
      const [count, setCount] = React.useState(0);
      const [checked, setChecked] = React.useState(false);
      const [text, setText] = React.useState('');
      return h('div', { id: 'app' },
        h('button', { id: 'inc', onClick: () => setCount((c) => c + 1) }, `count ${count}`),
        h('label', null, h('input', {
          id: 'cb', type: 'checkbox', checked,
          onChange: (e) => {
            log.push(`cb:${e.target.checked}`);
            setChecked(e.target.checked);
          },
        }), 'agree'),
        h('input', {
          id: 'txt', value: text,
          onChange: (e) => {
            log.push(`txt:${e.target.value}`);
            setText(e.target.value.toUpperCase());
          },
          onFocus: () => log.push('focus'),
        }),
        h('p', { id: 'out' }, `${checked ? 'yes' : 'no'}:${text}`));
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);
    await React.act(async () => root.render(h(App)));
    const $ = (id) => document.getElementById(id);
    expect($('inc').textContent).toBe('count 0');
    expect($('out').textContent).toBe('no:');

    await React.act(async () => $('inc').click());
    await React.act(async () => {
      $('inc').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    expect($('inc').textContent).toBe('count 2');

    await React.act(async () => $('cb').click());
    expect($('cb').checked).toBe(true);
    expect($('out').textContent).toBe('yes:');

    await React.act(async () => {
      setNativeValue($('txt'), 'abc');
      $('txt').dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    expect($('txt').value).toBe('ABC'); // controlled: React wrote the state back
    expect($('out').textContent).toBe('yes:ABC');

    await React.act(async () => $('txt').focus());
    expect(document.activeElement).toBe($('txt'));

    // clicking the label toggles the checkbox back through activation behaviour
    await React.act(async () => $('cb').parentNode.click());
    expect($('cb').checked).toBe(false);
    expect(log).toEqual(['cb:true', 'txt:abc', 'focus', 'cb:false']);
    expect(window.event).toBe(undefined);

    await React.act(async () => root.unmount());
    expect(container.childNodes.length).toBe(0);
  });
});
