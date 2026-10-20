// Micro benchmark cases (ROADMAP M8, DESIGN §13 rows). Each case runs in several fresh Node processes per DOM,
// interleaved across DOMs (bench/micro/run.mjs spawns them); `run(ctx)` records metrics with
// `ctx.metric(name, unit, fn)`, where `fn` returns `bench(...)`'s { value, samples, iters } (ns per iteration;
// the iteration count passed to bench() is a nominal count, calibrated to ~100 ms per sample) or a number. A metric whose API is
// missing on this branch / DOM throws NA (reported as n/a) instead of failing the whole run, so benches light
// up as areas merge. Reads interleave mutations wherever a DOM could serve them from a cache; cold and warm
// are separate metrics.
import { bench, benchAsync, windowFor, installGlobalEnv, appRequire, need, roleSelectors, tableHTML, NA } from './lib.mjs';

/**
 * Alternates per pass over a list of `len` elements, so element `i % len` really changes on every visit.
 * (`i & 1` would give each element of an even-length list the same value on every pass: a same-value
 * set, which rsdom does not treat as a change for style invalidation.)
 */
const flip = (i, len) => ((i / len) | 0) & 1;

/** Builds a 4096-node tree (fan-out 4) under a fresh div; returns { root, all }. */
function tree4k(d) {
  const root = d.createElement('div');
  const all = [root];
  for (let i = 1; i < 4096; i++) {
    const s = d.createElement(i % 3 ? 'span' : 'div');
    all[(i - 1) >> 2].appendChild(s);
    all.push(s);
  }
  d.body.appendChild(root);
  return { root, all };
}

/** Elements named `tag` under `root` in tree order (core link getters only: no area-A collections). */
function byTag(root, tag) {
  const out = [];
  const T = tag.toUpperCase();
  let n = root.firstChild;
  while (n !== null && n !== root) {
    if (n.nodeType === 1 && n.tagName === T) out.push(n);
    if (n.firstChild !== null) {
      n = n.firstChild;
      continue;
    }
    while (n !== root && n.nextSibling === null) n = n.parentNode;
    n = n === root ? null : n.nextSibling;
  }
  return out;
}

function walk(r) {
  let count = 0;
  let n = r;
  while (n !== null) {
    count++;
    const f = n.firstChild;
    if (f !== null) {
      n = f;
      continue;
    }
    while (n !== r && n.nextSibling === null) n = n.parentNode;
    n = n === r ? null : n.nextSibling;
  }
  return count;
}

/** What React's SyntheticEvent + plugins read from a native MouseEvent (docs/lab/research/react-dom.md §5.3). */
const MOUSE_PROPS = ['type', 'target', 'currentTarget', 'eventPhase', 'bubbles', 'cancelable', 'timeStamp',
  'defaultPrevented', 'isTrusted', 'view', 'detail', 'screenX', 'screenY', 'clientX', 'clientY', 'pageX', 'pageY',
  'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'button', 'buttons', 'relatedTarget'];

let sink = 0;

export const cases = {
  mutate: {
    row: 1,
    run({ metric, w }) {
      const d = w.document;
      const body = d.body;
      metric('createElement + appendChild + removeChild', 'ns', () => bench(100_000, (n) => {
        for (let i = 0; i < n; i++) {
          const e = d.createElement('div');
          body.appendChild(e);
          body.removeChild(e);
        }
      }));
      const host = d.createElement('div');
      body.appendChild(host);
      metric('insertBefore first child + remove() (100 siblings)', 'ns', () => {
        for (let i = 0; i < 100; i++) host.appendChild(d.createElement('i'));
        return bench(100_000, (n) => {
          for (let i = 0; i < n; i++) {
            const e = d.createElement('b');
            host.insertBefore(e, host.firstChild);
            e.remove();
          }
        });
      });
    },
  },

  attr: {
    row: 2,
    run({ metric, w }) {
      const d = w.document;
      const el = d.createElement('div');
      d.body.appendChild(el);
      metric('setAttribute', 'ns', () => bench(200_000, (n) => {
        for (let i = 0; i < n; i++) el.setAttribute('title', 'v' + (i & 7));
      }));
      el.setAttribute('data-i', '42');
      metric('getAttribute (unchanged)', 'ns', () => bench(500_000, (n) => {
        let s = 0;
        for (let i = 0; i < n; i++) s += el.getAttribute('data-i').length;
        sink += s;
      }));
      metric('hasAttribute (unchanged)', 'ns', () => bench(500_000, (n) => {
        let s = 0;
        for (let i = 0; i < n; i++) s += el.hasAttribute(i & 1 ? 'data-i' : 'data-none') ? 1 : 0;
        sink += s;
      }));
      metric('setAttribute + getAttribute + hasAttribute, interleaved', 'ns/triple', () => bench(200_000, (n) => {
        let s = 0;
        for (let i = 0; i < n; i++) {
          el.setAttribute('data-i', i & 1 ? 'a' : 'bb');
          s += el.getAttribute('data-i').length + (el.hasAttribute('title') ? 1 : 0);
        }
        sink += s;
      }));
    },
  },

  deep: {
    row: 3,
    run({ metric, w }) {
      const d = w.document;
      metric('bottom-up detached build, 1001 nodes, depth 200, + attach', 'us', () => {
        const r = bench(20, (n) => {
          for (let k = 0; k < n; k++) {
            let child = d.createElement('div');
            for (let depth = 0; depth < 200; depth++) {
              const p = d.createElement('div');
              for (let j = 0; j < 4; j++) p.appendChild(d.createElement('span'));
              p.appendChild(child);
              child = p;
            }
            d.body.appendChild(child);
            child.remove();
          }
        });
        return { value: r.value / 1000, samples: r.samples.map((x) => x / 1000) };
      });
    },
  },

  walk: {
    row: 4,
    run({ metric, w }) {
      const d = w.document;
      const { root, all } = tree4k(d);
      metric('DFS firstChild/nextSibling/parentNode, 4096 nodes, steady', 'ns/node', () => {
        const r = bench(200, (n) => {
          let s = 0;
          for (let i = 0; i < n; i++) s += walk(root);
          sink += s;
        });
        return { value: r.value / 4096, samples: r.samples.map((x) => x / 4096) };
      });
      metric('same walk, interleaved: 1 setAttribute + 1 append/remove per walk', 'ns/node', () => {
        const r = bench(200, (n) => {
          let s = 0;
          for (let i = 0; i < n; i++) {
            const t = all[i & 1023];
            t.setAttribute('x', String((i >> 10) & 3)); // a new value on every pass over `all`
            const x = d.createElement('u');
            t.appendChild(x);
            s += walk(root);
            x.remove();
          }
          sink += s;
        });
        return { value: r.value / 4096, samples: r.samples.map((x) => x / 4096) };
      });
      metric('childNodes[i] indexed read of a 100-child list', 'ns', () => {
        const p = d.createElement('div');
        for (let i = 0; i < 100; i++) p.appendChild(d.createElement('i'));
        const cn = p.childNodes;
        return bench(100_000, (n) => {
          let s = 0;
          for (let i = 0; i < n; i++) s += cn[i % 100] === null ? 0 : 1;
          sink += s;
        });
      });
    },
  },

  traversal: {
    row: 'traversal',
    run({ metric, w }) {
      const d = w.document;
      need(typeof d.createTreeWalker === 'function', 'createTreeWalker missing');
      const { root } = tree4k(d);
      const NF = w.NodeFilter;
      const perNode = (iters, fn) => {
        const r = bench(iters, fn);
        return { value: r.value / 4096, samples: r.samples.map((x) => x / 4096) };
      };
      // First, while only this one NodeIterator exists: a removal runs the pre-removing steps for the iterators
      // of its document (src/traversal.rs), so compare with `mutate`. The cost grows with the iterators
      // registered on the document (jsdom's too), and the walks below create thousands on it that stay
      // registered until a GC collects them (no earlier than the end of this synchronous job).
      metric('createElement + appendChild + removeChild, with a live NodeIterator', 'ns', () => {
        const it = d.createNodeIterator(root, NF.SHOW_ELEMENT);
        const host = root.lastChild;
        const r = bench(100_000, (n) => {
          for (let i = 0; i < n; i++) {
            const e = d.createElement('div');
            host.appendChild(e);
            host.removeChild(e);
          }
        });
        sink += it.referenceNode === root ? 1 : 0;
        return r;
      });
      metric('TreeWalker(SHOW_ELEMENT).nextNode() over 4096 nodes', 'ns/node', () => perNode(200, (n) => {
        for (let i = 0; i < n; i++) {
          const tw = d.createTreeWalker(root, NF.SHOW_ELEMENT);
          while (tw.nextNode() !== null) sink++;
        }
      }));
      // focus-trap / Radix FocusScope shape: an object filter that reads one property per node
      const filter = { acceptNode: (node) => (node.localName === 'span' ? NF.FILTER_ACCEPT : NF.FILTER_SKIP) };
      metric('TreeWalker with an acceptNode filter, 4096 nodes', 'ns/node', () => perNode(200, (n) => {
        for (let i = 0; i < n; i++) {
          const tw = d.createTreeWalker(root, NF.SHOW_ELEMENT, filter);
          while (tw.nextNode() !== null) sink++;
        }
      }));
      metric('NodeIterator(SHOW_ELEMENT).nextNode() over 4096 nodes', 'ns/node', () => perNode(200, (n) => {
        for (let i = 0; i < n; i++) {
          const it = d.createNodeIterator(root, NF.SHOW_ELEMENT);
          while (it.nextNode() !== null) sink++;
        }
      }));
    },
  },

  ranges: {
    row: 'ranges',
    run({ metric, w }) {
      const d = w.document;
      need(typeof d.createRange().comparePoint === 'function', 'Range.comparePoint missing');
      const { root, all } = tree4k(d);
      // Compare with `mutate`: every insertion and removal runs the live-range steps for the ranges of its
      // document (src/range.rs). This one is the only range alive while it runs.
      metric('createElement + appendChild + removeChild, with a live Range on the document', 'ns', () => {
        const r = d.createRange();
        r.selectNodeContents(root);
        const host = root.lastChild;
        const res = bench(100_000, (n) => {
          for (let i = 0; i < n; i++) {
            const e = d.createElement('div');
            host.appendChild(e);
            host.removeChild(e);
          }
        });
        sink += r.endOffset;
        return res;
      });
      metric('insertBefore first child + remove(), live Range on the parent (100 siblings)', 'ns', () => {
        const host = d.createElement('div');
        root.appendChild(host);
        for (let i = 0; i < 100; i++) host.appendChild(d.createElement('i'));
        const r = d.createRange();
        r.setStart(host, 50);
        const res = bench(100_000, (n) => {
          for (let i = 0; i < n; i++) {
            const e = d.createElement('b');
            host.insertBefore(e, host.firstChild);
            e.remove();
          }
        });
        sink += r.startOffset;
        host.remove();
        return res;
      });
      metric('createRange + setStart + setEnd', 'ns', () => bench(100_000, (n) => {
        for (let i = 0; i < n; i++) {
          const r = d.createRange();
          r.setStart(all[i & 4095], 0);
          r.setEnd(root, 1);
          sink += r.endOffset;
        }
      }));
      const r = d.createRange();
      r.setStart(all[100], 1);
      r.setEnd(all[3000], 0);
      metric('comparePoint against a range, random nodes of a 4096-node tree', 'ns', () => bench(200_000, (n) => {
        for (let i = 0; i < n; i++) sink += r.comparePoint(all[(i * 2654435761) & 4095], 0);
      }));
      const text = d.createElement('div');
      text.innerHTML = '<p>' + 'lorem <b>ipsum</b> dolor '.repeat(100) + '</p>';
      root.appendChild(text);
      const t = d.createRange();
      t.selectNodeContents(text);
      metric('toString of a 300-node paragraph', 'ns', () => bench(20_000, (n) => {
        for (let i = 0; i < n; i++) sink += t.toString().length;
      }));
    },
  },

  matches: {
    row: 9,
    run({ metric, w }) {
      const d = w.document;
      need(typeof d.body.matches === 'function', 'Element#matches missing (area A)');
      const sels = roleSelectors();
      const host = d.createElement('div');
      d.body.appendChild(host);
      host.innerHTML = tableHTML(60) + '<form><label>Name <input name="n"></label><select><option>a</option></select>'
        + '<textarea></textarea><input type="email"><input type="radio" name="r"><button>Go</button></form>'
        + '<nav><ul><li><a href="/">Home</a></li></ul></nav><h1>Title</h1><img alt="x"><section aria-label="s"></section>';
      const els = Array.from(host.querySelectorAll ? host.querySelectorAll('*') : host.getElementsByTagName('*'));
      // DTL's getImplicitAriaRoles: for each element, test role selectors until one matches.
      const pass = () => {
        let calls = 0;
        for (const el of els) {
          for (const s of sels) {
            calls++;
            if (el.matches(s)) break;
          }
        }
        return calls;
      };
      const calls = pass();
      metric(`DTL role selectors x ${els.length} elements, warm`, 'ns/call', () => {
        const r = bench(5, (n) => {
          for (let i = 0; i < n; i++) sink += pass();
        });
        return { value: r.value / calls, samples: r.samples.map((x) => x / calls) };
      });
      metric('same, interleaved: 1 attribute + 1 child-list mutation per pass', 'ns/call', () => {
        const r = bench(5, (n) => {
          for (let i = 0; i < n; i++) {
            els[i % els.length].setAttribute('data-m', String(i));
            host.appendChild(d.createElement('i')).remove();
            sink += pass();
          }
        });
        return { value: r.value / calls, samples: r.samples.map((x) => x / calls) };
      });
    },
  },

  qsa: {
    row: 10,
    run({ metric, w }) {
      const d = w.document;
      need(typeof d.querySelectorAll === 'function', 'querySelectorAll missing (area A)');
      const host = d.createElement('div');
      d.body.appendChild(host);
      host.innerHTML = tableHTML(300);
      const sels = ['tr', 'td.cell', 'tbody > tr.odd', '[data-row="150"]', 'input[type="checkbox"]', 'tr td button'];
      const row = host.querySelector('tr[data-row="7"]');
      metric(`querySelectorAll cold (after a mutation), ${host.getElementsByTagName('*').length}-element table`, 'us/query', () => {
        const r = bench(50, (n) => {
          for (let i = 0; i < n; i++) {
            row.setAttribute('data-x', String(i));
            sink += host.querySelectorAll(sels[i % sels.length]).length;
          }
        });
        return { value: r.value / 1000, samples: r.samples.map((x) => x / 1000) };
      });
      metric('querySelectorAll warm (same query, no mutation)', 'us/query', () => {
        const r = bench(200, (n) => {
          for (let i = 0; i < n; i++) sink += host.querySelectorAll('td.cell').length;
        });
        return { value: r.value / 1000, samples: r.samples.map((x) => x / 1000) };
      });
      metric('querySelector #id-less first match, cold', 'us/query', () => {
        const r = bench(200, (n) => {
          for (let i = 0; i < n; i++) {
            row.setAttribute('data-x', String(i));
            sink += host.querySelector('button') === null ? 0 : 1;
          }
        });
        return { value: r.value / 1000, samples: r.samples.map((x) => x / 1000) };
      });
    },
  },

  gcs: {
    row: 12,
    run({ metric, w }) {
      const d = w.document;
      need(typeof w.getComputedStyle === 'function' && w.getComputedStyle.name !== 'getComputedStyleStub', 'getComputedStyle missing (area A)');
      const host = d.createElement('div');
      d.body.appendChild(host);
      host.innerHTML = tableHTML(100);
      const style = d.createElement('style');
      style.textContent = '.hidden { display: none } .odd td { color: rgb(1, 2, 3) }';
      d.head.appendChild(style);
      const cells = byTag(host, 'td');
      metric('getComputedStyle(el).display, cold after a class mutation', 'ns', () => bench(5_000, (n) => {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const el = cells[i % cells.length];
          el.className = flip(i, cells.length) ? 'cell' : 'cell x';
          s += w.getComputedStyle(el).display.length;
        }
        sink += s;
      }));
      metric('getComputedStyle(el).visibility, warm (no mutation)', 'ns', () => bench(20_000, (n) => {
        let s = 0;
        for (let i = 0; i < n; i++) s += w.getComputedStyle(cells[i & 63]).visibility.length;
        sink += s;
      }));
      // jest-dom toHaveStyle-like reads: rsdom packs display/visibility/pointer-events/opacity/position into
      // one snapshot; every other property is a separate lazy crossing (M9 review: the rows above only read
      // packed properties).
      metric('4 properties (display, color, margin-left, font-weight), cold after a class mutation', 'ns', () => bench(5_000, (n) => {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const el = cells[i % cells.length];
          el.className = flip(i, cells.length) ? 'cell' : 'cell x';
          const cs = w.getComputedStyle(el);
          s += cs.display.length + cs.color.length + cs.marginLeft.length + cs.fontWeight.length;
        }
        sink += s;
      }));
      metric('getPropertyValue("color"), cold after a class mutation', 'ns', () => bench(5_000, (n) => {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const el = cells[i % cells.length];
          el.className = flip(i, cells.length) ? 'cell' : 'cell x';
          s += w.getComputedStyle(el).getPropertyValue('color').length;
        }
        sink += s;
      }));
      // A Tailwind- / CSS-module-sized sheet (800 class-keyed rules, none matching): the rows above use a
      // 2-rule sheet, which hides cascade costs that grow with the number of author rules.
      const big = d.createElement('style');
      let css = '';
      for (let i = 0; i < 400; i++) css += `.u${i}{display:flex;color:red} .p${i}{position:absolute}\n`;
      big.textContent = css;
      d.head.appendChild(big);
      metric('display, cold after a class mutation, + 800-rule class-keyed sheet', 'ns', () => bench(5_000, (n) => {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const el = cells[i % cells.length];
          el.className = flip(i, cells.length) ? 'cell' : 'cell x';
          s += w.getComputedStyle(el).display.length;
        }
        sink += s;
      }));
      metric('getPropertyValue("color"), cold after a class mutation, + 800-rule sheet', 'ns', () => bench(5_000, (n) => {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const el = cells[i % cells.length];
          el.className = flip(i, cells.length) ? 'cell' : 'cell x';
          s += w.getComputedStyle(el).getPropertyValue('color').length;
        }
        sink += s;
      }));
    },
  },

  focus: {
    row: 13,
    run({ metric, w }) {
      const d = w.document;
      const a = d.createElement('input');
      const b = d.createElement('input');
      d.body.append(a, b);
      need(typeof a.focus === 'function', 'HTMLElement#focus missing (area B)');
      a.focus();
      need(d.activeElement === a, 'focus() does not move activeElement (area B)');
      metric('focus() alternating between two inputs (blur/focusout/focus/focusin)', 'ns', () => bench(20_000, (n) => {
        for (let i = 0; i < n; i++) (i & 1 ? a : b).focus();
      }));
    },
  },

  event: {
    row: 14,
    run({ metric, w }) {
      const d = w.document;
      need(typeof d.body.addEventListener === 'function' && typeof w.MouseEvent === 'function', 'EventTarget/MouseEvent missing (area B)');
      const root = d.createElement('div');
      d.body.appendChild(root);
      let leaf = root;
      for (let i = 0; i < 20; i++) leaf = leaf.appendChild(d.createElement(i & 1 ? 'span' : 'div'));
      // React-like: one capture + one bubble listener on the root container reading the synthetic-event props,
      // plus a plain listener on the target.
      const reader = (e) => {
        let s = 0;
        for (const p of MOUSE_PROPS) s += e[p] === undefined ? 0 : 1;
        sink += s;
      };
      root.addEventListener('click', reader, true);
      root.addEventListener('click', reader, false);
      leaf.addEventListener('click', () => {});
      metric('new MouseEvent + dispatch, 20 levels, React-like listeners', 'ns', () => bench(20_000, (n) => {
        for (let i = 0; i < n; i++) leaf.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, clientX: i }));
      }));
    },
  },

  parse: {
    row: 15,
    run({ metric, w }) {
      const d = w.document;
      const host = d.createElement('div');
      d.body.appendChild(host);
      const html = tableHTML(300);
      metric('innerHTML set, 300-row table', 'us', () => {
        const r = bench(10, (n) => {
          for (let i = 0; i < n; i++) host.innerHTML = html;
        });
        return { value: r.value / 1000, samples: r.samples.map((x) => x / 1000) };
      });
    },
  },

  serialize: {
    row: 16,
    run({ metric, w }) {
      const d = w.document;
      const host = d.createElement('div');
      d.body.appendChild(host);
      host.innerHTML = tableHTML(300);
      const cell = byTag(host, 'td')[5];
      metric('outerHTML get, 300-row table, after a text mutation', 'us', () => {
        const r = bench(20, (n) => {
          for (let i = 0; i < n; i++) {
            cell.textContent = String(i);
            sink += host.outerHTML.length;
          }
        });
        return { value: r.value / 1000, samples: r.samples.map((x) => x / 1000) };
      });
      metric('textContent get, same table, after a text mutation', 'us', () => {
        const r = bench(50, (n) => {
          for (let i = 0; i < n; i++) {
            cell.textContent = String(i);
            sink += host.textContent.length;
          }
        });
        return { value: r.value / 1000, samples: r.samples.map((x) => x / 1000) };
      });
    },
  },

  mo: {
    row: 18,
    async run({ metric, metricAsync, w }) {
      const d = w.document;
      need(typeof w.MutationObserver === 'function', 'MutationObserver missing');
      const { root } = tree4k(d);
      const MO = w.MutationObserver;
      const opts = { subtree: true, childList: true, attributes: true, characterData: true };
      metric('observe + disconnect, 4096-node subtree (DTL waitFor options)', 'ns/pair', () => bench(5_000, (n) => {
        for (let i = 0; i < n; i++) {
          const m = new MO(() => {});
          m.observe(root, opts);
          m.disconnect();
        }
      }));
      const leaf = root.lastChild.lastChild;
      metric('appendChild + remove under an active subtree observer (records queued)', 'ns/pair', () => {
        const m = new MO(() => {});
        m.observe(root, opts);
        const r = bench(50_000, (n) => {
          for (let i = 0; i < n; i++) leaf.appendChild(d.createElement('i')).remove();
          m.takeRecords();
        });
        m.disconnect();
        return r;
      });
      await metricAsync('burst of 100 mutations -> one callback delivery (await microtask)', 'us/burst', async () => {
        let got = 0;
        const m = new MO((recs) => {
          got += recs.length;
        });
        m.observe(root, opts);
        const r = await benchAsync(200, async (n) => {
          for (let i = 0; i < n; i++) {
            for (let k = 0; k < 50; k++) leaf.appendChild(d.createElement('i')).remove();
            await new Promise((res) => setImmediate(res)); // after the microtask checkpoint, no 1 ms timer clamp
          }
        });
        m.disconnect();
        need(got > 0, 'no records delivered');
        return { value: r.value / 1000, samples: r.samples.map((x) => x / 1000) };
      });
    },
  },

  mem: {
    row: 19,
    gc: true,
    run({ metric, w }) {
      const d = w.document;
      need(typeof globalThis.gc === 'function', 'needs --expose-gc');
      const N = 100_000;
      const host = d.createElement('div');
      d.body.appendChild(host);
      for (let i = 0; i < 1000; i++) host.appendChild(d.createElement('div')); // warm allocators / tables
      host.textContent = '';
      globalThis.gc();
      globalThis.gc();
      const m0 = process.memoryUsage();
      for (let i = 0; i < N; i++) {
        const e = d.createElement('div');
        e.className = 'c';
        host.appendChild(e);
      }
      globalThis.gc();
      globalThis.gc();
      const m1 = process.memoryUsage();
      metric('RSS per retained <div class> (100k, wrapper alive)', 'bytes', () => (m1.rss - m0.rss) / N);
      metric('V8 heap + external per retained <div class>', 'bytes', () => (m1.heapUsed + m1.external - m0.heapUsed - m0.external) / N);
      // rsdom keeps node data in Rust (RSS / external), so V8 heap alone is NOT comparable across DOMs:
      // reported for attribution only (the ratio column says so).
      metric('V8 heap only per retained <div class> (not comparable: rsdom data lives outside V8)', 'bytes-nc', () => (m1.heapUsed - m0.heapUsed) / N);
      sink += host.childNodes.length;
      host.textContent = '';
      // Churn: rsdom never reclaims node records inside an env (CONTRIBUTING §8), GC-based DOMs free them
      // (inside the timed loops of mutate / deep / parse). Created-and-discarded nodes, after 2x gc().
      const html = tableHTML(25); // ~300 nodes
      const CHURN = 2000;
      globalThis.gc();
      globalThis.gc();
      const c0 = process.memoryUsage();
      for (let i = 0; i < CHURN; i++) host.innerHTML = html;
      const kept = walk(host) - 1; // nodes per innerHTML (elements + text)
      host.textContent = '';
      globalThis.gc();
      globalThis.gc();
      const c1 = process.memoryUsage();
      const discarded = CHURN * kept;
      metric(`churn: RSS growth per created-and-discarded node (${CHURN} x innerHTML of ${kept} nodes, after gc)`, 'bytes', () => (c1.rss - c0.rss) / discarded);
    },
  },

  env: {
    row: 17,
    process: true,
    /** One sample per process: import + window creation on globalThis (Vitest environment `setup`). */
    async run({ metric, kind }) {
      const { ms, importMs, setupMs, teardown } = await installGlobalEnv(kind);
      metric('environment setup (import + window on globalThis), fresh process, in-process timing', 'ms', () => ms);
      // breakdown only: jsdom / happy-dom import their package inside setup(), rsdom's facade loads lazily too
      metric('  of which: environment module import', 'ms-nc', () => importMs);
      metric('  of which: setup()', 'ms-nc', () => setupMs);
      const t0 = performance.now();
      await teardown();
      metric('environment teardown', 'ms', () => performance.now() - t0);
    },
  },

  'env-vitest': {
    row: 17,
    process: true,
    /**
     * The authoritative env-setup number (M9 review): Vitest's own per-file `environment` phase
     * (diagnostic().environmentSetupDuration via bench/e2e/phase-reporter.mjs) in a real `vitest run`,
     * pool forks, maxWorkers=1, isolate (one fresh worker per file), 6 trivial test files
     * (bench/micro/env-fixture). One `vitest run` per process sample; the median over its files.
     */
    async run({ metric, kind }) {
      const { runEnvFixture } = await import('./env-fixture/run.mjs');
      const r = runEnvFixture(kind);
      metric('Vitest environment phase per file (forks, isolate, maxWorkers=1)', 'ms', () => r.envMedian);
      metric('vitest run wall, 6 trivial files (forks, maxWorkers=1)', 'ms', () => r.wall);
    },
  },

  react: {
    row: 'react',
    global: true,
    async run({ metric }) {
      const req = appRequire();
      // react-dom reads element.style at import time and registers listeners on the root container.
      need(document.createElement('div').style !== undefined, 'element.style missing (area A): react-dom import needs it');
      need(typeof document.createElement('div').addEventListener === 'function', 'EventTarget missing (area B): createRoot needs listeners');
      const React = req('react');
      const { createRoot } = req('react-dom/client');
      const { flushSync } = req('react-dom');
      const h = React.createElement;
      const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `User ${i}`, email: `u${i}@x.io`, role: i % 3 ? 'member' : 'admin' }));
      function Table({ data, sel }) {
        return h('table', null, h('tbody', null, data.map((r) => h('tr', { key: r.id, className: r.id === sel ? 'sel' : undefined },
          h('td', null, r.name), h('td', null, h('a', { href: `mailto:${r.email}` }, r.email)), h('td', null, r.role),
          h('td', null, h('input', { type: 'checkbox', checked: r.id === sel, onChange: () => {}, 'aria-label': `Select ${r.id}` }))))));
      }
      const container = document.createElement('div');
      document.body.appendChild(container);
      let root = null;
      const mount = () => {
        root = createRoot(container);
        flushSync(() => root.render(h(Table, { data: rows, sel: -1 })));
      };
      const unmount = () => {
        flushSync(() => root.unmount());
        root = null;
      };
      metric('createRoot + render 1000-row table (flushSync)', 'ms', () => {
        const r = bench(3, (n) => {
          for (let i = 0; i < n; i++) {
            mount();
            unmount();
          }
        });
        return { value: r.value / 1e6, samples: r.samples.map((x) => x / 1e6) };
      });
      metric('update: re-render with a new selected row', 'ms', () => {
        mount();
        let k = 0;
        const r = bench(10, (n) => {
          for (let i = 0; i < n; i++) flushSync(() => root.render(h(Table, { data: rows, sel: k++ % 1000 })));
        });
        unmount();
        return { value: r.value / 1e6, samples: r.samples.map((x) => x / 1e6) };
      });
    },
  },

  'testing-library': {
    row: 'dtl',
    global: true,
    async run({ metric }) {
      const req = appRequire();
      const dtl = req('@testing-library/dom');
      need(typeof document.querySelectorAll === 'function', 'querySelectorAll missing (area A)');
      const host = document.createElement('div');
      document.body.appendChild(host);
      host.innerHTML = tableHTML(1000);
      let first = true;
      metric('getAllByRole("row") on a 1000-row table', 'ms', () => {
        const r = bench(3, (n) => {
          for (let i = 0; i < n; i++) {
            const rows = dtl.getAllByRole(host, 'row');
            if (first) {
              need(rows.length === 1001, `expected 1001 rows, got ${rows.length}`);
              first = false;
            }
            sink += rows.length;
          }
        });
        return { value: r.value / 1e6, samples: r.samples.map((x) => x / 1e6) };
      });
      metric('getByRole("button", {name}) on the same table (accessible names)', 'ms', () => {
        host.querySelector('tr[data-row="500"] button').textContent = 'Delete';
        const r = bench(3, (n) => {
          for (let i = 0; i < n; i++) sink += dtl.getByRole(host, 'button', { name: 'Delete' }) ? 1 : 0;
        });
        return { value: r.value / 1e6, samples: r.samples.map((x) => x / 1e6) };
      });
    },
  },
};

export { NA, windowFor, installGlobalEnv };
export const getSink = () => sink;
