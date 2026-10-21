// Type-checked by test/native/types.test.mjs (DESIGN §34): the jetdom entry, used the way jsdom's API is.
import { JSDOM, VirtualConsole, createWindow, type DOMWindow, type ConstructorOptions } from 'jetdom';

const options: ConstructorOptions = { url: 'https://example.com/', pretendToBeVisual: true, storageQuota: 10, resources: { userAgent: 'x' } };
const vc = new VirtualConsole().forwardTo(console, { jsdomErrors: ['not-implemented'] });
vc.on('jsdomError', (e: Error) => e.message);
const dom = new JSDOM('<p>hi</p>', { ...options, virtualConsole: vc, beforeParse: (w: DOMWindow) => void w.document });
const p: HTMLParagraphElement | null = dom.window.document.querySelector('p');
const text: string = dom.serialize();
dom.reconfigure({ url: 'https://example.com/b', windowTop: dom.window });
const frag: DocumentFragment = JSDOM.fragment('<b>x</b>');
const later: Promise<JSDOM> = JSDOM.fromFile('page.html', { contentType: 'text/html' });
const { window, document } = createWindow({ url: 'http://localhost/', html: '<main></main>' });
const main: HTMLElement | null = document.querySelector('main');
const Div: typeof HTMLDivElement = window.HTMLDivElement;

// @ts-expect-error runScripts takes 'dangerously' | 'outside-only'
new JSDOM('', { runScripts: 'sometimes' });
// @ts-expect-error jsdomErrors is a list or 'none'
new VirtualConsole().forwardTo(console, { jsdomErrors: 'some' });

void [p, text, frag, later, main, Div];
