// AUTOPILOT-HUMAN-GOAL — literal expectations (fresh temp universe per test · injected clock · no release-derived goal).
// Incident 11-25 06:3x: a person's multi-step request under AUTO never became the goal (the goal stayed a stale
// trusted-mail frame line), and the seat ended its turn with «아직 결과가 없어» while 3 background agents ran.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAutopilot } from './autopilot.js';
import { dispatchAutopilotTool } from './autopilot-tool.js';
import { firstClassFromMail, sanitizeGoalText } from './dynamic-goal.js';

const root = mkdtempSync(join(tmpdir(), 'human-goal-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dir = '';
let file = '';
let n = 0;
beforeEach(() => { dir = join(root, `u${++n}`); mkdirSync(dir, { recursive: true }); file = join(dir, '.autopilot', 'state.json'); });

const T0 = Date.parse('2026-11-25T06:35:00.000Z');
const STALE = '[지시] 연방 자리가 보낸 업무 지시입니다(신뢰 발신자). 네 역할·헌장 안에서 실행하고, 받은 턴 첫 줄에 «받음 + 첫 행동»을 쓴다. 파괴적 작…';

function harness(seed?: Record<string, unknown>) {
  if (seed) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(seed)); }
  const logs: Array<[string, Record<string, unknown>]> = [];
  const pilot = createAutopilot({ file, now: () => T0, coordinator: true, log: (e, d) => { logs.push([e, d]); },
    raiseDecision: () => 'D-x', postProgress: () => {} });
  pilot.refresh();
  const derived = () => logs.filter(([e]) => e === 'goal-derived').map(([, d]) => d);
  return { pilot, logs, derived };
}

const staleSeed = { v: 1, on: true, by: 'default', goal: STALE, standing: { version: '0.3.36', phase: '개발' }, releaseSeen: '0.3.36',
  firstClass: [{ id: 'crown:31', source: 'crown', text: STALE, at: 1 }],
  derived: { tier: 'first-class', source: 'crown:31', goal: STALE } };

test('a goal text stored by an older build loses its frame on load (crown falls back to its directive id)', () => {
  const h = harness(staleSeed);
  expect(h.pilot.state().goal).toBe('[지시] 31');
  expect(h.derived()).toEqual([{ tier: 'first-class', source: 'crown:31', goal: '[지시] 31', reason: 'refresh' }]);
  // NO-RELEASE-GOAL: the legacy release fields go; the open crown goal stays.
  expect(h.pilot.state().standing).toBeUndefined();
  expect(h.pilot.state().releaseSeen).toBeUndefined();
  expect(h.logs.filter(([e]) => e === 'release-goal-cleared')).toEqual([['release-goal-cleared', { goal: '', releaseSeen: '0.3.36' }]]);
});

test('multi-step human request: the model sets goal + done criterion → human goal replaces the stale frame goal', async () => {
  const h = harness(staleSeed);
  h.pilot.noteTurnStart('human');
  h.pilot.noteHuman();
  const out = await dispatchAutopilotTool('autopilot_set',
    { on: true, goal: '0.3.36 로스터 확정 · 시간당 착지 10·초록 10 택틱', done_criterion: '로스터 표와 택틱 한 장을 사람에게 보냄', kind: 'autopilot', deadline: '2026-11-30T00:00:00.000Z', expected_turns: 3 },
    { cwd: dir, file, now: () => T0, log: (e, d) => { h.logs.push([e, d]); } });
  expect(out).toMatchObject({ ok: true });
  h.pilot.refresh();
  expect(h.pilot.state().derived).toEqual({ tier: 'first-class', source: 'human', goal: '0.3.36 로스터 확정 · 시간당 착지 10·초록 10 택틱', done: '로스터 표와 택틱 한 장을 사람에게 보냄' });
  expect(h.derived().at(-1)).toEqual({ tier: 'first-class', source: 'human', goal: '0.3.36 로스터 확정 · 시간당 착지 10·초록 10 택틱', reason: 'human-tool' });
  expect(h.pilot.statusText().startsWith('🚗 AUTO · 0.3.36 로스터 확정 · 시간당 착지 …')).toBe(true);
  expect(h.pilot.goalFeed()).toBe('<!-- autopilot-goal-feed -->\n🎯 지금 골: 0.3.36 로스터 확정 · 시간당 착지 10·초록 10 택틱 (1급 골 · human)\n'
    + '완료 기준: 로스터 표와 택틱 한 장을 사람에게 보냄\n보통 우편·요청은 골을 바꾸지 않는다 — 약속 원장·체크리스트에 적고 이 골을 향해 간다.');
});

test('a goal without a done criterion is refused (status ask / one-step command stays a normal turn)', async () => {
  const h = harness();
  h.pilot.noteTurnStart('human', 'OP 활동 보여줘');
  const out = await dispatchAutopilotTool('autopilot_set', { on: true, goal: 'OP 활동 보여줘' }, { cwd: dir, file, now: () => T0 });
  expect(out).toEqual({ error: 'Not a goal: no-explicit-ask. A goal is set only when the person explicitly says to set it as a goal (quote their words in explicit_ask) or a crown mail carries a goal field. Answer the question or do the request in this turn.' });
  h.pilot.refresh();
  expect(h.pilot.state().goal).toBeUndefined();
});

test('status ask and ack-only lines typed by a person never change the goal (harness derives nothing from text)', () => {
  const h = harness();
  for (let i = 0; i < 3; i += 1) { h.pilot.noteHuman(); h.pilot.turnEnded({ selfInitiated: false, failed: false, fingerprint: '네' }); }
  expect(h.pilot.state().goal).toBeUndefined();
  expect(h.derived()).toEqual([]);
});

test('one sanitizer for every source: trusted-mail notice · crown relay body · a pasted human frame', () => {
  const notice = '연방 자리가 보낸 업무 지시입니다(신뢰 발신자). 네 역할·헌장 안에서 실행하고, 받은 턴 첫 줄에 «받음 + 첫 행동»을 쓴다. 파괴적 작업(삭제·발행·돈·비밀)은 평소 승인 규칙을 따른다.\n'
    + '<federation_work_order from="OPC" intent="request" msg="5" crown="yes">\n[from OPC · request · crown]\nmsg:5 · 착지 열차 복구\n</federation_work_order>';
  expect(sanitizeGoalText(notice)).toBe('착지 열차 복구');
  expect(firstClassFromMail({ msgId: 6, crownDirective: '88', body: '[TG-OP crown] 데모 덱 먼저 마감\n둘째 줄' }, T0)?.text).toBe('[지시] 데모 덱 먼저 마감');
  expect(sanitizeGoalText('<federation_work_order from="X">\n\n[지시] 회원 가입 안정화\n</federation_work_order>')).toBe('회원 가입 안정화');
  expect(sanitizeGoalText(STALE)).toBe('');
});

test('a background agent finishing re-feeds the open first-class goal (once per capsule · agents only)', async () => {
  const h = harness();
  h.pilot.noteTurnStart('human');
  await dispatchAutopilotTool('autopilot_set', { on: true, goal: '0.3.36 로스터 확정', done_criterion: '로스터 표 발송', kind: 'autopilot', deadline: '2026-11-30T00:00:00.000Z', expected_turns: 3 }, { cwd: dir, file, now: () => T0 });
  const done = { capsuleId: 'c1', kind: 'agent', status: 'ok', summary: '로스터 후보 분석' };
  expect(h.pilot.noteBackgroundDone(done)).toBe('🎯 지금 골: 0.3.36 로스터 확정 — 백그라운드 에이전트 «로스터 후보 분석» 끝남(ok) · capsule:c1. 결과를 합쳐 완료 기준까지 이어서 간다.');
  expect(h.pilot.noteBackgroundDone(done)).toBeNull();
  expect(h.pilot.noteBackgroundDone({ ...done, capsuleId: 's1', kind: 'shell' })).toBeNull();
  expect(h.logs.filter(([e]) => e === 'goal-refeed')).toEqual([['goal-refeed', { tier: 'first-class', source: 'human', goal: '0.3.36 로스터 확정', capsuleId: 'c1', kind: 'agent', status: 'ok' }]]);
});

test('no first-class goal open (no goal at all) → an agent finishing re-feeds nothing', () => {
  const h = harness();
  expect(h.pilot.noteBackgroundDone({ capsuleId: 'c9', kind: 'agent', status: 'ok', summary: 'x' })).toBeNull();
});

test('human request turn ends with «not yet» while 3 agents run → one «초안부터» nudge, not repeated', () => {
  const h = harness();
  h.pilot.noteHuman();
  const first = h.pilot.turnEnded({ selfInitiated: false, failed: false, fingerprint: '아직 결과가 없어', backgroundRunning: 3, stateChanged: false });
  expect(first.nudge).toBe('백그라운드 에이전트 3개가 아직 돈다. «아직 없음»으로 끝내지 말고 초안부터 내고 결과 오면 갱신한다. 사람이 골 설정을 명시하면(explicit_ask 에 그 말 인용) autopilot_set({on:true, goal, explicit_ask, done_criterion, deadline})로 작업 골(핀)을 세운다 — 질문·요청은 골이 아니다.');
  // The nudge turn itself (not a person's line) ends the same way → no second nudge.
  expect(h.pilot.turnEnded({ selfInitiated: false, failed: false, fingerprint: '아직', backgroundRunning: 3, stateChanged: false }).nudge).toBeUndefined();
  expect(h.logs.filter(([e]) => e === 'await-agents-nudge').length).toBe(1);
});

test('with a first-class goal open: nudge once per goal; a turn that changed state is not nudged', async () => {
  const h = harness();
  h.pilot.noteTurnStart('human');
  await dispatchAutopilotTool('autopilot_set', { on: true, goal: '택틱 한 장', done_criterion: '택틱 문서 링크 보냄', kind: 'autopilot', deadline: '2026-11-30T00:00:00.000Z', expected_turns: 3 }, { cwd: dir, file, now: () => T0 });
  h.pilot.refresh();
  expect(h.pilot.turnEnded({ selfInitiated: false, failed: false, fingerprint: 'a', backgroundRunning: 2, stateChanged: true }).nudge).toBeUndefined();
  expect(h.pilot.turnEnded({ selfInitiated: false, failed: false, fingerprint: 'b', backgroundRunning: 2, stateChanged: false }).nudge)
    .toBe('🎯 지금 골: 택틱 한 장 — 백그라운드 에이전트 2개가 아직 돈다. «아직 없음»으로 끝내지 말고 초안부터 내고 결과 오면 갱신한다.');
  expect(h.pilot.turnEnded({ selfInitiated: false, failed: false, fingerprint: 'c', backgroundRunning: 2, stateChanged: false }).nudge).toBeUndefined();
  expect(h.pilot.state().goal).toBe('택틱 한 장');
});
