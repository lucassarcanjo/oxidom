// Type-checked by test/native/types.test.mjs: a custom Jest environment extending jest-environment-jetdom, as
// projects extend jest-environment-jsdom.
import JetdomEnvironment, { TestEnvironment } from 'jest-environment-jetdom';
import type { EnvironmentContext, JestEnvironmentConfig } from '@jest/environment';

class CustomEnvironment extends JetdomEnvironment {
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

const same: typeof JetdomEnvironment = TestEnvironment;
void [CustomEnvironment, same];
