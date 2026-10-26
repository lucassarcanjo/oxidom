// Type-checked by test/native/types.test.mjs (DESIGN §34): the nativedom entry, used the way jsdom's API is.
import { JSDOM, VirtualConsole, CookieJar, createWindow, type DOMWindow, type ConstructorOptions, type SupportedContentTypes } from 'nativedom';

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
// the window's interface objects are typed, not `any`
const el = dom.window.document.querySelector('input');
if (el instanceof dom.window.HTMLInputElement) void (el.value satisfies string);
// @ts-expect-error a KeyboardEvent's key is a string
const key: number = new dom.window.KeyboardEvent('keydown').key;
const jar: CookieJar = new CookieJar();
const type: SupportedContentTypes = 'text/html';

// @ts-expect-error runScripts takes 'dangerously' | 'outside-only'
new JSDOM('', { runScripts: 'sometimes' });
// @ts-expect-error jsdomErrors is a list or 'none'
new VirtualConsole().forwardTo(console, { jsdomErrors: 'some' });

void [p, text, frag, later, main, Div, key, jar, type];
