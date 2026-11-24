// SESSION-AUTOPILOT — literal expectations (test universe: a fresh temp dir per test · injected clock · fake decision ledger).
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutopilot, readAutopilotState, resolveStandingGoal, type AutopilotDecisionCard } from './autopilot.js';
import { dispatchAutopilotTool } from './autopilot-tool.js';
import { runAutopilotSlash } from './autopilot-slash.js';
import { readGoals } from './goals.js';

const root = mkdtempSync(join(tmpdir(), 'session-autopilot-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dir = '';
let file = '';
let n = 0;
beforeEach(() => { dir = join(root, `u${++n}`); mkdirSync(dir, { recursive: true }); file = join(dir, '.autopilot', 'state.json'); });

const T0 = Date.parse('2026-11-24T06:00:00.000Z');
const MIN = 60_000;
const hhmm = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function harness(opts: { coordinator?: boolean; ledger?: boolean; installed?: string; packageVersion?: string } = {}) {
  let t = T0;
  const cards: AutopilotDecisionCard[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const progress: string[] = [];
  const make = () => createAutopilot({ file, now: () => t, log: (e, d) => { logs.push([e, d]); },
    raiseDecision: (card) => { cards.push(card); return `D-${cards.length}`; },
    postProgress: (goal, due) => { progress.push(`${goal.title} · ${due}`); },
    ...(opts.coordinator ? { coordinator: true } : {}),
    ...(opts.ledger ? { standingGoal: () => resolveStandingGoal({ hqRoot: dir, ledgerRoot: dir, packageVersion: opts.packageVersion ?? '0.3.34-dev.0', now: t,
      ...(opts.installed ? { installedVersion: opts.installed } : {}) }) } : {}) });
  return { make, cards, logs, progress, advance: (ms: number) => { t += ms; }, now: () => t };
}

/** A fake model: for each person message it emits exactly the tool call scripted for it (the test asserts tool → state). */
const fakeModel: Record<string, { name: string; args: Record<string, unknown> }> = {
  '자율주행 시작': { name: 'autopilot_set', args: { on: true, goal: '0.3.35 발행' } },
  '오토파일럿 켜줘': { name: 'autopilot_set', args: { on: true } },
  'autopilot on': { name: 'autopilot_set', args: { on: true, goal: 'land the queue' } },
  '자율주행 꺼': { name: 'autopilot_set', args: { on: false } },
};

test('varied phrasings → fake model tool call → state change (ON persisted · OFF persisted)', async () => {
  const deps = { cwd: dir, file, now: () => T0, raiseDecision: () => 'D-x' };
  for (const phrase of ['자율주행 시작', '오토파일럿 켜줘', 'autopilot on']) {
    await dispatchAutopilotTool('autopilot_set', { on: false }, deps);
    const call = fakeModel[phrase]!;
    expect(await dispatchAutopilotTool(call.name, call.args, deps)).toMatchObject({ ok: true });
    expect(readAutopilotState(file)?.on).toBe(true);
  }
  expect(readAutopilotState(file)?.goal).toBe('land the queue');
  const off = fakeModel['자율주행 꺼']!;
  expect(await dispatchAutopilotTool(off.name, off.args, deps)).toEqual({ ok: true, status: '🚗 자율주행 꺼짐 — 다시 켤 때까지 꺼진 채로 둔다' });
  expect(readAutopilotState(file)?.on).toBe(false);
});

test('tool call on → status chip; turn end with nothing scheduled → wake armed (30 min · 5 min with open work)', () => {
  const h = harness();
  const pilot = h.make();
  expect(pilot.set({ on: true, goal: '0.3.35 발행' }, 'tool')).toEqual({ ok: true, text: '🚗 AUTO · 0.3.35 발행' });
  expect(pilot.turnEnded({ selfInitiated: false, failed: false })).toEqual({ arm: { delayMs: 30 * MIN, reason: '🚗 자율주행: 목표를 향해 이어서 진행 — 0.3.35 발행' } });
  pilot.noteArmed('w1', T0 + 30 * MIN);
  expect(pilot.statusText()).toBe(`🚗 AUTO · 0.3.35 발행 · next ⏰${hhmm(T0 + 30 * MIN)}`);
  expect(pilot.turnEnded({ selfInitiated: true, failed: false, openWork: true })?.arm?.delayMs).toBe(5 * MIN);
  expect(pilot.turnEnded({ selfInitiated: true, failed: false, scheduledWakeAt: T0 + 9 * MIN })).toEqual({ arm: null });
  expect(h.logs.filter(([e]) => e === 'on')).toEqual([['on', { reason: 'tool', goal: '0.3.35 발행' }]]);
});

test('human input → PAUSED, auto-resume after 10 min of quiet (injected clock); hold stays paused', () => {
  const h = harness();
  const pilot = h.make();
  pilot.set({ on: true, goal: 'g' }, 'slash');
  pilot.noteHuman();
  expect(pilot.statusText()).toBe('🚗 PAUSED · 사람 운전');
  expect(pilot.turnEnded({ selfInitiated: false, failed: false })).toEqual({ arm: null });
  h.advance(9 * MIN);
  expect(pilot.tick()).toBe(false);
  h.advance(1 * MIN);
  expect(pilot.tick()).toBe(true);
  expect(pilot.statusText()).toBe('🚗 AUTO · g');
  expect(h.logs.map(([e]) => e)).toEqual(['on', 'pause', 'resume']);
  pilot.set({ on: true, hold: true }, 'tool');
  h.advance(60 * MIN);
  expect(pilot.tick()).toBe(false);
  expect(pilot.statusText()).toBe('🚗 PAUSED · 사람 운전');
  expect(runAutopilotSlash(pilot, ['resume'])).toEqual(['🚗 AUTO · g']);
});

test('off → no further autonomous turns (no wake armed)', () => {
  const h = harness();
  const pilot = h.make();
  pilot.set({ on: true }, 'tool');
  expect(runAutopilotSlash(pilot, ['off'])).toEqual(['🚗 자율주행 꺼짐 — 다시 켤 때까지 꺼진 채로 둔다']);
  expect(pilot.turnEnded({ selfInitiated: true, failed: false })).toEqual({ arm: null });
  expect(pilot.statusText()).toBe('');
});

test('3× the same failure → back off to 30-min wakes + one log, no stop, no card; a card only after 2 h of back-off', () => {
  const h = harness();
  const pilot = h.make();
  pilot.set({ on: true, goal: 'g' }, 'tool');
  expect(pilot.turnEnded({ selfInitiated: false, failed: true, failureSig: 'gate red 12', openWork: true })?.arm?.delayMs).toBe(5 * MIN);
  pilot.turnEnded({ selfInitiated: false, failed: true, failureSig: 'gate red 13' });
  expect(pilot.turnEnded({ selfInitiated: false, failed: true, failureSig: 'gate red 14', openWork: true })).toEqual({
    arm: { delayMs: 30 * MIN, reason: '🚗 자율주행: 목표를 향해 이어서 진행 — g' }, backoff: '같은 실패 3회: gate red #' });
  expect(pilot.state().on).toBe(true);
  expect(pilot.statusText()).toBe('🚗 AUTO · g · 감속');
  expect(h.cards).toEqual([]);
  h.advance(119 * MIN);
  pilot.turnEnded({ selfInitiated: false, failed: true, failureSig: 'gate red 15' });
  expect(h.cards).toEqual([]);
  h.advance(1 * MIN);
  pilot.turnEnded({ selfInitiated: false, failed: true, failureSig: 'gate red 16' });
  pilot.turnEnded({ selfInitiated: false, failed: true, failureSig: 'gate red 17' });
  expect(h.cards).toEqual([{ title: '자율주행 감속 2시간 · 같은 실패 5회: gate red #', reason: '같은 실패 5회: gate red #', goal: 'g', sessionId: undefined }]);
  expect(h.logs.map(([e]) => e).filter((e) => e.startsWith('backoff'))).toEqual(['backoff', 'backoff-card']);
  pilot.turnEnded({ selfInitiated: false, failed: false });
  expect(h.logs.at(-1)?.[0]).toBe('backoff-cleared');
  expect(pilot.statusText()).toBe('🚗 AUTO · g');
});

test('30 mail/notice turns in an hour → not stopped, no card, no back-off (external events are not autopilot volume)', () => {
  const h = harness();
  const pilot = h.make();
  pilot.set({ on: true, goal: 'g' }, 'tool');
  for (let i = 0; i < 30; i += 1) {
    expect(pilot.turnEnded({ selfInitiated: false, failed: false, fingerprint: 'same mail reply' })?.arm?.delayMs).toBe(30 * MIN);
    h.advance(2 * MIN);
  }
  expect(h.cards).toEqual([]);
  expect(pilot.state().backoff).toBeUndefined();
  expect(pilot.statusText()).toBe('🚗 AUTO · g');
});

test('13 self wakes: changing replies keep the 30-min cadence; 3 identical replies → back off (no stop, no card)', () => {
  const h = harness();
  const pilot = h.make();
  pilot.set({ on: true, goal: 'g' }, 'tool');
  for (let i = 0; i < 13; i += 1) {
    expect(pilot.turnEnded({ selfInitiated: true, failed: false, fingerprint: `step ${i} landed` })).toEqual({ arm: { delayMs: 30 * MIN, reason: '🚗 자율주행: 목표를 향해 이어서 진행 — g' } });
    h.advance(5 * MIN);
  }
  for (let i = 0; i < 3; i += 1) pilot.turnEnded({ selfInitiated: true, failed: false, fingerprint: 'nothing to do', openWork: true });
  expect(pilot.state().backoff?.reason).toBe('자율 깨움 3회 변화 없음');
  expect(pilot.turnEnded({ selfInitiated: true, failed: false, fingerprint: 'nothing to do', openWork: true })?.arm?.delayMs).toBe(30 * MIN);
  expect(h.cards).toEqual([]);
  expect(pilot.state().on).toBe(true);
});

test('migration: a stored «시간당 자율 턴 상한» stop is cleared on load, logged once', () => {
  mkdirSync(join(dir, '.autopilot'), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 1, on: true, goal: '0.3.35 개발', turns: [1, 2, 3],
    stopped: { at: 1, reason: '시간당 자율 턴 상한 12', decisionId: 'D-20261124-01' } }));
  const h = harness();
  const pilot = h.make();
  pilot.refresh();
  pilot.refresh();
  expect(pilot.statusText()).toBe('🚗 AUTO · 0.3.35 개발');
  expect(h.logs.filter(([e]) => e === 'migrated')).toEqual([['migrated', { cleared: 'stopped', reason: '시간당 자율 턴 상한 12', decisionId: 'D-20261124-01' }]]);
  expect(readAutopilotState(file)?.stopped).toBeUndefined();
});

test('restart keeps ON (a new controller on the same file)', () => {
  const h = harness();
  h.make().set({ on: true, goal: 'keep going' }, 'tool');
  const again = h.make();
  again.refresh();
  expect(again.statusText()).toBe('🚗 AUTO · keep going');
});

function releaseLedger(published: string[]): void {
  const rel = join(dir, 'release');
  for (const v of published) {
    mkdirSync(join(rel, v), { recursive: true });
    writeFileSync(join(rel, v, 'release.json'), JSON.stringify({ version: v, prerelease: false, publishedAt: '2026-11-23T23:00:00.000Z' }));
  }
  mkdirSync(join(rel, '9.9.97'), { recursive: true }); // a ledger dir without release.json is not published
}

test('OP (coordinator) session start → ON with the standing goal; hand seat start → OFF', () => {
  releaseLedger(['0.3.33', '0.3.34']);
  const op = harness({ coordinator: true, ledger: true }).make();
  op.refresh();
  expect(op.state().on).toBe(true);
  expect(op.state().goal).toBe('0.3.35 개발');
  expect(op.statusText().startsWith('🚗 AUTO · 0.3.35 개발')).toBe(true);
  file = join(dir, 'hand', 'state.json');
  const hand = harness({ ledger: true }).make();
  hand.refresh();
  expect(hand.state().on).toBe(false);
  expect(hand.statusText()).toBe('');
});

test('coordinator «자율주행 꺼» is persisted — the next start stays OFF', () => {
  releaseLedger(['0.3.34']);
  const h = harness({ coordinator: true, ledger: true });
  h.make().set({ on: false }, 'tool');
  const again = h.make();
  again.refresh();
  expect(again.state().on).toBe(false);
});

test('release cycle: cut prepared → «컷·발행»; publish-verified 0.3.35 → goal rolls to «0.3.36 개발» with one goal-rolled log', () => {
  releaseLedger(['0.3.34']);
  const h = harness({ coordinator: true, ledger: true });
  const pilot = h.make();
  pilot.refresh();
  expect(pilot.state().goal).toBe('0.3.35 개발');
  mkdirSync(join(dir, 'release', '0.3.35', 'prepared'), { recursive: true });
  pilot.tick();
  expect(pilot.state().goal).toBe('0.3.35 컷·발행');
  writeFileSync(join(dir, 'release', '0.3.35', 'release.json'), JSON.stringify({ version: '0.3.35', prerelease: false, publishedAt: '2026-11-25T21:00:00.000Z' }));
  pilot.tick();
  expect(pilot.state().goal).toBe('0.3.36 개발');
  expect(pilot.statusText().startsWith('🚗 AUTO · 0.3.36 개발')).toBe(true);
  expect(h.logs.filter(([e]) => e === 'goal-rolled')).toEqual([['goal-rolled', { from: '0.3.35 컷·발행', to: '0.3.36 개발' }]]);
});

test('goals: the person adds a mid goal → paragraph + status; due within 48 h → one progress card', async () => {
  const h = harness();
  const pilot = h.make();
  pilot.set({ on: true, goal: '0.3.35 개발' }, 'tool');
  pilot.noteTurnStart('human');
  const added = await dispatchAutopilotTool('autopilot_goal_set', { level: 'mid', title: '11-26 20:00 AI&B 데모', due: '2026-11-26T11:00:00.000Z' }, { cwd: dir, file });
  expect(added).toEqual({ ok: true, status: '목표 추가: [mid] 11-26 20:00 AI&B 데모 · 2026-11-26T11:00:00.000Z' });
  expect(pilot.statusText()).toBe('🚗 AUTO · 0.3.35 개발 · 데모 D-2');
  expect(pilot.paragraph()).toContain('- [mid] 11-26 20:00 AI&B 데모 · D-2');
  h.advance(6 * 60 * MIN); // 47 h before due
  pilot.tick();
  pilot.tick();
  expect(h.progress).toEqual(['11-26 20:00 AI&B 데모 · D-1']);
  expect(pilot.paragraph()).toContain('- ⚠ [mid] 11-26 20:00 AI&B 데모 · D-1 — 기한 임박: 관련 일을 먼저 한다');
});

test('autopilot cannot create a goal without the person — an autonomous turn yields only a proposal card', async () => {
  const h = harness();
  const pilot = h.make();
  pilot.set({ on: true }, 'tool');
  pilot.noteTurnStart('auto');
  const proposals: string[] = [];
  const result = await dispatchAutopilotTool('autopilot_goal_set', { level: 'long', title: '2027 Q2 해외 진출' },
    { cwd: dir, file, proposeGoal: (input) => { proposals.push(String(input.title)); } });
  expect(result).toEqual({ error: '목표는 사람이 정한다 — 자율 턴에서는 제안 카드로만 올렸다', proposal: true });
  expect(proposals).toEqual(['2027 Q2 해외 진출']);
  expect(readGoals(join(dir, '.autopilot', 'goals.json'))).toBeNull();
});

test('coordinator first start seeds the goal stack once (source=seed · deletable)', async () => {
  releaseLedger(['0.3.34']);
  const pilot = harness({ coordinator: true, ledger: true }).make();
  pilot.refresh();
  expect(pilot.goals().map((g) => `${g.level}|${g.title}|${g.source}`)).toEqual([
    'mid|11-26 20:00 AI&B 데모|seed', 'mid|12월 무료 회원 오픈|seed', 'long|2027 Q1 유료 준비|seed', 'long|4월 유료 시작|seed']);
  pilot.noteTurnStart('human');
  expect(await dispatchAutopilotTool('autopilot_goal_remove', { id: '4월-유료-시작' }, { cwd: dir, file })).toEqual({ ok: true, status: '목표 삭제: 4월-유료-시작' });
  pilot.refresh();
  expect(pilot.goals().length).toBe(3);
});

test('decided → one «decided» log, no state change', () => {
  const h = harness();
  const pilot = h.make();
  pilot.set({ on: true, goal: 'g' }, 'tool');
  pilot.set({ decided: { kind: 'retry', criterion: 'gate flake · same head' } }, 'tool');
  expect(h.logs.at(-1)).toEqual(['decided', { kind: 'retry', criterion: 'gate flake · same head', goal: 'g', source: 'tool' }]);
  expect(pilot.state().on).toBe(true);
});

test('installed 0.3.34 (published, but this host\'s ledger has no release.json for it) → standing goal 0.3.35 개발', () => {
  releaseLedger(['0.3.33']);
  const pilot = harness({ coordinator: true, ledger: true, installed: '0.3.34', packageVersion: '0.3.34-dev.0' }).make();
  pilot.refresh();
  expect(pilot.state().goal).toBe('0.3.35 개발');
});

test('a stale plan «status: current» for a published release → the next version', () => {
  releaseLedger(['0.3.34']);
  mkdirSync(join(dir, 'seat-state', 'OP', 'plans'), { recursive: true });
  writeFileSync(join(dir, 'seat-state', 'OP', 'plans', 'PLAN-0.3.34.md'), '---\nstatus: current\n---\n# PLAN-0.3.34 — x\n');
  expect(resolveStandingGoal({ hqRoot: dir, ledgerRoot: dir, packageVersion: '0.3.33-dev.0' })).toEqual({ version: '0.3.35', phase: '개발' });
  writeFileSync(join(dir, 'seat-state', 'OP', 'plans', 'PLAN-0.3.35.md'), '---\nstatus: current\n---\n# PLAN-0.3.35 — y\n');
  expect(resolveStandingGoal({ hqRoot: dir, ledgerRoot: dir, installedVersion: '0.3.34' })).toEqual({ version: '0.3.35', phase: '개발' });
});

test('«자율주행 다시» (resume / on) clears stop and back-off — the next turns trip nothing and send no card', () => {
  mkdirSync(join(dir, '.autopilot'), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 1, on: true, goal: 'g', stopped: { at: 1, reason: '같은 실패 3회: x' } }));
  const h = harness();
  const pilot = h.make();
  expect(pilot.set({ on: true }, 'tool')).toEqual({ ok: true, text: '🚗 AUTO · g' });
  for (let i = 0; i < 20; i += 1) expect(pilot.turnEnded({ selfInitiated: false, failed: false })?.arm?.delayMs).toBe(30 * MIN);
  pilot.turnEnded({ selfInitiated: true, failed: true, failureSig: 'x' });
  pilot.turnEnded({ selfInitiated: true, failed: true, failureSig: 'x' });
  pilot.turnEnded({ selfInitiated: true, failed: true, failureSig: 'x' });
  expect(pilot.state().backoff?.reason).toBe('같은 실패 3회: x');
  pilot.noteHuman();
  expect(runAutopilotSlash(pilot, ['resume'])).toEqual(['🚗 AUTO · g']);
  expect(pilot.state().backoff).toBeUndefined();
  expect(h.cards).toEqual([]);
});
