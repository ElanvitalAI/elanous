import { expect, test } from 'bun:test';
import { carrySessionProvider } from './new-session.js';
import { clearSessionProvider, getSessionProvider, parseSessionProvider, setSessionProvider } from '../../tui-client/session-provider.js';

test('/new carries the session provider/model to the new session and leaves the old one intact', async () => {
  const from = 'carry-from-session'; const to = 'carry-to-session';
  try {
    setSessionProvider(from, parseSessionProvider('glm', 'glm-5'));
    expect(await carrySessionProvider(from, to)).toBe('glm/glm-5');
    expect(getSessionProvider(to)).toEqual({ provider: 'glm', model: 'glm-5' });
    expect(getSessionProvider(from)).toEqual({ provider: 'glm', model: 'glm-5' });
  } finally { clearSessionProvider(from); clearSessionProvider(to); }
});

test('no selection on the old session means nothing is invented for the new one', async () => {
  expect(await carrySessionProvider('no-selection-session', 'new-id')).toBeNull();
  expect(getSessionProvider('new-id')).toBeUndefined();
  expect(await carrySessionProvider(null, 'x')).toBeNull();
  expect(await carrySessionProvider('same', 'same')).toBeNull();
});
