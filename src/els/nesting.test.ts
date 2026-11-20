import { expect, test } from 'bun:test';
import { insideElsPane } from './nesting.js';

test('inside an els pane = the environment names THIS server\'s socket; anything else is the outermost frame', () => {
  const socket = '/home/u/.elanous/els/els.sock';
  const table: [string, Record<string, string | undefined>, boolean][] = [
    ['no variable (ssh login, plain terminal)', {}, false],
    ['empty', { ELANOUS_ELS_SOCKET: '' }, false],
    ['this server', { ELANOUS_ELS_SOCKET: socket }, true],
    ['another state dir\'s server', { ELANOUS_ELS_SOCKET: '/tmp/other/els/els.sock' }, false],
    ['same path with a trailing space', { ELANOUS_ELS_SOCKET: `${socket} ` }, false],
  ];
  for (const [label, env, expected] of table) expect([label, insideElsPane(env, socket)]).toEqual([label, expected]);
});

import { elnSidetabPlacement, handOffToEls, NESTED_ELS_MESSAGE, type ElsHandoffDeps } from './nesting.js';

test('rule 1: the pane variable decides where the sidetab is drawn', () => {
  expect(elnSidetabPlacement({ ELANOUS_ELS_PANE: 'p3' })).toBe('inside-pane');
  expect(elnSidetabPlacement({ ELANOUS_ELS_PANE: '' })).toBe('bare');
  expect(elnSidetabPlacement({})).toBe('bare');
});

function handoff(over: Partial<ElsHandoffDeps> & { made?: number; outer?: boolean }) {
  const calls: string[] = [];
  const deps: ElsHandoffDeps = {
    env: {}, sessionId: 's-123', cwd: '/work', ws: 'OP',
    request: async (req) => { calls.push(`new ${req.ws} ${req.cwd} ${req.command.join(' ')}`); return { exitCode: over.made ?? 0, message: over.made ? 'boom' : 'ok' }; },
    launchOuter: async () => { calls.push('outer'); return over.outer ?? true; },
    ...over,
  };
  return { calls, run: () => handOffToEls(deps) };
}

test('rule 3: bare eln hands the SAME session id to a new pane, then launches the outer els', async () => {
  const h = handoff({});
  const r = await h.run();
  expect(r.kind).toBe('handed-off');
  expect(h.calls).toEqual(['new OP /work eln --resume s-123', 'outer']);
});

test('rule 3: a failed pane keeps the session in place and never launches the frame', async () => {
  const h = handoff({ made: 1 });
  expect(await h.run()).toEqual({ kind: 'failed', message: 'els: 세션을 패널로 옮기지 못했습니다 — boom' });
  expect(h.calls).toEqual(['new OP /work eln --resume s-123']);
});

test('rule 3: outer frame failure is reported, pane stays listed', async () => {
  const r = await handoff({ outer: false }).run();
  expect(r.kind).toBe('failed');
  expect(r.message).toContain('els --list');
});

test('rule 3: inside an els pane there is no outer frame to add — says why, touches nothing', async () => {
  const h = handoff({ env: { ELANOUS_ELS_PANE: 'p1' } });
  expect(await h.run()).toEqual({ kind: 'not-bare', message: NESTED_ELS_MESSAGE });
  expect(h.calls).toEqual([]);
});
