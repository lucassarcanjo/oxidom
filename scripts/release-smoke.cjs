'use strict';
// Release smoke test (.github/workflows/release.yml): loads the addon through the published entry point and
// runs a parse + selector round trip. Usage: node scripts/release-smoke.cjs <package dir | package name>
const path = require('node:path');

const arg = process.argv[2];
const id = arg.startsWith('.') || arg.includes('/') ? path.resolve(arg) : require.resolve(arg, { paths: [process.cwd()] });
const { createWindow } = require(id);

const { document } = createWindow({ url: 'https://example.test/a?b=1' });
document.body.innerHTML = '<ul><li class="x">one</li><li class="x">two</li></ul>';
const got = [...document.querySelectorAll('li.x')].map((li) => li.textContent).join(',') + ' ' + document.location.search;
if (got !== 'one,two ?b=1') {
  console.error(`release smoke: expected "one,two ?b=1", got "${got}"`);
  process.exit(1);
}
console.log(`release smoke: ok (${process.platform}-${process.arch}, ${id})`);
