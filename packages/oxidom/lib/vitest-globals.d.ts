// `types: ["oxidom/vitest-globals"]` (DESIGN §34): the `jsdom` global the Vitest environment installs, typed as
// `vitest/jsdom` types it for Vitest's jsdom environment.
import type { JSDOM } from './index.js';

declare global {
  const jsdom: JSDOM;
}

export {};
