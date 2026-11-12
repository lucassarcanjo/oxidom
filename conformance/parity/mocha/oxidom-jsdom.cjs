'use strict';
// The parity suite's `jsdom` module for oxidom: jsdom's own mocha suites build documents with
// `new JSDOM(html, options)`, which is oxidom's public JSDOM class (packages/oxidom/lib/jsdom.cjs, ROADMAP Stage 2).
const path = require('node:path');

module.exports = require(path.resolve(__dirname, '../../../packages/oxidom/lib/index.cjs'));
