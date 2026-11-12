// Type-checked by test/native/types.test.mjs: an ES module consumer with named imports (they also load at runtime:
// lib/index.cjs names its exports for Node's lexer) and the Vitest `jsdom` global.
/// <reference types="oxidom/vitest-globals" />
import { JSDOM, type DOMWindow } from 'oxidom';
import OxidomEnvironment = require('jest-environment-oxidom');

const window: DOMWindow = new JSDOM('').window;
const html: string = jsdom.serialize();
// @ts-expect-error serialize() returns a string
const n: number = jsdom.serialize();

class Custom extends OxidomEnvironment.TestEnvironment {}
void [window, html, n, Custom];
