'use strict';
// The rsdom Jest environment (ROADMAP Stage 2, DESIGN §32): `testEnvironment: 'jetdom'` resolves to the package
// `jest-environment-jetdom` (packages/jest-environment-rsdom), which builds its class here, passing its own
// `require` so that jest-util, jest-mock and @jest/fake-timers resolve from the Jest side.
//
// A port of jest-environment-jsdom 30 (@jest/environment-jsdom-abstract): Jest runs test files in a vm context
// (`getVmContext()`). jsdom's window is that context's global; rsdom's lives in this realm, so the environment
// creates a bare vm context and opens a browsing context on its global (lib/context.cjs, DESIGN §18), with
// window timers of its own (`ownTimers`), plus the members a jsdom window has that rsdom takes from Node
// (`NODE_GLOBALS`). `testEnvironmentOptions` are jsdom options (lib/jsdom.cjs `environmentOptions`), with
// jest-environment-jsdom's defaults: url `http://localhost/`, `<!DOCTYPE html>`, visual.
//
// Realms: DOM objects, and the arrays, promises and errors the facade makes, come from this realm, not the test
// file's. `instanceof HTMLElement` & co hold (the interface objects are installed on the context's global);
// `instanceof Array` / `toThrow(TypeError)` on something rsdom made do not. jsdom's own impl arrays have the same
// split; its WebIDL errors are the window's.
const vm = require('node:vm');

const NODE_GLOBALS = [
  'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'Headers', 'TextEncoder', 'TextDecoder', 'WebSocket',
  'Performance', 'performance', 'Crypto', 'crypto', 'queueMicrotask', 'atob', 'btoa',
];

function environmentClass(jestRequire) {
  const { installCommonGlobals } = jestRequire('jest-util');
  const { ModuleMocker } = jestRequire('jest-mock');
  const { LegacyFakeTimers, ModernFakeTimers } = jestRequire('@jest/fake-timers');
  require('./index.cjs'); // installs every area
  const context = require('./context.cjs');
  const api = require('./jsdom.cjs');

  return class JetdomEnvironment {
    customExportConditions = ['browser'];

    constructor(config, envContext) {
      const { projectConfig } = config;
      const options = projectConfig.testEnvironmentOptions;
      // jest-environment-jsdom's virtual console: the test console, jsdomErrors as the Error itself as well
      const virtualConsole = new api.VirtualConsole().forwardTo(envContext.console);
      virtualConsole.on('jsdomError', (error) => envContext.console.error(error));
      const open = api.environmentOptions({ url: 'http://localhost/', html: '<!DOCTYPE html>', ...options }, virtualConsole);

      this.context = vm.createContext();
      const global = (this.global = vm.runInContext('this', this.context));
      for (const k of NODE_GLOBALS) {
        if (globalThis[k] !== undefined) Object.defineProperty(global, k, { value: globalThis[k], writable: true, configurable: true });
      }
      this.ctx = context.open({ ...open, global, ownTimers: true });
      global.webkitURL = global.URL;
      // jest-environment-jsdom keeps its JSDOM as `this.dom` (no `jsdom` global, unlike Vitest's)
      this.dom = api.adopt(this.ctx, virtualConsole);
      global.global = global;
      global.Error.stackTraceLimit = 100;
      installCommonGlobals(global, projectConfig.globals);
      global.Buffer = Buffer;

      // jest-environment-jsdom's error routing: uncaught errors no user `error` listener saw fail the test
      let userErrorListenerCount = 0;
      this.errorEventListener = (event) => {
        if (userErrorListenerCount === 0 && event.error != null) process.emit('uncaughtException', event.error);
      };
      global.addEventListener('error', this.errorEventListener);
      const originalAddListener = global.addEventListener.bind(global);
      const originalRemoveListener = global.removeEventListener.bind(global);
      global.addEventListener = function (...args) {
        if (args[0] === 'error') userErrorListenerCount++;
        return originalAddListener.apply(this, args);
      };
      global.removeEventListener = function (...args) {
        if (args[0] === 'error') userErrorListenerCount--;
        return originalRemoveListener.apply(this, args);
      };

      if ('customExportConditions' in options) {
        const { customExportConditions } = options;
        if (!Array.isArray(customExportConditions) || !customExportConditions.every((c) => typeof c === 'string')) {
          throw new Error('Custom export conditions specified but they are not an array of strings');
        }
        this._configuredExportConditions = customExportConditions;
      }
      this.moduleMocker = new ModuleMocker(global);
      this.fakeTimers = new LegacyFakeTimers({
        config: projectConfig,
        global,
        moduleMocker: this.moduleMocker,
        timerConfig: { idToRef: (id) => id, refToId: (ref) => ref },
      });
      this.fakeTimersModern = new ModernFakeTimers({ config: projectConfig, global });
    }

    async setup() {}

    async teardown() {
      this.fakeTimers?.dispose();
      this.fakeTimersModern?.dispose();
      if (this.global !== null) {
        this.global.removeEventListener('error', this.errorEventListener);
        this.ctx.close();
      }
      // One file per environment: drop the whole DOM (lib/vitest-environment.mjs does the same)
      require('./runtime.cjs').reset();
      this.errorEventListener = null;
      this.global = null;
      this.context = null;
      this.ctx = null;
      this.dom = null;
      this.fakeTimers = null;
      this.fakeTimersModern = null;
    }

    exportConditions() {
      return this._configuredExportConditions ?? this.customExportConditions;
    }

    getVmContext() {
      return this.context;
    }
  };
}

module.exports = { environmentClass };
