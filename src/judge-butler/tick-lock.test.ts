import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { acquireTickLock, TICK_LOCK_STALE_MS } from './tick-lock.js';

describe('BUTLER-TICK-CADENCE — one tick at a time', () => {
  test('a second tick while one runs is skipped; release frees it', () => {
    const home = mkdtempSync(join(tmpdir(), 'butler-lock-'));
    const now = new Date('2026-11-27T00:00:00Z');
    const a = acquireTickLock(home, now, { pid: 111, isAlive: () => true });
    expect(a.held).toBe(false);
    const b = acquireTickLock(home, new Date(now.getTime() + 4_000), { pid: 222, isAlive: () => true });
    expect(b).toEqual({ held: true, pid: 111, at: '2026-11-27T00:00:00.000Z' });
    if (!a.held) a.release();
    expect(existsSync(join(home, 'tick.lock'))).toBe(false);
    expect(acquireTickLock(home, now, { pid: 222, isAlive: () => true }).held).toBe(false);
  });
  test('a crashed tick (dead pid or older than the stale window) is taken over', () => {
    const home = mkdtempSync(join(tmpdir(), 'butler-lock-'));
    const now = new Date('2026-11-27T00:00:00Z');
    writeFileSync(join(home, 'tick.lock'), JSON.stringify({ pid: 333, at: now.toISOString() }));
    expect(acquireTickLock(home, now, { pid: 444, isAlive: () => false }).held).toBe(false);
    writeFileSync(join(home, 'tick.lock'), JSON.stringify({ pid: 333, at: now.toISOString() }));
    expect(acquireTickLock(home, new Date(now.getTime() + TICK_LOCK_STALE_MS + 1), { pid: 444, isAlive: () => true }).held).toBe(false);
    expect(JSON.parse(readFileSync(join(home, 'tick.lock'), 'utf8')).pid).toBe(444);
  });
  test('release never removes another tick\'s lock', () => {
    const home = mkdtempSync(join(tmpdir(), 'butler-lock-'));
    const a = acquireTickLock(home, new Date(), { pid: 1, isAlive: () => false });
    writeFileSync(join(home, 'tick.lock'), JSON.stringify({ pid: 2, at: new Date().toISOString() }));
    if (!a.held) a.release();
    expect(existsSync(join(home, 'tick.lock'))).toBe(true);
  });
  test('the trigger wakes on checklist changes and at least every 10 min', () => {
    const g = parse(readFileSync(join(import.meta.dir, '../../graphs/triggers/judge-butler.yaml'), 'utf8')) as { loop: { trigger: { condition: { predicate: { parts: Array<{ file: string }> }; max_wait_min: number; on_max_wait: string } } } };
    const c = g.loop.trigger.condition;
    expect(c.predicate.parts.map(p => p.file)).toContain('{stateRoot}/release/features.sqlite');
    expect(c.max_wait_min).toBeLessThanOrEqual(10); // 출처: 내부 문서 `LOOP-AGENT` §6 판정 집사(✋ 10분 SLA · goal.yaml hand_answer_sla_min) · #40365
    expect(c.on_max_wait).toBe('fire');
  });
});
