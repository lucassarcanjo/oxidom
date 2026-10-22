// Type declarations for the `jetdom` package entry (ROADMAP Stage 2, DESIGN §34). The `JSDOM` API mirrors
// @types/jsdom for jsdom 30 (refs/jsdom/lib/api.js), so code typed against jsdom type-checks against jetdom; what
// rsdom does not implement is typed as jsdom types it, and documented in DESIGN §31.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference types="node" />
import { EventEmitter } from 'node:events';
import * as tough from 'tough-cookie';

/**
 * A window, as @types/jsdom 30 declares it (copied from it: MIT License, Copyright (c) Microsoft Corporation), so
 * a jetdom window is assignable where a jsdom one is expected. Members rsdom does not implement yet (`customElements`,
 * `XMLSerializer`, CSSOM rule classes, XPath: ROADMAP Stage 3) are declared as jsdom declares them.
 */
export interface DOMWindow extends Omit<Window, "top" | "self" | "window" | number> {
  [key: string]: any;
  [index: number]: any;

  /* node_modules/jsdom/browser/Window.js */
  Window: typeof Window;
  readonly top: DOMWindow;
  readonly self: DOMWindow;
  readonly window: DOMWindow;

  /* ECMAScript Globals */
  globalThis: DOMWindow;
  readonly ["Infinity"]: number;
  readonly ["NaN"]: number;
  readonly undefined: undefined;

  eval(script: string): unknown;
  parseInt(s: string, radix?: number): number;
  parseFloat(string: string): number;
  isNaN(number: number): boolean;
  isFinite(number: number): boolean;
  decodeURI(encodedURI: string): string;
  decodeURIComponent(encodedURIComponent: string): string;
  encodeURI(uri: string): string;
  encodeURIComponent(uriComponent: string | number | boolean): string;
  escape(string: string): string;
  unescape(string: string): string;

  Array: typeof Array;
  ArrayBuffer: typeof ArrayBuffer;
  Atomics: typeof Atomics;
  BigInt: typeof BigInt;
  BigInt64Array: typeof BigInt64Array;
  BigUint64Array: typeof BigUint64Array;
  Boolean: typeof Boolean;
  DataView: typeof DataView;
  Date: typeof Date;
  Error: typeof Error;
  EvalError: typeof EvalError;
  FinalizationRegistry: FinalizationRegistryConstructor;
  Float32Array: typeof Float32Array;
  Float64Array: typeof Float64Array;
  Function: typeof Function;
  Int16Array: typeof Int16Array;
  Int32Array: typeof Int32Array;
  Int8Array: typeof Int8Array;
  Intl: typeof Intl;
  JSON: typeof JSON;
  Map: typeof Map;
  Math: typeof Math;
  Number: typeof Number;
  Object: typeof Object;
  Promise: typeof Promise;
  Proxy: typeof Proxy;
  RangeError: typeof RangeError;
  ReferenceError: typeof ReferenceError;
  Reflect: typeof Reflect;
  RegExp: typeof RegExp;
  Set: typeof Set;
  SharedArrayBuffer: typeof SharedArrayBuffer;
  String: typeof String;
  Symbol: typeof Symbol;
  SyntaxError: typeof SyntaxError;
  TypeError: typeof TypeError;
  URIError: typeof URIError;
  Uint16Array: typeof Uint16Array;
  Uint32Array: typeof Uint32Array;
  Uint8Array: typeof Uint8Array;
  Uint8ClampedArray: typeof Uint8ClampedArray;
  WeakMap: typeof WeakMap;
  WeakRef: WeakRefConstructor;
  WeakSet: typeof WeakSet;
  WebAssembly: typeof WebAssembly;

  /* node_modules/jsdom/living/interfaces.js */
  DOMException: typeof DOMException;

  URL: typeof URL;
  URLSearchParams: typeof URLSearchParams;

  EventTarget: typeof EventTarget;

  NamedNodeMap: typeof NamedNodeMap;
  Node: typeof Node;
  Attr: typeof Attr;
  Element: typeof Element;
  DocumentFragment: typeof DocumentFragment;
  DOMImplementation: typeof DOMImplementation;
  Document: typeof Document;
  HTMLDocument: typeof HTMLDocument;
  XMLDocument: typeof XMLDocument;
  CharacterData: typeof CharacterData;
  Text: typeof Text;
  CDATASection: typeof CDATASection;
  ProcessingInstruction: typeof ProcessingInstruction;
  Comment: typeof Comment;
  DocumentType: typeof DocumentType;
  NodeList: typeof NodeList;
  HTMLCollection: typeof HTMLCollection;
  HTMLOptionsCollection: typeof HTMLOptionsCollection;
  DOMStringMap: typeof DOMStringMap;
  DOMTokenList: typeof DOMTokenList;

  StyleSheetList: typeof StyleSheetList;

  HTMLElement: typeof HTMLElement;
  HTMLHeadElement: typeof HTMLHeadElement;
  HTMLTitleElement: typeof HTMLTitleElement;
  HTMLBaseElement: typeof HTMLBaseElement;
  HTMLLinkElement: typeof HTMLLinkElement;
  HTMLMetaElement: typeof HTMLMetaElement;
  HTMLStyleElement: typeof HTMLStyleElement;
  HTMLBodyElement: typeof HTMLBodyElement;
  HTMLHeadingElement: typeof HTMLHeadingElement;
  HTMLParagraphElement: typeof HTMLParagraphElement;
  HTMLHRElement: typeof HTMLHRElement;
  HTMLPreElement: typeof HTMLPreElement;
  HTMLUListElement: typeof HTMLUListElement;
  HTMLOListElement: typeof HTMLOListElement;
  HTMLLIElement: typeof HTMLLIElement;
  HTMLMenuElement: typeof HTMLMenuElement;
  HTMLDListElement: typeof HTMLDListElement;
  HTMLDivElement: typeof HTMLDivElement;
  HTMLAnchorElement: typeof HTMLAnchorElement;
  HTMLAreaElement: typeof HTMLAreaElement;
  HTMLBRElement: typeof HTMLBRElement;
  HTMLButtonElement: typeof HTMLButtonElement;
  HTMLCanvasElement: typeof HTMLCanvasElement;
  HTMLDataElement: typeof HTMLDataElement;
  HTMLDataListElement: typeof HTMLDataListElement;
  HTMLDetailsElement: typeof HTMLDetailsElement;
  HTMLDialogElement: {
    new(): HTMLDialogElement;
    readonly prototype: HTMLDialogElement;
  };
  HTMLDirectoryElement: typeof HTMLDirectoryElement;
  HTMLFieldSetElement: typeof HTMLFieldSetElement;
  HTMLFontElement: typeof HTMLFontElement;
  HTMLFormElement: typeof HTMLFormElement;
  HTMLHtmlElement: typeof HTMLHtmlElement;
  HTMLImageElement: typeof HTMLImageElement;
  HTMLInputElement: typeof HTMLInputElement;
  InputEvent: typeof InputEvent;
  HTMLLabelElement: typeof HTMLLabelElement;
  HTMLLegendElement: typeof HTMLLegendElement;
  HTMLMapElement: typeof HTMLMapElement;
  HTMLMarqueeElement: typeof HTMLMarqueeElement;
  HTMLMediaElement: typeof HTMLMediaElement;
  HTMLMeterElement: typeof HTMLMeterElement;
  HTMLModElement: typeof HTMLModElement;
  HTMLOptGroupElement: typeof HTMLOptGroupElement;
  HTMLOptionElement: typeof HTMLOptionElement;
  HTMLOutputElement: typeof HTMLOutputElement;
  HTMLPictureElement: typeof HTMLPictureElement;
  HTMLProgressElement: typeof HTMLProgressElement;
  HTMLQuoteElement: typeof HTMLQuoteElement;
  HTMLScriptElement: typeof HTMLScriptElement;
  HTMLSelectElement: typeof HTMLSelectElement;
  HTMLSlotElement: typeof HTMLSlotElement;
  HTMLSourceElement: typeof HTMLSourceElement;
  HTMLSpanElement: typeof HTMLSpanElement;
  HTMLTableCaptionElement: typeof HTMLTableCaptionElement;
  HTMLTableCellElement: typeof HTMLTableCellElement;
  HTMLTableColElement: typeof HTMLTableColElement;
  HTMLTableElement: typeof HTMLTableElement;
  HTMLTimeElement: typeof HTMLTimeElement;
  HTMLTableRowElement: typeof HTMLTableRowElement;
  HTMLTableSectionElement: typeof HTMLTableSectionElement;
  HTMLTemplateElement: typeof HTMLTemplateElement;
  HTMLTextAreaElement: typeof HTMLTextAreaElement;
  HTMLUnknownElement: typeof HTMLUnknownElement;
  HTMLFrameElement: typeof HTMLFrameElement;
  HTMLFrameSetElement: typeof HTMLFrameSetElement;
  HTMLIFrameElement: typeof HTMLIFrameElement;
  HTMLEmbedElement: typeof HTMLEmbedElement;
  HTMLObjectElement: typeof HTMLObjectElement;
  HTMLParamElement: typeof HTMLParamElement;
  HTMLVideoElement: typeof HTMLVideoElement;
  HTMLAudioElement: typeof HTMLAudioElement;
  HTMLTrackElement: typeof HTMLTrackElement;

  SVGElement: typeof SVGElement;
  SVGGraphicsElement: typeof SVGGraphicsElement;
  SVGSVGElement: typeof SVGSVGElement;
  SVGTitleElement: typeof SVGTitleElement;
  SVGAnimatedString: typeof SVGAnimatedString;
  SVGNumber: typeof SVGNumber;
  SVGStringList: typeof SVGStringList;

  Event: typeof Event;
  CloseEvent: typeof CloseEvent;
  CustomEvent: typeof CustomEvent;
  MessageEvent: typeof MessageEvent;
  ErrorEvent: typeof ErrorEvent;
  HashChangeEvent: typeof HashChangeEvent;
  PopStateEvent: typeof PopStateEvent;
  StorageEvent: typeof StorageEvent;
  ProgressEvent: typeof ProgressEvent;
  PageTransitionEvent: typeof PageTransitionEvent;

  UIEvent: typeof UIEvent;
  FocusEvent: typeof FocusEvent;
  MouseEvent: typeof MouseEvent;
  KeyboardEvent: typeof KeyboardEvent;
  TouchEvent: typeof TouchEvent;
  CompositionEvent: typeof CompositionEvent;
  WheelEvent: typeof WheelEvent;

  BarProp: typeof BarProp;
  External: typeof External;
  Location: typeof Location;
  History: typeof History;
  Screen: typeof Screen;
  Performance: typeof Performance;
  Navigator: typeof Navigator;

  PluginArray: typeof PluginArray;
  MimeTypeArray: typeof MimeTypeArray;
  Plugin: typeof Plugin;
  MimeType: typeof MimeType;

  FileReader: typeof FileReader;
  Blob: typeof Blob;
  File: typeof File;
  FileList: typeof FileList;
  ValidityState: typeof ValidityState;

  DOMParser: typeof DOMParser;
  XMLSerializer: typeof XMLSerializer;

  FormData: typeof FormData;
  XMLHttpRequestEventTarget: typeof XMLHttpRequestEventTarget;
  XMLHttpRequestUpload: typeof XMLHttpRequestUpload;
  XMLHttpRequest: typeof XMLHttpRequest;
  WebSocket: typeof WebSocket;

  NodeFilter: typeof NodeFilter;
  NodeIterator: typeof NodeIterator;
  TreeWalker: typeof TreeWalker;

  AbstractRange: typeof AbstractRange;
  Range: typeof Range;
  StaticRange: typeof StaticRange;
  Selection: typeof Selection;

  Storage: typeof Storage;

  CustomElementRegistry: typeof CustomElementRegistry;
  ShadowRoot: typeof ShadowRoot;

  MutationObserver: typeof MutationObserver;
  MutationRecord: typeof MutationRecord;

  Headers: typeof Headers;
  AbortController: typeof AbortController;
  AbortSignal: typeof AbortSignal;

  /* node_modules/jsdom/level2/style.js */
  StyleSheet: typeof StyleSheet;
  MediaList: typeof MediaList;
  CSSStyleSheet: typeof CSSStyleSheet;
  CSSRule: typeof CSSRule;
  CSSStyleRule: typeof CSSStyleRule;
  CSSMediaRule: typeof CSSMediaRule;
  CSSImportRule: typeof CSSImportRule;
  CSSStyleDeclaration: typeof CSSStyleDeclaration;

  /* node_modules/jsdom/level3/xpath.js */
  // XPathException: typeof XPathException;
  XPathExpression: typeof XPathExpression;
  XPathResult: typeof XPathResult;
  XPathEvaluator: typeof XPathEvaluator;
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

/** tough-cookie's CookieJar, in loose mode as jsdom's is */
export class CookieJar extends tough.CookieJar {}
/** the tough-cookie module */
export const toughCookie: typeof tough;

export interface AbortablePromise<T> extends Promise<T> {
  abort(): void;
}

export type SupportedContentTypes = 'text/html' | 'application/xhtml+xml' | 'application/xml' | 'text/xml' | 'image/svg+xml';

/** jsdom's `requestInterceptor()` context (rsdom has no `requestInterceptor()` yet: DESIGN §31) */
export interface RequestInterceptorContext {
  element: HTMLElement | null;
}

export type RequestInterceptorCallback = (
  request: Request,
  context: RequestInterceptorContext,
) => void | undefined | Response | Promise<undefined | Response>;

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
  cookieJar?: CookieJar | undefined;
  pretendToBeVisual?: boolean | undefined;
  beforeParse?(window: DOMWindow): void;
}

export interface FileOptions extends BaseOptions {
  url?: string | undefined;
  contentType?: string | undefined;
}

export interface ConstructorOptions extends BaseOptions {
  url?: string | undefined;
  /** an HTML or XML content type (XML types parse the input as XML) */
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
  readonly cookieJar: CookieJar;

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
