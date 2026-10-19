// element.style (CSSStyleDeclaration, ROADMAP M5 style part): differential against jsdom (the oracle) for
// value normalisation, shorthands, cssText and the style attribute, plus the prototype contract React
// and jest-dom rely on.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

/** [label, fn(el)] operations; each is applied to a fresh <div> in every DOM. */
const OPS = [
  ['color red', (d) => { d.style.color = 'red'; }],
  ['color RED', (d) => { d.style.color = 'RED'; }],
  ['color #f00', (d) => { d.style.color = '#f00'; }],
  ['color #ff000080', (d) => { d.style.color = '#ff000080'; }],
  ['color rgb', (d) => { d.style.color = 'rgb(1,2,3)'; }],
  ['color rgba .5', (d) => { d.style.color = 'rgba(1,2,3,.5)'; }],
  ['color rgba 1', (d) => { d.style.color = 'rgba(1,2,3,1)'; }],
  ['color rgb space', (d) => { d.style.color = 'rgb(1 2 3 / 50%)'; }],
  ['color hsl', (d) => { d.style.color = 'hsl(120,100%,50%)'; }],
  ['color transparent', (d) => { d.style.color = 'transparent'; }],
  ['color currentColor', (d) => { d.style.color = 'currentColor'; }],
  ['color invalid', (d) => { d.style.color = 'notacolor'; }],
  ['color inherit', (d) => { d.style.color = 'inherit'; }],
  ['color var', (d) => { d.style.color = 'var(--x)'; }],
  ['width number', (d) => { d.style.width = 10; }],
  ['width 10px', (d) => { d.style.width = '10px'; }],
  ['width 0', (d) => { d.style.width = '0'; }],
  ['width 1.50PX', (d) => { d.style.width = '1.50PX'; }],
  ['width 50%', (d) => { d.style.width = '50%'; }],
  ['width -5px', (d) => { d.style.width = '-5px'; }],
  ['width auto', (d) => { d.style.width = 'auto'; }],
  ['width calc', (d) => { d.style.width = 'calc(100% - 10px)'; }],
  ['width .5em', (d) => { d.style.width = '.5em'; }],
  ['margin -5px', (d) => { d.style.margin = '-5px'; }],
  ['margin 2', (d) => { d.style.margin = '1px 2px'; }],
  ['margin 3', (d) => { d.style.margin = '1px 2px 3px'; }],
  ['margin 4 same', (d) => { d.style.margin = '1px 1px 1px 1px'; }],
  ['margin 4 pairs', (d) => { d.style.margin = '1px 2px 1px 2px'; }],
  ['marginTop', (d) => { d.style.marginTop = '1px'; }],
  ['margin from longhands', (d) => { for (const s of ['Top', 'Right', 'Bottom', 'Left']) d.style[`margin${s}`] = '1px'; }],
  ['margin then top', (d) => { d.style.margin = '1px'; d.style.marginTop = '2px'; }],
  ['margin 0 auto', (d) => { d.style.margin = '0 auto'; }],
  ['padding', (d) => { d.style.padding = '8px 12px'; }],
  ['border full', (d) => { d.style.border = '1px solid red'; }],
  ['border 1px solid', (d) => { d.style.border = '1px solid'; }],
  ['border none', (d) => { d.style.border = 'none'; }],
  ['border 0', (d) => { d.style.border = '0'; }],
  ['borderWidth', (d) => { d.style.borderWidth = '1px'; }],
  ['borderColor', (d) => { d.style.borderColor = '#fff'; }],
  ['borderTop', (d) => { d.style.borderTop = '1px solid red'; }],
  ['borderBottom', (d) => { d.style.borderBottom = '2px dashed #333'; }],
  ['borderRadius', (d) => { d.style.borderRadius = '4px'; }],
  ['overflow', (d) => { d.style.overflow = 'hidden'; }],
  ['overflow 2', (d) => { d.style.overflow = 'hidden auto'; }],
  ['flex 1', (d) => { d.style.flex = '1'; }],
  ['flex auto', (d) => { d.style.flex = 'auto'; }],
  ['flex none', (d) => { d.style.flex = 'none'; }],
  ['flex 1 0 auto', (d) => { d.style.flex = '1 0 auto'; }],
  ['flexGrow', (d) => { d.style.flexGrow = '1'; }],
  ['background #fff', (d) => { d.style.background = '#fff'; }],
  ['background red url', (d) => { d.style.background = 'red url(a.png)'; }],
  ['backgroundColor', (d) => { d.style.backgroundColor = '#ffffff'; }],
  ['fontWeight bold', (d) => { d.style.fontWeight = 'bold'; }],
  ['fontWeight 700', (d) => { d.style.fontWeight = 700; }],
  ['fontWeight invalid', (d) => { d.style.fontWeight = 'heavy'; }],
  ['font', (d) => { d.style.font = '12px Arial'; }],
  ['fontFamily', (d) => { d.style.fontFamily = 'Arial, "Helvetica Neue", sans-serif'; }],
  ['display NONE', (d) => { d.style.display = 'NONE'; }],
  ['display invalid', (d) => { d.style.display = 'blah'; }],
  ['opacity', (d) => { d.style.opacity = '0.5'; }],
  ['opacity .50', (d) => { d.style.opacity = '.50'; }],
  ['opacity 0 number', (d) => { d.style.opacity = 0; }],
  ['opacity 50%', (d) => { d.style.opacity = '50%'; }],
  ['zIndex', (d) => { d.style.zIndex = 3; }],
  ['zIndex invalid', (d) => { d.style.zIndex = '1.5'; }],
  ['lineHeight', (d) => { d.style.lineHeight = 1.5; }],
  ['transform', (d) => { d.style.transform = 'translateX(10px) rotate(45deg)'; }],
  ['transition', (d) => { d.style.transition = 'opacity 0.3s ease'; }],
  ['cssFloat', (d) => { d.style.cssFloat = 'left'; }],
  ['position', (d) => { d.style.position = 'absolute'; }],
  ['top 0', (d) => { d.style.top = '0'; }],
  ['cursor', (d) => { d.style.cursor = 'pointer'; }],
  ['pointerEvents', (d) => { d.style.pointerEvents = 'none'; }],
  ['visibility', (d) => { d.style.visibility = 'hidden'; }],
  ['custom prop', (d) => { d.style.setProperty('--foo', ' bar '); }],
  ['custom prop case', (d) => { d.style.setProperty('--Foo-Bar', '1px  2px'); }],
  ['important', (d) => { d.style.setProperty('color', 'red', 'important'); }],
  ['bogus priority', (d) => { d.style.setProperty('color', 'red', 'bogus'); }],
  ['upper name', (d) => { d.style.setProperty('COLOR', 'red'); }],
  ['unknown property', (d) => { d.style.setProperty('foo', 'red'); }],
  ['setProperty null', (d) => { d.style.color = 'red'; d.style.setProperty('color', null); }],
  ['set empty removes', (d) => { d.style.color = 'red'; d.style.color = ''; }],
  ['value with !important', (d) => { d.style.color = 'red !important'; }],
  ['cssText', (d) => { d.style.cssText = 'color: red; color: blue; width: 10px !important; bogus: 1; height: x'; }],
  ['cssText margin', (d) => { d.style.cssText = 'margin: 0 auto; padding-top: 2px'; }],
  ['attribute', (d) => { d.setAttribute('style', 'color:red;width:1px'); }],
  ['attribute invalid', (d) => { d.setAttribute('style', 'color: nope; width:1px;;'); }],
  ['attribute then style', (d) => { d.setAttribute('style', 'color:red'); d.style.width = '1px'; }],
  ['attribute removed', (d) => { d.style.color = 'red'; d.removeAttribute('style'); }],
  ['WebkitTransform', (d) => { d.style.WebkitTransform = 'scale(2)'; }],
  ['webkitTransform', (d) => { d.style.webkitTransform = 'scale(2)'; }],
  ['color-scheme', (d) => { d.style.setProperty('color-scheme', 'dark'); }],
  ['textDecoration', (d) => { d.style.textDecoration = 'underline'; }],
  ['boxShadow', (d) => { d.style.boxShadow = '0 0 0 1px rgba(0,0,0,.1)'; }],
  ['gap', (d) => { d.style.gap = '4px'; }],
  ['grid', (d) => { d.style.gridTemplateColumns = 'repeat(2, 1fr)'; }],
  ['outline', (d) => { d.style.outline = 'none'; }],
  ['inset', (d) => { d.style.inset = '0'; }],
  ['textAlign', (d) => { d.style.textAlign = 'center'; }],
  ['whiteSpace', (d) => { d.style.whiteSpace = 'nowrap'; }],
  ['maxWidth', (d) => { d.style.maxWidth = '100%'; }],
  ['minHeight', (d) => { d.style.minHeight = '100vh'; }],
  ['content', (d) => { d.style.content = '"a"'; }],
  ['animation', (d) => { d.style.animation = 'spin 1s linear infinite'; }],
  ['style = string', (d) => { d.style = 'color: red'; }],
];

const READ = ['color', 'width', 'margin', 'margin-top', 'margin-left', 'border', 'border-top', 'border-top-width',
  'border-color', 'flex', 'flex-basis', 'font-weight', 'opacity', 'float', '--foo', 'background-color', 'padding',
  'display', 'height'];

function snapshot(d) {
  const s = d.style;
  const out = { cssText: s.cssText, attr: d.getAttribute('style') };
  for (const p of READ) {
    const v = s.getPropertyValue(p);
    if (v !== '') out[p] = v;
    if (s.getPropertyPriority(p)) out[`!${p}`] = s.getPropertyPriority(p);
  }
  return out;
}

describe.each(DOMS)('element.style [%s]', (kind) => {
  let w;
  let d;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });

  it('prototype contract: accessors on the prototype, `in` checks, no own properties', () => {
    const el = d.createElement('div');
    const s = el.style;
    expect(el.style).toBe(s);
    expect('animation' in s).toBe(true);
    expect('transition' in s).toBe(true);
    expect('cssFloat' in s).toBe(true);
    if (kind !== 'happy-dom') expect('webkitAnimation' in s).toBe(true); // PINNED: missing in happy-dom
    expect('fooBar' in s).toBe(false);
    if (kind !== 'happy-dom') expect(Object.keys(s).filter((k) => !/^\d+$/.test(k))).toEqual([]); // PINNED: happy-dom has own keys
    expect(typeof s.setProperty).toBe('function');
    if (kind !== 'happy-dom') {
      // PINNED to jsdom 30: instances are CSSStyleProperties
      expect(Object.prototype.toString.call(s)).toBe('[object CSSStyleProperties]');
    }
    expect(s instanceof w.CSSStyleDeclaration).toBe(true);
    s.fooBar = 1; // unknown names are plain expandos
    if (kind !== 'happy-dom') expect(s.fooBar).toBe(1); // PINNED: happy-dom drops them
    expect(s.cssText).toBe('');
    expect(s.length).toBe(0);
    expect(s.item(0)).toBe('');
    expect(s[0]).toBe(undefined);
    expect(s.parentRule).toBe(null);
    const svg = d.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.fill = 'red';
    expect(svg.getAttribute('style')).toBe('fill: red;');
  });

  it('length / item / iteration for longhands and custom properties', () => {
    const el = d.createElement('div');
    el.style.color = 'red';
    el.style.setProperty('--x', '1');
    el.style.cssFloat = 'left';
    expect(el.style.length).toBe(3);
    // PINNED to jsdom: happy-dom names cssFloat 'css-float'
    if (kind !== 'happy-dom') expect([el.style.item(0), el.style[1], el.style[2]]).toEqual(['color', '--x', 'float']);
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's removeProperty returns undefined
    expect(el.style.removeProperty('color')).toBe('red');
    expect(el.style.removeProperty('color')).toBe('');
    expect(el.style.length).toBe(2);
  });

  it('differential vs jsdom: normalisation, shorthands, cssText and the style attribute', () => {
    if (kind === 'jsdom') return;
    const o = makeWindow('jsdom').document;
    const diffs = [];
    for (const [label, op] of OPS) {
      const a = o.createElement('div');
      const b = d.createElement('div');
      op(a);
      op(b);
      const want = JSON.stringify(snapshot(a));
      const got = JSON.stringify(snapshot(b));
      if (got !== want) diffs.push(`${label}:\n  got  ${got}\n  want ${want}`);
    }
    if (kind === 'happy-dom') return; // PINNED to jsdom: reported only
    expect(diffs).toEqual([]);
  });

  it('style attribute sync: lazy parse, serialization only on change, MO-visible attribute writes', () => {
    const el = d.createElement('div');
    el.setAttribute('style', 'color:red');
    expect(el.style.color).toBe('red');
    el.style.color = 'red'; // unchanged serialization: attribute text kept as written
    if (kind !== 'happy-dom') expect(el.getAttribute('style')).toBe('color:red'); // PINNED: happy-dom re-serializes
    el.style.color = 'blue';
    expect(el.getAttribute('style')).toBe('color: blue;');
    el.setAttribute('style', 'width: 2px');
    expect(el.style.color).toBe('');
    expect(el.style.width).toBe('2px');
    const host = d.createElement('div');
    host.innerHTML = '<p style="margin: 1px 2px; color: #fff">x</p>';
    expect(host.firstChild.style.marginLeft).toBe('2px');
    if (kind !== 'happy-dom') expect(host.firstChild.style.color).toBe('rgb(255, 255, 255)'); // PINNED: happy-dom keeps #fff
    const clone = host.firstChild.cloneNode(true);
    expect(clone.style.marginRight).toBe('2px');
    expect(clone.style).not.toBe(host.firstChild.style);
  });

  it('React patterns: camelCase writes, numbers rejected without unit, removal with empty string', () => {
    const el = d.createElement('div');
    el.style.paddingLeft = '4px';
    el.style.width = 10; // React appends px itself; a bare number is invalid for lengths
    expect(el.style.width).toBe('');
    el.style.opacity = 0;
    expect(el.style.opacity).toBe('0');
    el.style.paddingLeft = '';
    expect(el.style.paddingLeft).toBe('');
    el.style.setProperty('--theme-color', '#000');
    expect(el.style.getPropertyValue('--theme-color')).toBe('#000');
    el.style.setProperty('display', 'none', 'important');
    expect(el.style.getPropertyPriority('display')).toBe('important');
    expect(el.style.cssText).toContain('display: none !important;');
    expect(errName(() => { el.style.cssText = null; })).toBe('ok');
  });
});
