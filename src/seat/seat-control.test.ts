import { expect, test } from 'bun:test';
import { authorizeSeatControl, createSeatControl } from './seat-control.js';

test('same-host OP, RES-INFRA and the seat itself may request control', () => {
  expect(authorizeSeatControl({ sender: 'OP', target: 'TC', sameHost: true })).toBe(true);
  expect(authorizeSeatControl({ sender: 'RES-INFRA', target: 'TC', sameHost: true })).toBe(true);
  expect(authorizeSeatControl({ sender: 'TC', target: 'TC', sameHost: true })).toBe(true);
  expect(authorizeSeatControl({ sender: 'OTHER', target: 'TC', sameHost: true })).toBe(false);
  expect(authorizeSeatControl({ sender: 'OP', target: 'TC', sameHost: false })).toBe(false);
  expect(authorizeSeatControl({ sender: '', target: '', sameHost: true })).toBe(false);
});

test('quit waits for the turn, checkpoints, then exits', async () => {
  const actions: string[] = [];
  const control = createSeatControl({ checkpoint: async (mode) => { actions.push(`checkpoint:${mode}`); },
    exit: () => { actions.push('exit'); }, migrate: () => { actions.push('migrate'); }, abort: () => { actions.push('abort'); } });
  expect(await control.request('quit', true)).toBe('waiting');
  expect(actions).toEqual([]);
  await control.turnEnded();
  expect(actions).toEqual(['checkpoint:quit', 'exit']);
  await control.turnEnded();
  expect(actions).toEqual(['checkpoint:quit', 'exit']);
});

test('migrate hands off the same session, force aborts immediately', async () => {
  const actions: string[] = [];
  const ports = { checkpoint: async (mode: string) => { actions.push(`checkpoint:${mode}`); },
    exit: () => { actions.push('exit'); }, migrate: (session: string) => { actions.push(`migrate:${session}`); }, abort: () => { actions.push('abort'); } };
  const migrant = createSeatControl(ports);
  expect(await migrant.request('migrate', false, 'session-42')).toBe('accepted');
  expect(actions).toEqual(['checkpoint:migrate', 'migrate:session-42']);
  actions.length = 0;
  const forced = createSeatControl(ports);
  expect(await forced.request('force', true)).toBe('accepted');
  expect(actions).toEqual(['abort', 'checkpoint:force', 'exit']);
});

test('migrate without an owned session is refused', async () => {
  const actions: string[] = [];
  const control = createSeatControl({ checkpoint: async () => { actions.push('checkpoint'); },
    exit: () => { actions.push('exit'); }, migrate: () => { actions.push('migrate'); }, abort: () => { actions.push('abort'); } });
  expect(await control.request('migrate', false)).toBe('missing-session');
  expect(actions).toEqual([]);
});

test('force supersedes a pending graceful request even if checkpoint fails', async () => {
  const actions: string[] = [];
  const control = createSeatControl({ checkpoint: async () => { actions.push('checkpoint'); throw new Error('disk'); },
    exit: () => { actions.push('exit'); }, migrate: () => { actions.push('migrate'); }, abort: () => { actions.push('abort'); } });
  expect(await control.request('quit', true)).toBe('waiting');
  expect(await control.request('force', true)).toBe('accepted');
  await control.turnEnded();
  expect(actions).toEqual(['abort', 'checkpoint', 'exit']);
});

test('a failed graceful checkpoint never exits or restarts', async () => {
  const actions: string[] = [];
  const control = createSeatControl({ checkpoint: async () => { throw new Error('disk'); },
    exit: () => { actions.push('exit'); }, migrate: () => { actions.push('migrate'); }, abort: () => { actions.push('abort'); } });
  await expect(control.request('quit', false)).rejects.toThrow('disk');
  expect(actions).toEqual([]);
});

test('graceful checkpoint failure can be retried and does not execute effects', async () => {
  let attempts = 0; // 출처: #38638 counts checkpoint retries after a failure — not a bound.
  const actions: string[] = [];
  const control = createSeatControl({ checkpoint: async () => { if (++attempts === 1) throw new Error('disk'); },
    exit: () => { actions.push('exit'); }, migrate: () => { actions.push('migrate'); }, abort: () => { actions.push('abort'); } });
  await expect(control.request('quit', false)).rejects.toThrow('disk');
  expect(actions).toEqual([]);
  expect(await control.request('quit', false)).toBe('accepted');
  expect(actions).toEqual(['exit']);
});
