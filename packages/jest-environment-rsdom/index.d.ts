// Type declarations for jest-environment-nativedom (DESIGN §32, §34), shaped like jest-environment-jsdom's. The
// module is the class itself, with `default` and `TestEnvironment` pointing at it (index.js).
import type { EnvironmentContext, JestEnvironment, JestEnvironmentConfig } from '@jest/environment';
import type { LegacyFakeTimers, ModernFakeTimers } from '@jest/fake-timers';
import type { Global } from '@jest/types';
import type { ModuleMocker } from 'jest-mock';
import type { Context } from 'node:vm';
import type { JSDOM } from 'nativedom';

/** the test files' global: the window (as jest-environment-jsdom types it) */
type Win = Window & Global.Global & { Error: { stackTraceLimit: number } };

declare class NativedomEnvironment implements JestEnvironment<number> {
  constructor(config: JestEnvironmentConfig, context: EnvironmentContext);
  /** a `JSDOM` adopting the environment's window (`reconfigure()`, `serialize()`) */
  dom: JSDOM | null;
  global: Win;
  fakeTimers: LegacyFakeTimers<number> | null;
  fakeTimersModern: ModernFakeTimers | null;
  moduleMocker: ModuleMocker | null;
  customExportConditions: string[];
  setup(): Promise<void>;
  teardown(): Promise<void>;
  exportConditions(): string[];
  getVmContext(): Context | null;
}

declare namespace NativedomEnvironment {
  export { NativedomEnvironment as default, NativedomEnvironment as TestEnvironment };
}

export = NativedomEnvironment;
