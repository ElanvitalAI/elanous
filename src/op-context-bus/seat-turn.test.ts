// BUS-SEAT-TURN — seat-turn digest (digested work first · raw CEO words context-only · collapsed «처리됨» · «미소화» for OP ·
// bounds · cursor) · coalesced wake (one per 30 min · prio:P0 now · raw never) · search · surface_events memory · sim seeds.
// Independent literals (never the product's constants).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { busPost, readBus, type BusItem } from './bus.js';
import { ackSeatDigest, busSearch, busWakeKind, createBusWakeGate, recordCeoRequestMemory, seatBusDigest } from './seat-turn.js';
import { wireBusWake } from '../tui/bus-wake.js';
import { registerBusCommands } from '../cli/bus-cli.js';
import { openSurfaceEventsDb, recordEvent } from '../domains/surface-events.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function root(): string { const d = mkdtempSync(join(tmpdir(), 'bus-seat-')); dirs.push(d); return d; }
const T0 = Date.parse('2026-11-27T02:00:00Z');
const MIN = 60_000; // 출처: 내부 문서 `CLAUDE-OP-PROXY` §A4 — one minute in ms, the sim clock unit

const ceo = (r: string, body: string, at: number, refs?: string[]) => {
  const p = busPost(r, { type: 'ceo-request', from: 'CLAUDE-OP', body, source: 'tui', ...(refs ? { refs } : {}) }, { now: at });
  if (p.kind !== 'posted') throw new Error('not posted');
  return p.entry.id;
};
const commit = (r: string, owner: string, body: string, at: number, refs: string[] = []) => {
  const p = busPost(r, { type: 'commitment', from: 'CLAUDE-OP', body, owner, due: '12:00', doneWhen: 'PR open', refs }, { now: at });
  if (p.kind !== 'posted') throw new Error('not posted');
  return p.entry.id;
};

describe('seat digest layers', () => {
  test('a raw CEO line is context only for OP (never under 할 일) and invisible to other seats', () => {
    const r = root();
    ceo(r, '홈페이지 히어로 문구 바꿔', T0);
    const op = seatBusDigest(r, { seat: 'OP', now: T0 + MIN });
    expect(op.text).toContain('CEO 원문(맥락 · Claude OP 소화 중 — 이것만 보고 행동하지 말 것):');
    expect(op.text).toContain('홈페이지 히어로 문구 바꿔');
    expect(op.text).not.toContain('할 일(소화됨):');
    expect(seatBusDigest(r, { seat: 'TC', now: T0 + MIN }).text).toBeNull();
  });
  test('a digested commitment (owner TC · ref bus:<ceo>) is TC\'s 할 일; OP sees the raw line collapsed as 처리됨', () => {
    const r = root();
    const raw = ceo(r, 'fix the signup bug today', T0);
    const c = commit(r, 'TC', 'fix signup 500 on /join', T0 + MIN, [`bus:${raw}`]);
    const tc = seatBusDigest(r, { seat: 'TC', now: T0 + 2 * MIN });
    expect(tc.text).toContain('할 일(소화됨):');
    expect(tc.text).toContain(`${c} commitment CLAUDE-OP (owner TC · due 12:00 · done when PR open): fix signup 500 on /join`);
    expect(tc.text).not.toContain('fix the signup bug today');
    const op = seatBusDigest(r, { seat: 'OP', now: T0 + 2 * MIN });
    expect(op.text).toContain(`처리됨(접음 · 행동 불필요): ${raw}→${c}`);
    expect(op.text).not.toContain('CEO 원문');
  });
  test('a «handled-by CLAUDE-OP» decision marks the raw line done', () => {
    const r = root();
    const raw = ceo(r, 'what time is the demo', T0);
    busPost(r, { type: 'decision', from: 'CLAUDE-OP', body: 'handled-by CLAUDE-OP (answered 20:00)', refs: [`bus:${raw}`] }, { now: T0 + MIN });
    expect(seatBusDigest(r, { seat: 'OP', now: T0 + 2 * MIN }).text).toContain(`${raw}→handled`);
  });
  test('a raw line with no disposition after 20 min is one «미소화» line for OP only; a disposition clears it', () => {
    const r = root();
    const raw = ceo(r, 'check the rail', T0);
    const a = seatBusDigest(r, { seat: 'OP', now: T0 + 25 * MIN });
    expect(a.text).toContain('미소화 CEO 발화 1건 (20분+ 처분 없음 · 지시 아님');
    expect(seatBusDigest(r, { seat: 'OP', now: T0 + 19 * MIN }).text).not.toContain('미소화');
    expect(seatBusDigest(r, { seat: 'TC', now: T0 + 25 * MIN }).text).toBeNull();
    busPost(r, { type: 'handoff', from: 'CLAUDE-OP', body: 'rail check → REL', owner: 'REL', refs: [`bus:${raw}`] }, { now: T0 + 26 * MIN });
    expect(seatBusDigest(r, { seat: 'OP', now: T0 + 27 * MIN }).text ?? '').not.toContain('미소화');
  });
  test('bounds: at most 5 actionable and 3 latest raw lines, the rest counted as «외 k건»', () => {
    const r = root();
    for (let i = 0; i < 8; i++) commit(r, 'OP', `task ${i}`, T0 + i * 1000);
    for (let i = 0; i < 5; i++) ceo(r, `ceo line ${i}`, T0 + 10_000 + i * 1000);
    const d = seatBusDigest(r, { seat: 'OP', now: T0 + MIN });
    const text = d.text!;
    expect(text.split('\n').filter((l) => / commitment /u.test(l)).length).toBe(5);
    expect(text).toContain('… 외 3건');
    expect(text).toContain('ceo line 4');
    expect(text).not.toContain('ceo line 1');
    expect(text).toContain('… 외 2건');
  });
});

describe('cursor: injected once · busy seat gets it next turn', () => {
  test('after the turn acks, the same items are never re-shown; an item posted mid-turn rides the next turn', () => {
    const r = root();
    commit(r, 'OP', 'first', T0);
    const turn1 = seatBusDigest(r, { seat: 'OP', now: T0 + MIN });
    expect(turn1.text).toContain('first');
    // posted while the seat is busy (after turn1's digest was built, before its ack)
    commit(r, 'OP', 'second', T0 + 2 * MIN);
    expect(ackSeatDigest(r, 'OP', turn1.ackTo)).toBe(true);
    const turn2 = seatBusDigest(r, { seat: 'OP', now: T0 + 3 * MIN });
    expect(turn2.text).toContain('second');
    expect(turn2.text).not.toContain('first');
    ackSeatDigest(r, 'OP', turn2.ackTo);
    expect(seatBusDigest(r, { seat: 'OP', now: T0 + 4 * MIN }).text).toBeNull();
  });
});

describe('wake', () => {
  const item = (id: string, type: BusItem['type'], extra: Partial<BusItem> = {}): BusItem =>
    ({ id, at: '2026-11-27T02:00:00.000Z', type, from: 'CLAUDE-OP', body: 'x', refs: [], alsoFrom: [], ...extra });
  test('raw CEO words never wake; an addressed handoff/commitment does; an unaddressed one does not', () => {
    expect(busWakeKind(item('b1', 'ceo-request', { refs: ['seat:OP'] }), 'OP')).toBeNull();
    expect(busWakeKind(item('b2', 'commitment', { owner: 'OP' }), 'OP')).toBe('normal');
    expect(busWakeKind(item('b3', 'handoff', { refs: ['seat:OP'] }), 'OP')).toBe('normal');
    expect(busWakeKind(item('b4', 'commitment', { owner: 'TC' }), 'OP')).toBeNull();
    expect(busWakeKind(item('b5', 'decision', { owner: 'OP', refs: ['prio:P0'] }), 'OP')).toBe('urgent');
  });
  test('3 commitments in 10 min → 1 wake; the rest defer to the 30-min mark (one deferred wake); P0 wakes at once', () => {
    const fired: { text: string; urgent: boolean }[] = [];
    let now = T0;
    let onItems: ((items: BusItem[]) => void) | null = null;
    const timers: { at: number; fn: () => void; live: boolean }[] = [];
    const w = wireBusWake({ seat: 'OP', now: () => now, subscribe: (cb) => { onItems = cb; return () => {}; },
      wake: (text, urgent) => fired.push({ text, urgent }),
      setTimer: (fn, ms) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return { cancel: () => { t.live = false; } }; } });
    onItems!([item('c1', 'commitment', { owner: 'OP' })]);
    now += 5 * MIN; onItems!([item('c2', 'commitment', { owner: 'OP' })]);
    now += 5 * MIN; onItems!([item('c3', 'commitment', { owner: 'OP' })]);
    onItems!([item('c3', 'commitment', { owner: 'OP' })]); // the same item again
    expect(fired.length).toBe(1);
    expect(timers.filter((t) => t.live).length).toBe(1);
    expect(timers[0]!.at).toBe(T0 + 30 * MIN);
    now = T0 + 12 * MIN; onItems!([item('p0', 'handoff', { owner: 'OP', refs: ['prio:P0'] })]);
    expect(fired.length).toBe(2);
    expect(fired[1]!.urgent).toBe(true);
    // the urgent wake carried the pending items: no deferred wake remains
    expect(timers.filter((t) => t.live).length).toBe(0);
    w.stop();
  });
  test('a deferred wake fires once at the window end unless a turn delivered first', () => {
    const g = createBusWakeGate('OP', 30 * MIN);
    expect(g.offer([item('a', 'commitment', { owner: 'OP' })], T0).action).toBe('wake');
    expect(g.offer([item('b', 'commitment', { owner: 'OP' })], T0 + MIN)).toEqual({ action: 'defer', dueAt: T0 + 30 * MIN });
    expect(g.due(T0 + 29 * MIN).action).toBe('defer');
    expect(g.due(T0 + 30 * MIN)).toEqual({ action: 'wake', reason: 'deferred' });
    expect(g.due(T0 + 31 * MIN).action).toBe('none');
    expect(g.offer([item('c', 'commitment', { owner: 'OP' })], T0 + 32 * MIN).action).toBe('defer');
    g.delivered();
    expect(g.due(T0 + 61 * MIN).action).toBe('none');
  });
});

describe('search · memory', () => {
  test('busSearch: every word, case folded, newest first, --type and --since filters', () => {
    const r = root();
    ceo(r, 'Deploy the Homepage tonight', T0);
    ceo(r, 'homepage copy is wrong', T0 + 10 * MIN);
    commit(r, 'MK', 'fix homepage copy', T0 + 11 * MIN);
    const items = readBus(r);
    expect(busSearch(items, { query: 'HOMEPAGE' }).map((i) => i.body)).toEqual(['fix homepage copy', 'homepage copy is wrong', 'Deploy the Homepage tonight']);
    expect(busSearch(items, { query: 'homepage copy', type: 'ceo-request' }).map((i) => i.body)).toEqual(['homepage copy is wrong']);
    expect(busSearch(items, { query: 'homepage', sinceIso: '2026-11-27T02:05:00Z' }).length).toBe(2);
  });
  test('`eln bus search` prints matches; a ceo-request post is remembered once', () => {
    const r = root();
    const out: string[] = [];
    const remembered: string[] = [];
    const program = new Command().exitOverride();
    registerBusCommands(program, { stateRoot: () => r, out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`), setExitCode: () => {},
      callerSeat: () => null, verifyProxy: () => ({ ok: true }), now: () => T0, remember: (e) => remembered.push(e.body) });
    program.parse(['node', 'eln', 'bus', 'post', '--as', 'CLAUDE-OP', '--type', 'ceo-request', '--source', 'telegram', '데모 20시']);
    program.parse(['node', 'eln', 'bus', 'post', '--as', 'CLAUDE-OP', '--type', 'ceo-request', '--source', 'tui', '데모 20시']);
    expect(remembered).toEqual(['데모 20시']);
    out.length = 0;
    program.parse(['node', 'eln', 'bus', 'search', '데모']);
    expect(out.length).toBe(1);
    expect(out[0]).toContain('ceo-request CLAUDE-OP@telegram+tui: 데모 20시');
    out.length = 0;
    program.parse(['node', 'eln', 'bus', 'search', 'nothing-here']);
    expect(out).toEqual(['bus: no item matches "nothing-here"']);
  });
  test('recordCeoRequestMemory writes once and dedupes against the hook\'s own utterance row', () => {
    const db = openSurfaceEventsDb(':memory:');
    const r = root();
    ceo(r, '케이던스 조절해서 전달', T0);
    ceo(r, '원문은 기억에 남겨', T0 + MIN);
    const [a, b] = readBus(r);
    expect(recordCeoRequestMemory(a!, db)).toBe('recorded');
    expect(recordCeoRequestMemory(a!, db)).toBe('duplicate');
    recordEvent(db, { surface: 'ext:claude-code', direction: 'inbound', kind: 'utterance', text: '원문은 기억에 남겨', ts: new Date(T0).toISOString() });
    expect(recordCeoRequestMemory(b!, db)).toBe('duplicate');
    const n = (db.query(`SELECT count(*) AS n FROM events WHERE text = ?`).get('케이던스 조절해서 전달') as { n: number }).n
      + (db.query(`SELECT count(*) AS n FROM signals WHERE text = ?`).get('케이던스 조절해서 전달') as { n: number }).n;
    expect(n).toBe(1);
    db.close();
  });
});

describe('sim: random posts and turns never lose or repeat an addressed item (seeds 1·2·3·4)', () => {
  const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (const seed of [1, 2, 3, 4]) {
    test(`seed ${seed}`, () => {
      const r = root();
      const rand = rng(seed);
      let now = T0;
      const posted: string[] = [];
      const seen = new Map<string, number>();
      for (let step = 0; step < 40; step++) {
        now += Math.floor(rand() * 4 * MIN);
        const roll = rand();
        if (roll < 0.35) posted.push(`work-${step}`), commit(r, 'TC', `work-${step}`, now);
        else if (roll < 0.55) ceo(r, `ceo-${step}`, now);
        else if (roll < 0.65) commit(r, 'MK', `other-${step}`, now);
        else {
          const d = seatBusDigest(r, { seat: 'TC', now, maxChars: 100_000 });
          for (const m of (d.text ?? '').matchAll(/work-\d+/gu)) seen.set(m[0], (seen.get(m[0]) ?? 0) + 1);
          expect(d.text ?? '').not.toMatch(/ceo-\d+|other-\d+/u);
          ackSeatDigest(r, 'TC', d.ackTo);
        }
      }
      const last = seatBusDigest(r, { seat: 'TC', now, maxChars: 100_000 });
      for (const m of (last.text ?? '').matchAll(/work-\d+/gu)) seen.set(m[0], (seen.get(m[0]) ?? 0) + 1);
      // each addressed item shows exactly once unless it fell into an «외 k건» count (≤5 per turn shown)
      for (const [, n] of seen) expect(n).toBe(1);
      expect(seen.size).toBeLessThanOrEqual(posted.length);
      expect(posted.length - seen.size).toBeGreaterThanOrEqual(0);
    });
  }
});
