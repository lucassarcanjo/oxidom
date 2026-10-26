// Type-checked by test/native/types.test.mjs: a Vitest config naming the environment and its options.
import env, { type JetdomEnvironmentOptions } from 'jetdom/vitest-environment';
import pkgEnv from 'vitest-environment-jetdom';

const jetdom: JetdomEnvironmentOptions = { url: 'http://localhost:3000/', html: '<div id="root"></div>', memo: true };

export default {
  test: {
    environment: 'jetdom',
    environmentOptions: { jetdom, jsdom: { url: 'http://localhost:3000/', pretendToBeVisual: true } },
  },
};

const name: string = env.name;
const same: boolean = env === pkgEnv;
// @ts-expect-error html is a string
const bad: JetdomEnvironmentOptions = { html: 1 };
void [name, same, bad];
