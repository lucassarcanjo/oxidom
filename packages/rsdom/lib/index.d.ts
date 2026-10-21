// Type declarations for the `jetdom` package entry (ROADMAP Stage 2, DESIGN §34). The `JSDOM` API mirrors
// @types/jsdom for jsdom 30 (refs/jsdom/lib/api.js), so code typed against jsdom type-checks against jetdom; what
// rsdom does not implement is typed as jsdom types it, and documented in DESIGN §31.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference types="node" />
import { EventEmitter } from 'node:events';

/** A window: `window`, `document` and the interface objects, like @types/jsdom's `DOMWindow`. */
export interface DOMWindow extends Omit<Window, 'top' | 'self' | 'window' | number> {
  [key: string]: any;
  readonly top: DOMWindow;
  readonly self: DOMWindow;
  readonly window: DOMWindow;
  globalThis: DOMWindow;
}

/**
 * Opens a browsing context and returns its window and document, without installing globals.
 * `main: false` keeps the current context current (what `new Text()` & co create nodes in); `global` installs
 * the window's members on that object instead of a fresh one (the Vitest environment passes `globalThis`).
 */
export function createWindow(options?: CreateWindowOptions): { window: DOMWindow; document: Document };

export interface CreateWindowOptions {
  /** the document URL (default `http://localhost:3000/`) */
  url?: string | undefined;
  /** body markup, set as `documentElement.innerHTML` */
  html?: string | undefined;
  main?: boolean | undefined;
  global?: object | undefined;
}

export type BinaryData = ArrayBufferLike | NodeJS.ArrayBufferView;

export type JSDOMError = 'css-parsing' | 'not-implemented' | 'resource-loading' | 'unhandled-exception';

export interface VirtualConsoleForwardToOptions {
  jsdomErrors?: JSDOMError[] | 'none' | undefined;
}

/** jsdom's virtual console: receives the window's `console` calls and jsdomErrors. */
export class VirtualConsole extends EventEmitter {
  on<K extends keyof Console>(method: K, callback: Console[K]): this;
  on(event: 'jsdomError', callback: (e: Error) => void): this;
  forwardTo(console: Console, options?: VirtualConsoleForwardToOptions): this;
}

/** tough-cookie's CookieJar (loose mode), when tough-cookie is installed (it comes with jsdom); else undefined. */
export const CookieJar: (new (store?: unknown, options?: object) => any) | undefined;
/** the tough-cookie module, when installed */
export const toughCookie: any;

export interface ResourcesOptions {
  userAgent?: string | undefined;
  /** an undici Dispatcher, used by `JSDOM.fromURL()` */
  dispatcher?: unknown;
  interceptors?: unknown[] | undefined;
}

export interface BaseOptions {
  referrer?: string | undefined;
  /** validated; rsdom keeps no node locations, so `nodeLocation()` throws */
  includeNodeLocations?: boolean | undefined;
  /** validated; rsdom never runs scripts */
  runScripts?: 'dangerously' | 'outside-only' | undefined;
  resources?: 'usable' | ResourcesOptions | undefined;
  virtualConsole?: VirtualConsole | undefined;
  cookieJar?: any;
  pretendToBeVisual?: boolean | undefined;
  beforeParse?(window: DOMWindow): void;
}

export interface FileOptions extends BaseOptions {
  url?: string | undefined;
  contentType?: string | undefined;
}

export interface ConstructorOptions extends BaseOptions {
  url?: string | undefined;
  /** an HTML content type; XML types throw (no XML parser yet) */
  contentType?: string | undefined;
  storageQuota?: number | undefined;
}

export interface ReconfigureSettings {
  windowTop?: DOMWindow | undefined;
  url?: string | undefined;
}

/** jsdom's programmatic API (DESIGN §31): each instance is a browsing context of its own. */
export class JSDOM {
  constructor(html?: string | Buffer | BinaryData, options?: ConstructorOptions);
  static fromURL(url: string, options?: BaseOptions): Promise<JSDOM>;
  static fromFile(url: string, options?: FileOptions): Promise<JSDOM>;
  static fragment(html: string): DocumentFragment;

  readonly window: DOMWindow;
  readonly virtualConsole: VirtualConsole;
  readonly cookieJar: any;

  serialize(): string;
  /** throws: rsdom keeps no node locations */
  nodeLocation(node: Node): never;
  /** throws: rsdom never runs scripts */
  getInternalVMContext(): never;
  reconfigure(settings: ReconfigureSettings): void;
}

/** @internal the facade runtime (contract tests, benches); not a stable API */
export const rt: any;
/** @internal the core DOM classes; not a stable API */
export const dom: any;
