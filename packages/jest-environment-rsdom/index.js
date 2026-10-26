'use strict';
// Jest resolves `testEnvironment: 'nativedom'` to the package `jest-environment-nativedom`; the environment itself
// lives in the nativedom package, built with this package's `require` so Jest's own modules resolve from here.
const NativedomEnvironment = require('nativedom/jest-environment').environmentClass(require);

module.exports = NativedomEnvironment;
module.exports.default = NativedomEnvironment;
module.exports.TestEnvironment = NativedomEnvironment;
