// Fixture for test/native/jest-env.test.mjs: the same specs under jest-environment-nativedom and under
// jest-environment-jsdom's base class on jsdom 30 (the oracle; jest-environment-jsdom itself pins jsdom 26).
// JEST_DOM=jsdom | nativedom picks the environment.
const path = require('node:path');

module.exports = {
  rootDir: __dirname,
  testMatch: ['<rootDir>/*.spec.cjs'],
  testEnvironment: process.env.JEST_DOM === 'jsdom' ? path.join(__dirname, 'jsdom30-environment.cjs') : 'nativedom',
  transform: {},
  setupFilesAfterEnv: ['@testing-library/jest-dom'],
};
