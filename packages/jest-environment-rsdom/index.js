'use strict';
// Jest resolves `testEnvironment: 'jetdom'` to the package `jest-environment-jetdom`; the environment itself
// lives in the jetdom package, built with this package's `require` so Jest's own modules resolve from here.
const JetdomEnvironment = require('jetdom/jest-environment').environmentClass(require);

module.exports = JetdomEnvironment;
module.exports.default = JetdomEnvironment;
module.exports.TestEnvironment = JetdomEnvironment;
