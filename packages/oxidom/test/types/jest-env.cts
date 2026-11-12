// Type-checked by test/native/types.test.mjs: a custom Jest environment extending jest-environment-oxidom, as
// projects extend jest-environment-jsdom.
import OxidomEnvironment, { TestEnvironment } from 'jest-environment-oxidom';
import type { EnvironmentContext, JestEnvironmentConfig } from '@jest/environment';

class CustomEnvironment extends OxidomEnvironment {
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

const same: typeof OxidomEnvironment = TestEnvironment;
void [CustomEnvironment, same];
