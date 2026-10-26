import { expect, test } from 'bun:test';
import { createNextSidetabHostHandler } from './nl-tool.js';
import type { SidetabRow } from './list.js';

test('NextSidetab dispatches an explicit session-switch target to the entry lifecycle', async () => {
  const row = { id: 'tui:target', label: 'target', kind: 'tui', badge: 'idle', sessionId: 'session-target' } as SidetabRow;
  let switchedSessionId: string | undefined;
  const handler = createNextSidetabHostHandler({
    rows: () => [row],
    selected: () => 0,
    switchSession: async (selected) => {
      switchedSessionId = selected.sessionId;
      return { ok: true, action: 'switch', target: selected.id };
    },
    attach: async () => ({ ok: true }),
    detach: () => ({ ok: true }),
    spawn: () => ({ ok: true }),
    kill: () => ({ ok: true }),
  });

  await expect(handler({ action: 'switch', target: 'tui:target' })).resolves.toEqual({
    ok: true, action: 'switch', target: 'tui:target',
  });
  expect(switchedSessionId).toBe('session-target');
});
