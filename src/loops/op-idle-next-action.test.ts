// OP-NEXT-BEST-ACTION idle half — the drive prefix: OP only, fast actuators only, timeout and failure → no prefix.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idleNextActionPrefix } from './op-idle-next-action.js';
import type { NextActionState } from './op-next-action.js';

const NOW = new Date('2026-11-26T12:00:00Z');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'op-idle-next-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const world = (): NextActionState => ({ now: NOW.toISOString(), version: '0.3.38', released: '0.3.37',
  cells: [{ id: 'R1', title: 'ready', status: 'yellow', priority: 'P0', doneCriterion: 'x', updatedAt: NOW.toISOString() }],
  hands: [{ seat: 'TC-H1', home: 'TC', state: 'idle', since: NOW.getTime() - 20 * 60_000 }],
  directives: [], handRaises: [], land: { readyToLand: 4, landedLastHour: 0, mode: 'live' }, releases: [], bulletin: { ageMin: 5 } });

describe('idleNextActionPrefix', () => {
  test('OP: hints ⊕ wakes in-process, leaves the land tick to the turn, writes an idle ledger line', async () => {
    const calls: string[] = [];
    const pre = await idleNextActionPrefix('OP', { roots: { stateRoot: dir, seatState: dir }, now: () => NOW, state: async () => world(),
      actuators: { hint: (e) => { calls.push(...e.map(x => `hint ${x.cell}→${x.seat}`)); return 'hints 1'; }, wake: (s) => { calls.push(`wake ${s}`); return 'mail #1'; }, landTick: () => { calls.push('land'); return 'x'; }, writeGoals: () => 'g' } });
    expect(calls).toEqual(['hint R1→TC-H1', 'wake TC-H1']);
    expect(pre).toContain('[OP idle · next-action planner]');
    expect(pre).toContain('did (b) prioritize R1 for TC-H1 (pull)');
    expect(pre).toContain('NEXT ACTION (do it) — (d) outcome alarm + one land-graph tick (4 ready, 0 landed)');
    expect(pre).toContain('$ eln land graph tick --json');
    expect(readFileSync(join(dir, 'loops', 'op-next-action.jsonl'), 'utf8')).toContain('"window":"idle:2026-11-26T12:00:00.000Z"');
  });
  test('not OP → null without reading state', async () => {
    expect(await idleNextActionPrefix('TC', { state: async () => { throw new Error('must not read'); } })).toBe(null);
    expect(await idleNextActionPrefix(null)).toBe(null);
  });
  test('slow snapshot → null at the timeout; a throwing snapshot → null and an error ledger line', async () => {
    const slow = await idleNextActionPrefix('OP', { roots: { stateRoot: dir, seatState: dir }, now: () => NOW, timeoutMs: 20, actuators: {},
      state: () => new Promise(() => { /* never resolves */ }) });
    expect(slow).toBe(null);
    const bad = await idleNextActionPrefix('OP', { roots: { stateRoot: dir, seatState: dir }, now: () => NOW, actuators: {}, state: async () => { throw new Error('store locked'); } });
    expect(bad).toBe(null);
    expect(readFileSync(join(dir, 'loops', 'op-next-action.jsonl'), 'utf8')).toContain('"error":"store locked"');
  });
});
