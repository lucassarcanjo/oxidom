// Test code may load the DOM library itself (a helper `new JSDOM()`, jsdom aliased to oxidom): the window the
// environment installed keeps working.
// (jsdom 30 itself cannot be required inside Jest on Node 22: an ESM dependency. The oracle run only checks the
// environment document.)
const JSDOM = process.env.JEST_DOM === 'jsdom' ? null : require('oxidom').JSDOM;

test('a JSDOM made in a test leaves the environment document alone', () => {
  document.body.innerHTML = '<p id=g>global</p>';
  if (JSDOM !== null) expect(new JSDOM('<p>helper</p>').window.document.querySelector('p').textContent).toBe('helper');
  expect(document.getElementById('g').textContent).toBe('global');
  document.body.append(document.createElement('div'));
  expect(document.body.children.length).toBe(2);
});

test('FileReader results are the test realm\'s ArrayBuffers', async () => {
  const reader = new FileReader();
  const done = new Promise((resolve) => reader.addEventListener('load', resolve));
  reader.readAsArrayBuffer(new Blob(['abc']));
  await done;
  expect(reader.result instanceof ArrayBuffer).toBe(true);
  expect([...new Uint8Array(reader.result)]).toEqual([97, 98, 99]);
});
