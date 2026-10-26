// Type-checked by test/native/types.test.mjs: a Vitest config naming the environment and its options.
import env, { type NativedomEnvironmentOptions } from 'nativedom/vitest-environment';
import pkgEnv from 'vitest-environment-nativedom';

const nativedom: NativedomEnvironmentOptions = { url: 'http://localhost:3000/', html: '<div id="root"></div>', memo: true };

export default {
  test: {
    environment: 'nativedom',
    environmentOptions: { nativedom, jsdom: { url: 'http://localhost:3000/', pretendToBeVisual: true } },
  },
};

const name: string = env.name;
const same: boolean = env === pkgEnv;
// @ts-expect-error html is a string
const bad: NativedomEnvironmentOptions = { html: 1 };
void [name, same, bad];
