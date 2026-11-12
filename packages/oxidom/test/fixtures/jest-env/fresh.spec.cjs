// Every file starts from a fresh document, whatever ran before in the worker.
test('fresh document', () => {
  expect(document.body.innerHTML).toBe('');
  document.body.innerHTML = '<p id=kept>1</p>';
});
