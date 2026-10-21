'use strict';
// The parity suite's `jsdom` module for rsdom: jsdom's own mocha suites build documents with
// `new JSDOM(html, options)`, which is rsdom's public JSDOM class (packages/rsdom/lib/jsdom.cjs, ROADMAP Stage 2).
const path = require('node:path');

module.exports = require(path.resolve(__dirname, '../../../packages/rsdom/lib/index.cjs'));
