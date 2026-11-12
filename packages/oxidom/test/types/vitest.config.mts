// Type-checked by test/native/types.test.mjs: a Vitest config naming the environment and its options.
import env, { type OxidomEnvironmentOptions } from 'oxidom/vitest-environment';
import pkgEnv from 'vitest-environment-oxidom';

const oxidom: OxidomEnvironmentOptions = { url: 'http://localhost:3000/', html: '<div id="root"></div>', memo: true };

export default {
  test: {
    environment: 'oxidom',
    environmentOptions: { oxidom, jsdom: { url: 'http://localhost:3000/', pretendToBeVisual: true } },
  },
};

const name: string = env.name;
const same: boolean = env === pkgEnv;
// @ts-expect-error html is a string
const bad: OxidomEnvironmentOptions = { html: 1 };
void [name, same, bad];
