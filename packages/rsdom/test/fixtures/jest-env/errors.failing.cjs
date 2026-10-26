// Run on its own by test/native/jest-env.test.mjs: an error thrown by an event listener fails the test (no
// `error` listener), and not-implemented window methods log through the test console.
test('not implemented', () => {
  window.alert('x');
});

test('listener error', () => {
  const b = document.createElement('button');
  b.addEventListener('click', () => {
    throw new Error('listener boom');
  });
  b.click();
});
