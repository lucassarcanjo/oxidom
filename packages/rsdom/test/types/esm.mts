// Type-checked by test/native/types.test.mjs: an ES module consumer with named imports (they also load at runtime:
// lib/index.cjs names its exports for Node's lexer) and the Vitest `jsdom` global.
/// <reference types="jetdom/vitest-globals" />
import { JSDOM, type DOMWindow } from 'jetdom';
import JetdomEnvironment = require('jest-environment-jetdom');

const window: DOMWindow = new JSDOM('').window;
const html: string = jsdom.serialize();
// @ts-expect-error serialize() returns a string
const n: number = jsdom.serialize();

class Custom extends JetdomEnvironment.TestEnvironment {}
void [window, html, n, Custom];
