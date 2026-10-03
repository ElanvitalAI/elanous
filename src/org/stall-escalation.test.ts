import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Checklist, ChecklistItem } from '../release-loop/checklist.js';
import { buildUserConfig } from '../user-config.js';
import { findStalls } from './stall-escalation.js';

const now = new Date('2026-10-03T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
const item = (id: string, status: ChecklistItem['status'], owner: string, minutesAgo: number, disposition?: ChecklistItem['disposition']): ChecklistItem =>
  ({ id, title: id, status, owner, updatedAt: at(minutesAgo), updatedBy: owner, ...(disposition ? { disposition } : {}) });
const checklist = (items: ChecklistItem[], history: Checklist['history'] = []): Checklist =>
  ({ version: '0.2.8', released: '0.2.7', dev: '0.2.8', items, history });
const event = (id: string, field: string, from: unknown, to: unknown, minutesAgo: number): Checklist['history'][number] =>
  ({ id, field, from, to, at: at(minutesAgo), by: 'test', released: '0.2.7', dev: '0.2.8' });

describe('findStalls', () => {
  test('routes red and blocked items to their parent at their independent default limits', () => {
    const cells = checklist([
      item('red', 'red', 'MK', 30),
      item('blocked', 'yellow', 'UX', 60, 'block'),
      item('too-early-red', 'red', 'TC', 29),
      item('too-early-block', 'yellow', 'TC', 59, 'block'),
      item('ordinary-yellow', 'yellow', 'TC', 120),
      item('finished', 'done', 'MK', 120),
      item('root', 'red', 'OP', 120),
    ]);
    expect(findStalls(cells, { mode: 'on' }, now).map(({ item, from, to, reason, stalledMin }) =>
      ({ id: item.id, from, to, reason, stalledMin }))).toEqual([
      { id: 'red', from: 'MK', to: 'OP', reason: 'red', stalledMin: 30 },
      { id: 'blocked', from: 'UX', to: 'OP', reason: 'blocked', stalledMin: 60 },
    ]);
  });

  test('uses configured parents and limits loaded from user config, including sub-seat owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stall-escalation-'));
    const configPath = join(dir, 'config.json');
    try {
      writeFileSync(configPath, JSON.stringify({ loops: { seat: {
        mode: 'shadow', stall: { parents: { TC: 'UX' }, redMinutes: 5, blockedMinutes: 10 },
      } } }));
      const config = buildUserConfig(configPath).loops!.seat!;
      expect(config.stall).toEqual({ parents: { TC: 'UX' }, redMinutes: 5, blockedMinutes: 10 });
      expect(findStalls(checklist([item('tc-red', 'red', 'TC/rel', 5), item('tc-block', 'yellow', 'TC', 9, 'block')]), config, now)
        .map(({ item, from, to }) => ({ id: item.id, from, to }))).toEqual([{ id: 'tc-red', from: 'TC', to: 'UX' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('measures the current stall from status/disposition transitions, not later evidence edits', () => {
    const cells = checklist([
      item('red', 'red', 'MK', 1), item('blocked', 'yellow', 'TC', 1, 'block'),
      item('new-block', 'yellow', 'UX', 100, 'block'),
    ], [
      event('red', 'status', 'yellow', 'red', 40),
      event('red', 'evidence', null, 'new evidence', 1),
      event('blocked', 'status', 'green', 'yellow', 100),
      event('blocked', 'disposition', null, 'block', 70),
      event('blocked', 'evidence', null, 'new evidence', 1),
      event('new-block', 'disposition', null, 'block', 2),
    ]);
    expect(findStalls(cells, { mode: 'shadow' }, now).map(({ item, stalledMin, startedAt }) => ({ id: item.id, stalledMin, startedAt })))
      .toEqual([{ id: 'red', stalledMin: 40, startedAt: at(40) }, { id: 'blocked', stalledMin: 70, startedAt: at(70) }]);
    expect(findStalls(cells, { mode: 'shadow' }, new Date(now.getTime() + 30_000)).map(({ startedAt }) => startedAt))
      .toEqual([at(40), at(70)]);
  });

  test('starts a new interval after recovery and ignores an older red episode', () => {
    const cells = checklist([item('twice', 'red', 'MK', 1)], [
      event('twice', 'status', 'yellow', 'red', 90),
      event('twice', 'status', 'red', 'green', 40),
      event('twice', 'status', 'green', 'red', 10),
    ]);
    expect(findStalls(cells, { mode: 'on' }, now)).toEqual([]);
  });

  test('skips unknown owner, missing timestamp and future timestamp', () => {
    const cells = checklist([
      item('unassigned', 'red', '', 200), item('future', 'red', 'MK', -1),
      { ...item('invalid', 'red', 'MK', 200), updatedAt: 'invalid' },
    ]);
    expect(findStalls(cells, { mode: 'on' }, now)).toEqual([]);
  });
});
