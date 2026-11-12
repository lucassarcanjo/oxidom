'use strict';
// jsdom's lib/jsdom/level3/xpath.js under oxidom (worker.cjs redirects it here): the same factory, from oxidom's
// vendored copy (packages/oxidom/lib/xpath.cjs, DESIGN §39), so jsdom's legacy XPath tests measure oxidom's engine.
const { vendored } = require('../../../packages/oxidom/lib/xpath.cjs');

module.exports = (core) => vendored(core);
