// AUTOPILOT-TASK-GOAL-PIN · agents — literal expectations with the real TUI queue deciding «read» (capsule result carried
// into a turn). Clock injected; capsule frames hand-built.
import { expect, test } from 'bun:test';
import type { CapsuleEvent } from '../../turn-capsule/contract.js';
import { createNextTuiQueue } from '../core/queue.js';
import { PinnedAgents } from './pinned-agents.js';

const T0 = Date.parse('2026-11-25T07:00:00.000Z');
const S = 'sess-1';
const started = (capsuleId: string, label: string, at: number): CapsuleEvent => ({ type: 'capsule-progress', capsuleId, kind: 'agent', sessionId: S, at, line: `${label} · started` });
const done = (capsuleId: string, label: string, startedAt: number, endedAt: number, status: 'ok' | 'failed' = 'ok'): CapsuleEvent => ({
  type: 'capsule-done', capsuleId, kind: 'agent', sessionId: S, startedAt, endedAt, status, summary: `${label} · ${status} · ${Math.round((endedAt - startedAt) / 1000)}s` });
const pin = { id: 'pin:a', at: T0 - 60_000, row: '📌 1/1 0.3.36 roster · done when: roster sent · due 09:00' };

test('running shows elapsed; finished-but-unread stays pinned; read collapses into the pin count', () => {
  const queue = createNextTuiQueue();
  const agents = new PinnedAgents(S);
  const consumed = (id: string) => queue.capsuleConsumed(id);
  agents.accept(started('c1', '로스터 이월 독립 검증', T0));
  agents.accept(started('c2', 'roster diff', T0 + 10_000));
  expect(agents.compose([pin], T0 + 130_000, consumed)).toEqual([
    '📌 1/1 0.3.36 roster · done when: roster sent · due 09:00',
    '   🤖 로스터 이월 독립 검증 · running 2m',
    '   🤖 roster diff · running 2m',
  ]);
  const finished = done('c1', '로스터 이월 독립 검증', T0, T0 + 59_000);
  agents.accept(finished);
  queue.enqueueCapsuleDoneNotice('capsule:c1 done', 'c1', 'ok', T0 + 59_000);
  expect(agents.compose([pin], T0 + 200_000, consumed)).toEqual([
    '📌 1/1 0.3.36 roster · done when: roster sent · due 09:00',
    '   🤖 로스터 이월 독립 검증 · done 59s · result not read yet',
    '   🤖 roster diff · running 3m',
  ]);
  // The next turn carries the result (the queue closes the capsule) → the row collapses into «🤖 1/2 read».
  expect(queue.consumeCapsuleDoneSummary()).toBe(true);
  expect(agents.compose([pin], T0 + 210_000, consumed)).toEqual([
    '📌 1/1 0.3.36 roster · done when: roster sent · due 09:00 · 🤖 1/2 read',
    '   🤖 roster diff · running 3m',
  ]);
  expect(agents.hasVisible(consumed)).toBe(true);
});

test('agents with no pin sit under one «🤖 background n» line; more than 3 sub-lines → «+n more»; a read one leaves', () => {
  const queue = createNextTuiQueue();
  const agents = new PinnedAgents(S);
  const consumed = (id: string) => queue.capsuleConsumed(id);
  for (const [i, name] of ['a1', 'a2', 'a3', 'a4', 'a5'].entries()) agents.accept(started(name, `agent ${name}`, T0 + i * 1000));
  agents.accept(done('a1', 'agent a1', T0, T0 + 30_000, 'failed'));
  expect(agents.compose([], T0 + 45_000, consumed)).toEqual([
    '🤖 background 5',
    '   🤖 agent a1 · failed 30s · result not read yet',
    '   🤖 agent a2 · running 44s',
    '   🤖 agent a3 · running 43s',
    '   +2 more',
  ]);
  queue.enqueueCapsuleDoneNotice('capsule:a1 failed', 'a1', 'failed', T0 + 30_000);
  queue.consumeCapsuleDoneSummary();
  expect(agents.compose([], T0 + 45_000, consumed)[0]).toBe('🤖 background 4');
});

test('an agent started before the pin was set is not adopted by it; a pin set earlier adopts later agents', () => {
  const agents = new PinnedAgents(S);
  const none = () => false;
  agents.accept(started('early', 'early agent', T0 - 120_000));
  agents.accept(started('late', 'late agent', T0));
  expect(agents.compose([pin], T0 + 5_000, none)).toEqual([
    '📌 1/1 0.3.36 roster · done when: roster sent · due 09:00',
    '   🤖 late agent · running 5s',
    '🤖 background 1',
    '   🤖 early agent · running 2m',
  ]);
  // Another session's frames and non-agent capsules are ignored.
  expect(agents.accept({ ...started('x', 'other', T0), sessionId: 'other' })).toBe(false);
  expect(agents.accept({ ...started('y', 'shell', T0), kind: 'shell' })).toBe(false);
});
