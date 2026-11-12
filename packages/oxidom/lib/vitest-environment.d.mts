// Type declarations for `oxidom/vitest-environment` (DESIGN §34): the Vitest environment and its options.
import type { Environment } from 'vitest/runtime';

/** `test.environmentOptions.oxidom` (DESIGN §12, §31); these keys win over `environmentOptions.jsdom`'s. */
export interface OxidomEnvironmentOptions {
  /** the document URL (default `http://localhost:3000/`) */
  url?: string | undefined;
  /** body markup, set as `documentElement.innerHTML` */
  html?: string | undefined;
  /** false: the crossing-getter fallback (`OXIDOM_SHARED=0`) */
  shared?: boolean | undefined;
  /** false: no JS-side memoisation (`OXIDOM_NO_MEMO=1`) */
  memo?: boolean | undefined;
  /** false: no selector prefilter (`OXIDOM_NO_PREFILTER=1`) */
  prefilter?: boolean | undefined;
  /** true: the counters build (`OXIDOM_COUNTERS=1`) */
  counters?: boolean | undefined;
}

/**
 * The environment: `setup()` installs the window on the worker's global, `setupVM()` (VM pools) on a vm
 * context. It reads `environmentOptions.jsdom` as Vitest's jsdom environment does, then `environmentOptions.oxidom`.
 */
declare const environment: Environment;
export default environment;
