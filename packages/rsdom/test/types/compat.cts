// Type-checked by test/native/types.test.mjs: nativedom values where code typed against @types/jsdom expects jsdom's.
import type * as jsdom from 'jsdom';
import { JSDOM } from 'nativedom';

function useWindow(window: jsdom.DOMWindow): Document {
  return window.document;
}
function useDom(dom: Pick<jsdom.JSDOM, 'window' | 'serialize' | 'reconfigure'>): string {
  return dom.serialize();
}

const dom = new JSDOM('<p>x</p>');
void [useWindow(dom.window), useDom(dom)];
