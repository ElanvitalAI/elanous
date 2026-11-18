import { expect, test } from 'bun:test';
import { isPwaRoute } from './route-path';

test('route match ignores the static-export trailing slash only', () => {
  expect(isPwaRoute('/chat/', '/chat')).toBe(true);
  expect(isPwaRoute('/chat', '/chat')).toBe(true);
  expect(isPwaRoute('/chat/history/', '/chat')).toBe(false);
  expect(isPwaRoute('/chatter/', '/chat')).toBe(false);
  expect(isPwaRoute('/', '/')).toBe(true);
  expect(isPwaRoute(null, '/chat')).toBe(false);
});
