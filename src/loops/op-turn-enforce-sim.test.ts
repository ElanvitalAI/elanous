/**
 * SIM — turn-end enforcement (CEO 11-26 21:5x «구조적 문제도 고쳐주세요» item 1). Today's shape on build 2126: an OP
 * pulse/idle turn opened with NEXT ACTION (land tick pending · bulletin stale · a directive to register), OP mailed
 * requests and ended «21:57에 확인» — zero state change. Seeds 1–5 vary the ready-to-land count, the bulletin age, the
 * number of request mails and the promise wording. Each run: the engine does the machine action itself, the OP action
 * leads the next plan as FORCED, the retro counts a no-op turn; a turn that did change state is left alone.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planNextActions, renderNextActionBlock, executeNextActions, type NextActionState } from './op-next-action.js';
import { enforceRetroLines, promiseOnly, readForced } from './op-turn-enforce.js';
import { runTurnEnforce } from './op-turn-enforce-run.js';
import { appendPulseLedger } from './op-pulse.js';

const START = new Date('2026-11-26T12:55:00.000Z'); // 21:55 KST — the turn opens
const END = new Date('2026-11-26T12:58:00.000Z');
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'op-enforce-')); mkdirSync(join(dir, 'fed-state'), { recursive: true }); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

class World {
  land = { readyToLand: 0, landedLastHour: 0, mode: 'live' as string };
  bulletinAge = 0; forced: NextActionState['forced'] = [];
  constructor(ready: number, age: number) { this.land.readyToLand = ready; this.bulletinAge = age; }
  state(now: Date): NextActionState {
    return { now: now.toISOString(), version: '0.3.38', released: '0.3.37', cells: [{ id: 'A', title: 'a', status: 'yellow', priority: 'P1', owner: 'TC-H1', doneCriterion: 'x', updatedAt: START.toISOString() }],
      hands: [{ seat: 'TC-H1', home: 'TC', state: 'working' }], directives: [], handRaises: [], land: { ...this.land }, releases: [], bulletin: { ageMin: this.bulletinAge }, forced: this.forced };
  }
}
const facts = (rows: Array<Record<string, unknown>>) => writeFileSync(join(dir, 'fed-state', 'facts.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
const roots = () => ({ stateRoot: dir, seatState: dir });

describe('SIM turn-end enforcement — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: no-op turn ending «HH:MM에 확인» → engine lands, bulletin is FORCED next, retro counts it`, async () => {
      const r = rng(seed);
      const ready = 1 + Math.floor(r() * 20); const age = 46 + Math.floor(r() * 600); const mails = 1 + Math.floor(r() * 4);
      const w = new World(ready, age);
      // The turn opened with this plan (idle drive: the land tick is left to the turn → todo).
      const opening = planNextActions(w.state(START));
      const shown = await executeNextActions(opening, {}, 'live');
      appendPulseLedger(join(dir, 'loops', 'op-next-action.jsonl'), { window: `idle:${START.toISOString()}`, at: START.toISOString(), stage: 'idle',
        actions: shown.map(x => ({ rule: x.action.rule, actor: x.action.actor, key: x.action.key, status: x.status, what: x.action.what })) });
      // OP's turn: request mails only (no state fact by OP); another seat's green does not count.
      facts([{ ts: '2026-11-26T12:55:01.000Z', type: 'turn', seat: 'OP', state: 'internal' },
        ...Array.from({ length: mails }, (_, i) => ({ ts: `2026-11-26T12:56:0${i}.000Z`, type: 'mail', state: 'post', from: 'OP', to: ['TC', 'UX', 'STEWARD', 'JUD'][i], kind: 'request' })),
        { ts: '2026-11-26T12:57:00.000Z', type: 'cell', seat: 'TC', cell: 'A', state: 'green' }]);
      const reply = ['리더들에게 칸 분할을 요청했다.', seed % 2 ? '21:57에 확인' : '21:58 에 다시 확인하겠습니다.'].join('\n');
      expect(promiseOnly(reply)).toBe(true);
      let landed = 0;
      const row = await runTurnEnforce(roots(), { since: START, origin: 'goal-continue', promise: promiseOnly(reply), tuiProgress: false, now: END }, {
        state: async (_r, now) => w.state(now), factsPath: join(dir, 'fed-state', 'facts.jsonl'),
        actuators: { landTick: () => { landed = w.land.readyToLand; w.land = { ...w.land, readyToLand: 0, landedLastHour: landed }; return `landed ${landed}`; } } });
      // The engine did the machine action itself …
      expect(row).toMatchObject({ noop: true, promise: true, opStateChanges: 0, forced: ['f:bulletin'] });
      expect(landed).toBe(ready);
      expect(row.did).toEqual([`(d) outcome alarm + one land-graph tick (${ready} ready, 0 landed) (landed ${ready}) because OP turn changed nothing`]);
      // … the OP action leads the next plan as FORCED …
      w.forced = readForced(join(dir, 'loops', 'op-forced-next.json'), END).map(f => ({ key: f.key, reason: f.reason }));
      const next = planNextActions(w.state(new Date(END.getTime() + 60_000)));
      expect(next.actions[0]).toMatchObject({ key: 'f:bulletin', forced: 'previous turn ended on «HH:MM에 확인» and changed nothing' });
      expect(renderNextActionBlock(await executeNextActions(next, {}, 'live'), next.goals)).toContain('  FORCED: previous turn ended on «HH:MM에 확인» and changed nothing');
      // … and the retro counts a no-op, promise-only turn with the engine's action.
      const lines = enforceRetroLines(join(dir, 'loops', 'op-turn-enforce.jsonl'), START, new Date(END.getTime() + 1));
      expect(lines[0]).toBe('- 무동작 턴(엔진 판정): 1 · 약속만(«HH:MM에 확인») 1 · 엔진이 대신 한 일 1 · 다음 턴 강제 1');
    });
  }

  test('a turn with an OP state change is not enforced; it also clears the forced set', async () => {
    const w = new World(5, 300);
    const opening = planNextActions(w.state(START));
    appendPulseLedger(join(dir, 'loops', 'op-next-action.jsonl'), { at: START.toISOString(), actions: opening.actions.map(a => ({ rule: a.rule, actor: a.actor, key: a.key, status: 'todo' })) });
    writeFileSync(join(dir, 'loops', 'op-forced-next.json'), JSON.stringify([{ key: 'f:bulletin', what: 'x', reason: 'r', at: START.toISOString() }]));
    facts([{ ts: '2026-11-26T12:56:00.000Z', type: 'cell', seat: 'OP', cell: 'A', state: 'claim' }]);
    let ticks = 0;
    const row = await runTurnEnforce(roots(), { since: START, origin: 'pulse', promise: false, tuiProgress: false, now: END }, {
      state: async (_r, now) => w.state(now), factsPath: join(dir, 'fed-state', 'facts.jsonl'), actuators: { landTick: () => { ticks++; return 'x'; } } });
    expect(row).toMatchObject({ noop: false, did: [], forced: [] });
    expect(ticks).toBe(0);
    expect(readForced(join(dir, 'loops', 'op-forced-next.json'), END)).toEqual([]);
  });

  test('no opening plan → only the no-op record (nothing executed); promise wording without a clock is not a promise', async () => {
    const w = new World(3, 10);
    let ticks = 0;
    const row = await runTurnEnforce(roots(), { since: START, origin: 'pulse', promise: false, tuiProgress: false, now: END }, {
      state: async (_r, now) => w.state(now), factsPath: join(dir, 'fed-state', 'none.jsonl'), actuators: { landTick: () => { ticks++; return 'x'; } } });
    expect(row).toMatchObject({ noop: true, opening: null, did: [] });
    expect(ticks).toBe(0);
    expect(promiseOnly('확인했다 — 착지 3건 완료')).toBe(false);
    expect(promiseOnly('I will check at 21:57')).toBe(true);
  });
});
