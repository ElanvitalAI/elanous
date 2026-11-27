// AUTOPILOT-DYNAMIC-GOAL-FEED — literal expectations (fresh temp universe per test · injected clock · no release-derived goal).
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutopilot, readAutopilotState } from './autopilot.js';
import { dispatchAutopilotTool } from './autopilot-tool.js';
import { firstClassFromMail, goalFeedBlock, withGoalFeed } from './dynamic-goal.js';

const root = mkdtempSync(join(tmpdir(), 'dyn-goal-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dir = '';
let file = '';
let n = 0;
beforeEach(() => { dir = join(root, `u${++n}`); mkdirSync(dir, { recursive: true }); file = join(dir, '.autopilot', 'state.json'); });

const T0 = Date.parse('2026-11-25T03:00:00.000Z');

function harness() {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const pilot = createAutopilot({ file, now: () => T0, coordinator: true, log: (e, d) => { logs.push([e, d]); },
    raiseDecision: () => 'D-x', postProgress: () => {} });
  pilot.refresh();
  const derived = () => logs.filter(([e]) => e === 'goal-derived').map(([, d]) => d);
  return { pilot, logs, derived };
}

const ordinary = (i: number) => ({ msgId: 100 + i, crownDirective: null, text: `[from TC · request]\nmsg:${100 + i} · PR #${4000 + i} 리뷰 부탁` });
const crown = { msgId: 200, crownDirective: '777', text: '[from OPC · request · crown]\nmsg:200 · 데모 전 TUI 답변 소멸 결함 먼저 고쳐라\n세부는 칸 참조' };

test('a coordinator starts ON with no goal (NO-RELEASE-GOAL: nothing derived from the release)', () => {
  const h = harness();
  expect(h.pilot.state().on).toBe(true);
  expect(h.pilot.state().goal).toBeUndefined();
  expect(h.derived()).toEqual([]);
  expect(h.pilot.goalFeed()).toBeNull();
});

test('10 ordinary mails → goal changes 0 (no goal-derived, goal untouched)', () => {
  const h = harness();
  for (let i = 0; i < 10; i += 1) expect(h.pilot.observeMail([ordinary(i)])).toBe(false);
  expect(h.pilot.state().goal).toBeUndefined();
  expect(h.derived().length).toBe(0);
  expect(readAutopilotState(file)?.firstClass).toBeUndefined();
});

test('1 crown mail → goal becomes that directive exactly once; the same crown mail ×3 → still one change and one block', () => {
  const h = harness();
  expect(h.pilot.observeMail([crown])).toBe(true);
  expect(h.pilot.state().goal).toBe('[지시] 데모 전 TUI 답변 소멸 결함 먼저 고쳐라');
  for (let i = 0; i < 3; i += 1) expect(h.pilot.observeMail([crown])).toBe(false);
  expect(h.derived()).toEqual([
    { tier: 'first-class', source: 'crown:777', goal: '[지시] 데모 전 TUI 답변 소멸 결함 먼저 고쳐라', reason: 'crown-mail' },
  ]);
  expect(readAutopilotState(file)?.firstClass?.length).toBe(1);
  const block = h.pilot.goalFeed()!;
  expect(block).toBe('<!-- autopilot-goal-feed -->\n🎯 지금 골: [지시] 데모 전 TUI 답변 소멸 결함 먼저 고쳐라 (1급 골 · crown:777)\n'
    + '보통 우편·요청은 골을 바꾸지 않는다 — 약속 원장·체크리스트에 적고 이 골을 향해 간다.');
  // Re-feeding three turns: the block at the head is replaced, never stacked.
  let blocks = ['els', 'owner'];
  for (let i = 0; i < 3; i += 1) blocks = withGoalFeed(blocks, h.pilot.goalFeed());
  expect(blocks.filter((b) => b.includes('🎯 지금 골')).length).toBe(1);
  expect(blocks).toEqual([block, 'els', 'owner']);
});

test('crown closed → no goal (nothing standing returns); the re-delivered crown mail does not re-open it', async () => {
  const h = harness();
  h.pilot.observeMail([crown]);
  const closed = await dispatchAutopilotTool('autopilot_set', { goal_done: true }, { cwd: dir, file, now: () => T0 });
  expect(closed).toEqual({ ok: true, status: '🎯 1급 골 닫힘: [지시] 데모 전 TUI 답변 소멸 결함 먼저 고쳐라 — 지금 골: (없음)' });
  h.pilot.refresh();
  expect(h.pilot.state().goal).toBeUndefined();
  expect(h.pilot.observeMail([crown])).toBe(false);
  expect(h.pilot.state().goal).toBeUndefined();
  expect(h.pilot.goalFeed()).toBeNull();
});

test('explicit hold → the crown is recorded but no goal change is applied to autopilot state; resume applies it', () => {
  const h = harness();
  h.pilot.set({ on: true, hold: true }, 'slash');
  expect(h.pilot.observeMail([crown])).toBe(false);
  expect(h.pilot.state().goal).toBeUndefined();
  expect(h.pilot.state().derived).toBeUndefined();
  expect(h.logs.filter(([e]) => e === 'goal-derived-held').length).toBe(1);
  h.pilot.set({ on: true }, 'slash');
  expect(h.pilot.state().goal).toBe('[지시] 데모 전 TUI 답변 소멸 결함 먼저 고쳐라');
});

test('keystrokes are irrelevant to the goal', () => {
  const h = harness();
  h.pilot.observeMail([crown]);
  for (let i = 0; i < 5; i += 1) h.pilot.noteHuman();
  expect(h.pilot.state().goal).toBe('[지시] 데모 전 TUI 답변 소멸 결함 먼저 고쳐라');
  expect(h.derived().length).toBe(1);
});

test('an autonomous turn cannot set the goal (ordinary request handled by the model is refused)', async () => {
  const h = harness();
  h.pilot.noteTurnStart('auto');
  const out = await dispatchAutopilotTool('autopilot_set', { on: true, goal: 'TC 가 부탁한 PR 리뷰' }, { cwd: dir, file, now: () => T0 });
  expect(out).toEqual({ error: '골은 사람·대표 지시만 바꾼다 — 보통 우편·요청은 약속 원장·체크리스트에 적는다' });
  h.pilot.refresh();
  expect(h.pilot.state().goal).toBeUndefined();
});

test('classification reads only crownDirective: alert / human-origin / request mail without it is not a goal', () => {
  expect(firstClassFromMail({ msgId: 1, crownDirective: '  ', text: 'x' }, T0)).toBeNull();
  expect(firstClassFromMail({ msgId: 1, text: '[from JUD · alert]\nmsg:1 · 게이트 빨강' }, T0)).toBeNull();
  expect(firstClassFromMail({ msgId: 2, crownDirective: '42' }, T0)).toEqual({ id: 'crown:42', source: 'crown', text: '[지시] 42', at: T0 });
  expect(goalFeedBlock(null)).toBeNull();
});

// #40017 FED-MAIL-WORK-ORDER framing (literal — the exact notice text a trusted crown mail produces).
const FRAMED = '연방 자리가 보낸 업무 지시입니다(신뢰 발신자). 네 역할·헌장 안에서 실행하고, 받은 턴 첫 줄에 «받음 + 첫 행동»을 쓴다. 파괴적 작업(삭제·발행·돈·비밀)은 평소 승인 규칙을 따른다.\n'
  + '<federation_work_order from="OPC" intent="request" msg="4242" crown="yes">\n[from OPC · request · crown]\nmsg:4242 · 시험 1급 골\n세부는 칸 참조\n</federation_work_order>\n\n[미읽음 총 3통]';

test('framed work-order notice: the goal comes from the mail body, never the trusted-sender lead line or the frame', () => {
  expect(firstClassFromMail({ msgId: 4242, crownDirective: '9', text: FRAMED }, T0)?.text).toBe('[지시] 시험 1급 골');
  expect(firstClassFromMail({ msgId: 4242, crownDirective: '9', text: FRAMED, body: '\n시험 1급 골\n세부는 칸 참조' }, T0)?.text).toBe('[지시] 시험 1급 골');
  const h = harness();
  h.pilot.observeMail([{ msgId: 4242, crownDirective: '9', text: FRAMED, body: '시험 1급 골\n세부는 칸 참조' }]);
  expect(h.pilot.state().goal).toBe('[지시] 시험 1급 골');
  expect(h.pilot.statusText().startsWith('🚗 AUTO · [지시] 시험 1급 골')).toBe(true);
});
