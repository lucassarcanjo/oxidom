'use strict';
// Jest resolves `testEnvironment: 'oxidom'` to the package `jest-environment-oxidom`; the environment itself
// lives in the oxidom package, built with this package's `require` so Jest's own modules resolve from here.
const OxidomEnvironment = require('oxidom/jest-environment').environmentClass(require);

module.exports = OxidomEnvironment;
module.exports.default = OxidomEnvironment;
module.exports.TestEnvironment = OxidomEnvironment;
