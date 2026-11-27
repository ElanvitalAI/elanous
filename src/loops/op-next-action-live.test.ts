/**
 * OP next-action live readers on temp files: land (last-tick readyNotLanded · fallback from land decisions) · bulletin
 * age · dismissed ledger · the goals actuator. No live store, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendDismissed, goalsNowPath, liveNextActuators, readBulletin, readDismissed, readLand } from './op-next-action-live.js';
import { planNextActions } from './op-next-action.js';

let dir: string;
const NOW = Date.parse('2026-11-26T12:00:00Z');
const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'op-next-live-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const land = (tick: Record<string, unknown>, rows: Array<Record<string, unknown>>) => {
  mkdirSync(join(dir, 'land-graph'), { recursive: true });
  writeFileSync(join(dir, 'land-graph', 'last-tick.json'), JSON.stringify(tick));
  writeFileSync(join(dir, 'land-graph', 'ledger.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
};

describe('readLand', () => {
  test('no last tick → unmeasured (null)', () => { expect(readLand(dir, NOW)).toBe(null); });
  test('readyNotLanded from the tick (#40264) · landed/1h ignores synthetic and old rows', () => {
    land({ mode: 'live', readyNotLanded: 4 }, [{ at: at(10), pr: 1, event: 'landed' }, { at: at(20), pr: 2, event: 'landed', synthetic: true }, { at: at(90), pr: 3, event: 'landed' }]);
    expect(readLand(dir, NOW)).toEqual({ readyToLand: 4, landedLastHour: 1, mode: 'live' });
  });
  test('fallback: latest `land` decisions without a later landed row', () => {
    land({ mode: 'live' }, [{ at: at(50), pr: 1, event: 'decision', action: 'land' }, { at: at(40), pr: 2, event: 'decision', action: 'land' }, { at: at(30), pr: 2, event: 'landed' },
      { at: at(20), pr: 3, event: 'decision', action: 'wait' }, { at: at(10), pr: 4, event: 'decision', action: 'land' }]);
    expect(readLand(dir, NOW)).toEqual({ readyToLand: 2, landedLastHour: 1, mode: 'live' });
  });
});

describe('readBulletin · dismissed · goals', () => {
  test('bulletin missing → ageMin null; present → minutes since mtime', () => {
    expect(readBulletin(dir, NOW)).toEqual({ ageMin: null });
    mkdirSync(join(dir, 'OPS'), { recursive: true });
    const p = join(dir, 'OPS', 'BULLETIN-NOW.md'); writeFileSync(p, 'x');
    utimesSync(p, new Date(NOW - 660 * 60_000), new Date(NOW - 660 * 60_000));
    expect(readBulletin(dir, NOW)).toEqual({ ageMin: 660 });
  });
  test('a dismissed directive is no longer an action', () => {
    expect(readDismissed(dir)).toEqual([]);
    appendDismissed(dir, { msgId: 41001, why: 'question, no work', by: 'OP', at: at(0) });
    const state = { now: at(0), version: '0.3.38', cells: [], hands: [], handRaises: [], land: null, releases: [], bulletin: { ageMin: 1 },
      directives: [{ msgId: 41001, crownDirective: 'c1', from: 'OP', body: 'q?', createdAt: at(5) }], dismissed: readDismissed(dir) };
    expect(readDismissed(dir)).toEqual([41001]);
    expect(planNextActions(state).actions.filter(a => a.rule === 'a')).toEqual([]);
  });
  test('goals actuator writes GOALS-NOW.md', async () => {
    const out = await liveNextActuators({ stateRoot: dir, seatState: dir }).writeGoals!(['A — done when a', 'B — done when b']);
    expect(out).toContain('2 goals');
    expect(readFileSync(goalsNowPath(dir), 'utf8')).toContain('- B — done when b');
  });
});
