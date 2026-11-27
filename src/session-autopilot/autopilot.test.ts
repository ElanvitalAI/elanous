// SESSION-AUTOPILOT — literal expectations (test universe: a fresh temp dir per test · injected clock · fake decision ledger).
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autopilotPolicyParagraph, createAutopilot, readAutopilotState, resolveStandingGoal, type AutopilotDecisionCard } from './autopilot.js';
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

function harness(opts: { coordinator?: boolean } = {}) {
  let t = T0;
  const cards: AutopilotDecisionCard[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const progress: string[] = [];
  const lines: string[] = [];
  const make = () => createAutopilot({ file, now: () => t, log: (e, d) => { logs.push([e, d]); },
    raiseDecision: (card) => { cards.push(card); return `D-${cards.length}`; },
    postProgress: (goal, due) => { progress.push(`${goal.title} · ${due}`); },
    notify: (line) => { lines.push(line); },
    ...(opts.coordinator ? { coordinator: true } : {}) });
  return { make, cards, logs, progress, lines, advance: (ms: number) => { t += ms; }, now: () => t };
}

/** A fake model: for each person message it emits exactly the tool call scripted for it (the test asserts tool → state). */
const fakeModel: Record<string, { name: string; args: Record<string, unknown> }> = {
  '자율주행 시작': { name: 'autopilot_set', args: { on: true, goal: '0.3.35 발행', done_criterion: '판정 한 줄', kind: 'autopilot', deadline: '2026-11-30T00:00:00.000Z', expected_minutes: 60 } },
  '오토파일럿 켜줘': { name: 'autopilot_set', args: { on: true } },
  'autopilot on': { name: 'autopilot_set', args: { on: true, goal: 'land the queue', done_criterion: '판정 한 줄', kind: 'autopilot', deadline: '2026-11-30T00:00:00.000Z', expected_minutes: 60 } },
  '자율주행 꺼': { name: 'autopilot_set', args: { on: false } },
};

test('varied phrasings → fake model tool call → state change (ON persisted · OFF persisted)', async () => {
  // AUTOPILOT-GOAL-CLEARING: ≤ 1 model-set autopilot goal per 30 min — each phrase comes 31 min after the last.
  let t = T0;
  const deps = { cwd: dir, file, now: () => t, raiseDecision: () => 'D-x' };
  for (const phrase of ['자율주행 시작', '오토파일럿 켜줘', 'autopilot on']) {
    t += 31 * MIN;
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
  expect(pilot.set({ on: true, goal: '0.3.35 발행', doneCriterion: '판정 한 줄', kind: 'autopilot', deadline: '2026-11-30T00:00:00.000Z', expectedMinutes: 60 }, 'tool')).toEqual({ ok: true, text: '🚗 AUTO · 0.3.35 발행' });
  expect(pilot.turnEnded({ selfInitiated: false, failed: false })).toEqual({ arm: { delayMs: 30 * MIN, reason: '🚗 자율주행: 목표를 향해 이어서 진행 — 0.3.35 발행' } });
  pilot.noteArmed('w1', T0 + 30 * MIN);
  expect(pilot.statusText()).toBe(`🚗 AUTO · 0.3.35 발행 · next ⏰${hhmm(T0 + 30 * MIN)}`);
  expect(pilot.turnEnded({ selfInitiated: true, failed: false, openWork: true })?.arm?.delayMs).toBe(5 * MIN);
  expect(pilot.turnEnded({ selfInitiated: true, failed: false, scheduledWakeAt: T0 + 9 * MIN })).toEqual({ arm: null });
  expect(h.logs.filter(([e]) => e === 'on')).toEqual([['on', { reason: 'tool', goal: '0.3.35 발행' }]]);
});

test('keystrokes while AUTO → still AUTO (keystroke-ignored logged at most once a minute); explicit hold → PAUSED', () => {
  const h = harness();
  const pilot = h.make();
  pilot.set({ on: true, goal: 'g' }, 'slash');
  pilot.noteHuman();
  h.advance(10_000);
  pilot.noteHuman();
  h.advance(10_000);
  pilot.noteHuman();
  expect(pilot.statusText()).toBe('🚗 AUTO · g');
  h.advance(60_000);
  pilot.noteHuman();
  expect(pilot.statusText()).toBe('🚗 AUTO · g');
  expect(h.logs).toEqual([['on', { reason: 'slash', goal: 'g' }], ['goal-derived', { tier: 'first-class', source: 'human', goal: 'g', reason: 'human-slash' }],
    ['keystroke-ignored', { goal: 'g' }], ['keystroke-ignored', { goal: 'g' }]]);
  pilot.set({ on: true, hold: true }, 'tool');
  expect(pilot.statusText()).toBe('🚗 PAUSED · you are driving');
  h.advance(60 * MIN);
  expect(pilot.tick()).toBe(false);
  expect(pilot.statusText()).toBe('🚗 PAUSED · you are driving');
  expect(runAutopilotSlash(pilot, ['resume'])).toEqual(['🚗 AUTO · g']);
});

test('a submitted human turn → AUTO after it ends, wake armed; under hold the turn end stays PAUSED', () => {
  const h = harness();
  const pilot = h.make();
  pilot.set({ on: true, goal: 'g' }, 'slash');
  pilot.noteHuman();
  expect(pilot.turnEnded({ selfInitiated: false, failed: false })).toEqual({ arm: { delayMs: 30 * MIN, reason: '🚗 자율주행: 목표를 향해 이어서 진행 — g' } });
  expect(pilot.statusText()).toBe('🚗 AUTO · g');
  pilot.set({ on: true, hold: true }, 'tool');
  pilot.noteHuman();
  expect(pilot.turnEnded({ selfInitiated: false, failed: false })).toEqual({ arm: null });
  expect(pilot.statusText()).toBe('🚗 PAUSED · you are driving');
});

test('COORD-RIGHTS: a coordinator line («⇢ OP · …») or a non-person turn asking hold → coordinator drive, autopilot keeps running; a person\'s own line still pauses', () => {
  const h = harness();
  const pilot = h.make();
  pilot.set({ on: true, goal: 'g' }, 'slash');
  pilot.noteTurnStart('human', '⇢ OP · 이제부터 내가 운전한다 — 이 칸 먼저');
  expect(pilot.set({ on: true, hold: true }, 'tool')).toEqual({ ok: true, text: '🚗 coordinator drive (OP) — a coordinator\'s line steers this seat; autopilot keeps running (only a person pauses it)' });
  expect(pilot.statusText()).toBe('🚗 AUTO · g');
  expect(h.logs.at(-1)).toEqual(['coordinator-drive', { by: 'OP', goal: 'g' }]);
  pilot.noteTurnStart('auto');
  expect(pilot.set({ on: true, hold: true }, 'tool').text).toBe('🚗 coordinator drive (auto) — a coordinator\'s line steers this seat; autopilot keeps running (only a person pauses it)');
  expect(pilot.statusText()).toBe('🚗 AUTO · g');
  pilot.noteTurnStart('human', '이제 내가 운전할게');
  pilot.set({ on: true, hold: true }, 'tool');
  expect(pilot.statusText()).toBe('🚗 PAUSED · you are driving');
});

test('AUTOPILOT-GOAL-CONTINUE-CAP safety net: a legacy non-hold pause resumes when a person\'s turn ends', () => {
  mkdirSync(join(dir, '.autopilot'), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 1, on: true, goal: 'g', paused: { at: 1, hold: false, lastHumanAt: 1 } }));
  const h = harness();
  const pilot = h.make();
  pilot.refresh();
  expect(pilot.statusText()).toBe('🚗 PAUSED · you are driving');
  expect(pilot.turnEnded({ selfInitiated: false, failed: false })).toEqual({ arm: { delayMs: 30 * MIN, reason: '🚗 자율주행: 목표를 향해 이어서 진행 — g' } });
  expect(pilot.statusText()).toBe('🚗 AUTO · g');
  expect(h.logs.find(([e]) => e === 'resume')).toEqual(['resume', { reason: 'human-turn-done', goal: 'g' }]);
});

test('a new / urgent directive while AUTO → still AUTO with the goal replaced; a plain request keeps the goal', () => {
  const h = harness();
  const pilot = h.make();
  pilot.set({ on: true, goal: '0.3.35 발행', doneCriterion: '판정 한 줄', kind: 'autopilot', deadline: '2026-11-30T00:00:00.000Z', expectedMinutes: 60 }, 'tool');
  pilot.noteHuman();
  expect(pilot.turnEnded({ selfInitiated: false, failed: false })?.arm?.delayMs).toBe(30 * MIN);
  expect(pilot.statusText()).toBe('🚗 AUTO · 0.3.35 발행');
  pilot.noteHuman();
  h.advance(31 * MIN);
  expect(pilot.set({ on: true, goal: '긴급 결함 수리', doneCriterion: '판정 한 줄', kind: 'autopilot', deadline: '2026-11-30T00:00:00.000Z', expectedMinutes: 60 }, 'tool')).toEqual({ ok: true, text: '🚗 AUTO · 긴급 결함 수리' });
  expect(pilot.turnEnded({ selfInitiated: false, failed: false })?.arm?.delayMs).toBe(30 * MIN);
  expect(pilot.statusText()).toBe('🚗 AUTO · 긴급 결함 수리');
  expect(h.logs.map(([e]) => e)).toEqual(['on', 'goal-derived', 'keystroke-ignored', 'on', 'goal-superseded', 'goal-derived']);
});

test('model-facing paragraph: ON says directives never pause (only explicit hold / off); paused text = explicit hold only', () => {
  const on = autopilotPolicyParagraph({ v: 1, on: true, goal: 'g' }, [], T0) ?? '';
  expect(on).toContain('사람의 새 요청·다른 방향·긴급 지시도 그냥 입력이다 — 처리하되 자율주행은 켜진 채로 둔다.');
  expect(on).toContain('작업 골(📌 핀 · 입력창 위 · 최대 3)은 사람이 «이걸 골로 잡아»처럼 골 설정을 명시할 때만 세운다');
  expect(on).toContain('질문·상태 확인·요청·기한 있는 부탁·우편 답장·후속 확인은 골이 아니다 — 이번 턴에 답하거나 처리한다(추론으로 골을 만들지 않는다).');
  expect(on).toContain('멈추는 것은 사람이 «이제부터 내가 운전하겠다»(autopilot_set({on:true, hold:true})) 또는 «자율주행 멈춰»(autopilot_set({on:false}))라고 명시할 때뿐이다.');
  const held = autopilotPolicyParagraph({ v: 1, on: true, goal: 'g', paused: { at: T0, hold: true, lastHumanAt: T0 } }, [], T0) ?? '';
  expect(held).toBe('## 🚗 자율주행 일시정지 (사람이 «내가 운전하겠다»고 명시함) · 목표: g\n사람이 직접 운전하겠다고 말했다 — 사람의 말을 따른다. 사람이 «다시 자율주행»이라고 하면 autopilot_set({on:true})를 부른다.');
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
  pilot.set({ on: true, goal: 'g', doneCriterion: '판정 한 줄', kind: 'autopilot', deadline: '2026-11-30T00:00:00.000Z', expectedMinutes: 60 }, 'tool');
  expect(pilot.turnEnded({ selfInitiated: false, failed: true, failureSig: 'gate red 12', openWork: true })?.arm?.delayMs).toBe(5 * MIN);
  pilot.turnEnded({ selfInitiated: false, failed: true, failureSig: 'gate red 13' });
  expect(pilot.turnEnded({ selfInitiated: false, failed: true, failureSig: 'gate red 14', openWork: true })).toEqual({
    arm: { delayMs: 30 * MIN, reason: '🚗 자율주행: 목표를 향해 이어서 진행 — g' }, backoff: '같은 실패 3회: gate red #' });
  expect(pilot.state().on).toBe(true);
  expect(pilot.statusText()).toBe('🚗 AUTO · g · slowed');
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
  pilot.set({ on: true, goal: 'g', doneCriterion: '판정 한 줄', kind: 'autopilot', deadline: '2026-11-30T00:00:00.000Z', expectedMinutes: 60 }, 'tool');
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
  pilot.set({ on: true, goal: 'g', doneCriterion: '판정 한 줄', kind: 'autopilot', deadline: '2026-11-30T00:00:00.000Z', expectedMinutes: 60 }, 'tool');
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
  h.make().set({ on: true, goal: 'keep going', doneCriterion: '판정 한 줄', kind: 'autopilot', deadline: '2026-11-30T00:00:00.000Z', expectedMinutes: 60 }, 'tool');
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

test('OP (coordinator) session start → ON with no goal (NO-RELEASE-GOAL); hand seat start → OFF', () => {
  releaseLedger(['0.3.33', '0.3.34']);
  const op = harness({ coordinator: true }).make();
  op.refresh();
  expect(op.state().on).toBe(true);
  expect(op.state().goal).toBeUndefined();
  expect(op.statusText()).not.toContain('0.3.35');
  file = join(dir, 'hand', 'state.json');
  const hand = harness().make();
  hand.refresh();
  expect(hand.state().on).toBe(false);
  expect(hand.statusText()).toBe('');
});

test('coordinator «자율주행 꺼» is persisted — the next start stays OFF', () => {
  releaseLedger(['0.3.34']);
  const h = harness({ coordinator: true });
  h.make().set({ on: false }, 'tool');
  const again = h.make();
  again.refresh();
  expect(again.state().on).toBe(false);
});

test('NO-RELEASE-GOAL: a release is published and the open count moves → no goal change and no 🚗 line', () => {
  releaseLedger(['0.3.37']);
  const h = harness({ coordinator: true });
  const pilot = h.make();
  pilot.refresh();
  for (let i = 0; i < 5; i += 1) { h.advance(MIN); pilot.tick(); }
  mkdirSync(join(dir, 'release', '0.3.38', 'prepared'), { recursive: true });
  writeFileSync(join(dir, 'release', '0.3.38', 'release.json'), JSON.stringify({ version: '0.3.38', prerelease: false, publishedAt: '2026-11-24T06:03:00.000Z' }));
  for (let i = 0; i < 5; i += 1) { h.advance(MIN); pilot.tick(); pilot.refresh(); }
  expect(pilot.state().on).toBe(true);
  expect(pilot.state().goal).toBeUndefined();
  expect(pilot.state().derived).toBeUndefined();
  expect(h.lines).toEqual([]);
  expect(h.logs.filter(([e]) => e === 'goal-derived' || e === 'goal-rolled' || e === 'goal-phase' || e === 'release-goal-set')).toEqual([]);
  expect(pilot.turnEnded({ selfInitiated: true, failed: false, fingerprint: 'idle' })?.drive).toBeUndefined();
});

test('NO-RELEASE-GOAL: a stored release goal is dropped on the next refresh — one log line, no visible line', () => {
  mkdirSync(join(dir, '.autopilot'), { recursive: true });
  const churn = '0.3.38 개발 — CLAUDE-OP-PROXY-BUS · JUD-GREEN-CREDENTIAL · SPLIT-TO-GREEN (+155 open)';
  writeFileSync(file, JSON.stringify({ v: 1, on: true, by: 'default', goal: churn, releaseSeen: '0.3.38',
    standing: { version: '0.3.38', phase: '개발', note: 'CLAUDE-OP-PROXY-BUS · JUD-GREEN-CREDENTIAL · SPLIT-TO-GREEN (+155 open)' },
    derived: { tier: 'standing', source: 'standing', goal: churn } }));
  const h = harness({ coordinator: true });
  const pilot = h.make();
  pilot.refresh();
  pilot.refresh();
  pilot.tick();
  expect(pilot.state().on).toBe(true);
  expect(pilot.state().goal).toBeUndefined();
  expect(pilot.statusText()).not.toContain('0.3.38');
  expect(h.logs.filter(([e]) => e === 'release-goal-cleared')).toEqual([['release-goal-cleared', { goal: churn, releaseSeen: '0.3.38' }]]);
  expect(h.logs.filter(([e]) => e === 'goal-derived')).toEqual([]);
  expect(h.lines).toEqual([]);
  const stored = readAutopilotState(file)!;
  expect([stored.goal, stored.standing, stored.releaseSeen, stored.derived]).toEqual([undefined, undefined, undefined, undefined]);
});

test('NO-RELEASE-GOAL: an open crown goal stays when the legacy release fields are dropped', () => {
  mkdirSync(join(dir, '.autopilot'), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 1, on: true, goal: '[지시] 회원 가입 안정화', releaseSeen: '0.3.38', standing: { version: '0.3.38', phase: '개발' },
    firstClass: [{ id: 'crown:9', source: 'crown', text: '[지시] 회원 가입 안정화', at: 1 }],
    derived: { tier: 'first-class', source: 'crown:9', goal: '[지시] 회원 가입 안정화' } }));
  const h = harness({ coordinator: true });
  const pilot = h.make();
  pilot.refresh();
  expect(pilot.state().goal).toBe('[지시] 회원 가입 안정화');
  expect(pilot.state().derived).toEqual({ tier: 'first-class', source: 'crown:9', goal: '[지시] 회원 가입 안정화' });
  expect(h.logs.filter(([e]) => e === 'release-goal-cleared')).toEqual([['release-goal-cleared', { goal: '', releaseSeen: '0.3.38' }]]);
  expect(h.lines).toEqual([]);
});

test('goals: the person adds a mid goal → paragraph + status; due within 48 h → one progress card', async () => {
  const h = harness();
  const pilot = h.make();
  pilot.set({ on: true, goal: '0.3.35 개발', doneCriterion: '판정 한 줄', kind: 'autopilot', deadline: '2026-11-30T00:00:00.000Z', expectedMinutes: 60 }, 'tool');
  pilot.noteTurnStart('human');
  const added = await dispatchAutopilotTool('autopilot_goal_set', { level: 'mid', title: '11-26 20:00 AI&B demo', due: '2026-11-26T11:00:00.000Z' }, { cwd: dir, file });
  expect(added).toEqual({ ok: true, status: '목표 추가: [mid] 11-26 20:00 AI&B demo · 2026-11-26T11:00:00.000Z' });
  expect(pilot.statusText()).toBe('🚗 AUTO · 0.3.35 개발 · demo D-2');
  expect(pilot.paragraph()).toContain('- [mid] 11-26 20:00 AI&B demo · D-2');
  h.advance(6 * 60 * MIN); // 47 h before due
  pilot.tick();
  pilot.tick();
  expect(h.progress).toEqual(['11-26 20:00 AI&B demo · D-1']);
  expect(pilot.paragraph()).toContain('- ⚠ [mid] 11-26 20:00 AI&B demo · D-1 — 기한 임박: 관련 일을 먼저 한다');
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
  const pilot = harness({ coordinator: true }).make();
  pilot.refresh();
  expect(pilot.goals().map((g) => `${g.level}|${g.title}|${g.source}`)).toEqual([
    'mid|11-26 20:00 AI&B demo|seed', 'mid|Free membership opens December|seed', 'long|2027 Q1 paid launch prep|seed', 'long|Paid launch in April|seed']);
  pilot.noteTurnStart('human');
  expect(await dispatchAutopilotTool('autopilot_goal_remove', { id: 'paid-launch-in-april' }, { cwd: dir, file })).toEqual({ ok: true, status: '목표 삭제: paid-launch-in-april' });
  pilot.refresh();
  expect(pilot.goals().length).toBe(3);
});

test('decided → one «decided» log, no state change', () => {
  const h = harness();
  const pilot = h.make();
  pilot.set({ on: true, goal: 'g', doneCriterion: '판정 한 줄', kind: 'autopilot', deadline: '2026-11-30T00:00:00.000Z', expectedMinutes: 60 }, 'tool');
  pilot.set({ decided: { kind: 'retry', criterion: 'gate flake · same head' } }, 'tool');
  expect(h.logs.at(-1)).toEqual(['decided', { kind: 'retry', criterion: 'gate flake · same head', goal: 'g', source: 'tool' }]);
  expect(pilot.state().on).toBe(true);
});

test('release resolver (read on demand): installed 0.3.34 with no release.json for it on this host → 0.3.35 개발', () => {
  releaseLedger(['0.3.33']);
  expect(resolveStandingGoal({ hqRoot: dir, ledgerRoot: dir, installedVersion: '0.3.34', packageVersion: '0.3.34-dev.0' })).toEqual({ version: '0.3.35', phase: '개발' });
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
