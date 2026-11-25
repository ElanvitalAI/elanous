import { expect, test } from 'bun:test';
import { decideHandBlockPull, HAND_BLOCK_PULL_EVERY_MS } from './hand-block-pull.js';

const NOW = Date.parse('2026-11-25T10:05:00Z');
const RES = { kind: 'blocked' as const, step: 'isolation probe', reason: 'needs RES isolation approval', code: 'APPROVAL_PENDING' };

test('hand · block on another seat · no progress → one internal turn: work block then work next', () => {
  const v = decideHandBlockPull({ hand: true, stop: RES, progressed: false, now: NOW, cells: ['ISO-PROBE-1'] });
  expect(v.act).toBe(true);
  if (!v.act) return;
  expect(v.prompt).toContain('eln work block <칸> --on <기다리는 자리>');
  expect(v.prompt).toContain('eln work next');
  expect(v.prompt).toContain('ISO-PROBE-1');
  expect(v.prompt.indexOf('eln work block')).toBeLessThan(v.prompt.indexOf('eln work next'));
});

test('capped once per 10 min · not for a coordinator · not after progress · not for its own tool refusal', () => {
  expect(HAND_BLOCK_PULL_EVERY_MS).toBe(600_000);
  expect(decideHandBlockPull({ hand: true, stop: RES, progressed: false, now: NOW, lastAt: NOW - 599_000 })).toEqual({ act: false, reason: 'cap' });
  expect(decideHandBlockPull({ hand: true, stop: RES, progressed: false, now: NOW, lastAt: NOW - 600_000 }).act).toBe(true);
  expect(decideHandBlockPull({ hand: false, stop: RES, progressed: false, now: NOW })).toEqual({ act: false, reason: 'not-hand' });
  expect(decideHandBlockPull({ hand: true, stop: RES, progressed: true, now: NOW })).toEqual({ act: false, reason: 'progressed' });
  expect(decideHandBlockPull({ hand: true, stop: { ...RES, code: 'TOOL_DENIED' }, progressed: false, now: NOW })).toEqual({ act: false, reason: 'own-block' });
  expect(decideHandBlockPull({ hand: true, stop: { kind: 'waiting', step: 'decision', wake: { kind: 'message', target: 'TC' } }, progressed: false, now: NOW }).act).toBe(true);
});
