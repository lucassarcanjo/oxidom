/**
 * @jest-environment-options {"url": "https://example.com/a?b", "html": "<!DOCTYPE html><html lang=fr><body><p>hi</p></body></html>", "userAgent": "agent/1", "pretendToBeVisual": false}
 */
test('testEnvironmentOptions', () => {
  expect([location.href, document.documentElement.lang, document.body.innerHTML, navigator.userAgent]).toEqual([
    'https://example.com/a?b',
    'fr',
    '<p>hi</p>',
    'agent/1',
  ]);
  expect([typeof requestAnimationFrame, document.hidden]).toEqual(['undefined', true]);
});
