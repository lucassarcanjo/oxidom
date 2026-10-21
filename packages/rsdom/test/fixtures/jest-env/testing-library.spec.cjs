const { screen, fireEvent, waitFor } = require('@testing-library/dom');
const userEvent = require('@testing-library/user-event').default;

test('testing-library queries, user-event and jest-dom matchers', async () => {
  document.body.innerHTML = '<label>Name <input></label><button>Save</button><output></output>';
  const out = document.querySelector('output');
  screen.getByRole('button', { name: 'Save' }).addEventListener('click', () => {
    setTimeout(() => {
      out.textContent = `saved ${screen.getByLabelText('Name').value}`;
    }, 10);
  });
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Name'), 'Ada');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(out).toHaveTextContent('saved Ada'));
  expect(screen.getByRole('button')).toBeVisible();
  fireEvent.click(screen.getByRole('button'));
});

test('fake timers drive window timers and animation frames', () => {
  jest.useFakeTimers();
  const seen = [];
  setTimeout(() => seen.push('timeout'), 100);
  requestAnimationFrame(() => seen.push('frame'));
  jest.advanceTimersByTime(100);
  expect(seen).toEqual(['frame', 'timeout']);
  jest.useRealTimers();
});
