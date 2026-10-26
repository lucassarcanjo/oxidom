// Type-checked by test/native/types.test.mjs: a custom Jest environment extending jest-environment-nativedom, as
// projects extend jest-environment-jsdom.
import NativedomEnvironment, { TestEnvironment } from 'jest-environment-nativedom';
import type { EnvironmentContext, JestEnvironmentConfig } from '@jest/environment';

class CustomEnvironment extends NativedomEnvironment {
  constructor(config: JestEnvironmentConfig, context: EnvironmentContext) {
    super(config, context);
    this.global.myGlobal = 1;
  }

  override async setup(): Promise<void> {
    await super.setup();
    this.dom?.reconfigure({ url: 'http://localhost/next' });
    const doc: Document = this.global.document;
    void doc;
  }
}

const same: typeof NativedomEnvironment = TestEnvironment;
void [CustomEnvironment, same];
