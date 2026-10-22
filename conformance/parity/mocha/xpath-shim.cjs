'use strict';
// jsdom's lib/jsdom/level3/xpath.js under rsdom (worker.cjs redirects it here): the same factory, from rsdom's
// vendored copy (packages/rsdom/lib/xpath.cjs, DESIGN §39), so jsdom's legacy XPath tests measure rsdom's engine.
const { vendored } = require('../../../packages/rsdom/lib/xpath.cjs');

module.exports = (core) => vendored(core);
