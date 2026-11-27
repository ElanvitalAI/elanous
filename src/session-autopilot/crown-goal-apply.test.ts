// CROWN-GOAL-APPLY — literal expectations (fresh temp universe per test · injected clock · no release-derived goal).
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutopilot, readAutopilotState } from './autopilot.js';
import { goalApplyFromMail, goalAppliedLine, goalSetEnvelope, goalSetterVerdict, maySetGoal } from './crown-goal-apply.js';
import { MsgStore } from '../msg/msg-store.js';

const root = mkdtempSync(join(tmpdir(), 'crown-goal-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dir = '';
let file = '';
let n = 0;
beforeEach(() => { dir = join(root, `u${++n}`); mkdirSync(dir, { recursive: true }); file = join(dir, '.autopilot', 'state.json'); });

const T0 = Date.parse('2026-11-25T03:00:00.000Z');

function harness() {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const notes: string[] = [];
  const pilot = createAutopilot({ file, now: () => T0, coordinator: true, log: (e, d) => { logs.push([e, d]); }, notify: (line) => { notes.push(line); },
    raiseDecision: () => 'D-x', postProgress: () => {} });
  pilot.refresh();
  return { pilot, logs, notes, events: (name: string) => logs.filter(([e]) => e === name).map(([, d]) => d) };
}

const staleCrown = { msgId: 150, crownDirective: '700', sender: 'CLAUDE-OP', body: '오전 결과 전체를 한 장으로', text: 'msg:150 · 오전 결과 전체를 한 장으로' };

test('retracting a task goal mail removes its pin without reopening it', () => {
  const h = harness();
  const mail = { msgId: 160, sender: 'OP', goal: '정리 작업', refs: ['goal:task'], doneWhen: '정리 완료', deadlineAt: new Date(T0 + 3_600_000).toISOString() };
  expect(h.pilot.observeMail([mail])).toBe(true);
  expect(h.pilot.observeMail([{ msgId: 161, sender: 'OP', supersedes: 160 }])).toBe(true);
  expect(h.pilot.state().pins ?? []).toHaveLength(0);
  expect(h.pilot.observeMail([mail])).toBe(false);
});
test('unauthorized retraction cannot remove an authorized task pin', () => {
  const h = harness();
  const mail = { msgId: 160, sender: 'OP', goal: '정리 작업', refs: ['goal:task'], doneWhen: '정리 완료', deadlineAt: new Date(T0 + 3_600_000).toISOString() };
  expect(h.pilot.observeMail([mail])).toBe(true);
  h.pilot.observeMail([{ msgId: 161, sender: 'TC', supersedes: 160 }]);
  expect(h.pilot.state().pins).toHaveLength(1);
});

test('retraction in same delivery prevents task pin reopening', () => {
  const h = harness();
  const mail = { msgId: 160, sender: 'OP', goal: '정리 작업', refs: ['goal:task'], doneWhen: '정리 완료', deadlineAt: new Date(T0 + 3_600_000).toISOString() };
  h.pilot.observeMail([{ msgId: 161, sender: 'OP', supersedes: 160 }, mail]);
  expect(h.pilot.state().pins ?? []).toHaveLength(0);
});

test('authorized task goal mail creates a pin without replacing the autopilot goal', () => {
  const h = harness();
  h.pilot.observeMail([staleCrown]);
  const before = h.pilot.state().goal;
  const mail = { msgId: 160, sender: 'OP', goal: '정리 작업', refs: ['goal:task'], doneWhen: '정리 완료', deadlineAt: new Date(T0 + 3_600_000).toISOString() };
  expect(h.pilot.observeMail([mail])).toBe(true);
  expect(h.pilot.state().goal).toBe(before);
  expect(h.pilot.state().pins?.map((p) => [p.text, p.done])).toEqual([['정리 작업', '정리 완료']]);
  expect(h.pilot.observeMail([mail])).toBe(false);
});

test('task mail fails closed without a done condition or future deadline', () => {
  const h = harness();
  h.pilot.observeMail([staleCrown]);
  const before = h.pilot.state().goal;
  const base = { sender: 'OP', goal: 'task', refs: ['goal:task'] };
  expect(h.pilot.observeMail([{ ...base, msgId: 161, deadlineAt: new Date(T0 + 1000).toISOString() }])).toBe(false);
  expect(h.pilot.observeMail([{ ...base, msgId: 162, doneWhen: 'done', deadlineAt: new Date(T0 - 1000).toISOString() }])).toBe(false);
  expect(h.pilot.state().goal).toBe(before);
  expect(h.pilot.state().pins ?? []).toEqual([]);
});
test('maySetGoal: OP and CLAUDE-OP may; TC may not; any sender with a crown-directive id may', () => {
  expect(maySetGoal('OP')).toBe(true);
  expect(maySetGoal('claude-op')).toBe(true);
  expect(maySetGoal('TC')).toBe(false);
  expect(maySetGoal(undefined)).toBe(false);
  expect(maySetGoal('TC', '812')).toBe(true);
  expect(maySetGoal('TC', '  ')).toBe(false);
});

test('goalApplyFromMail reads the structured field only (no goal field = none, whatever the body says)', () => {
  expect(goalApplyFromMail({ msgId: 9, sender: 'OP', goal: null }, T0)).toEqual({ kind: 'none' });
  expect(goalApplyFromMail({ msgId: 9, sender: 'OP', goal: '   ' }, T0)).toEqual({ kind: 'none' });
  expect(goalApplyFromMail({ msgId: 9, sender: 'OP', goal: '  착지 10/시간 ' }, T0))
    .toEqual({ kind: 'apply', goal: '착지 10/시간', crown: false, source: 'mail:OP', id: 'goal:9', by: 'OP' });
  expect(goalApplyFromMail({ msgId: 10, sender: 'TC', goal: '착지 10/시간', crownDirective: '812' }, T0))
    .toEqual({ kind: 'apply', goal: '착지 10/시간', crown: true, source: 'crown:812', id: 'goal:10', by: 'TC' });
  expect(goalApplyFromMail({ msgId: 11, sender: 'TC', goal: '착지 10/시간' }, T0))
    .toEqual({ kind: 'refused', reason: 'sender-not-allowed', detail: 'TC is not OP / CLAUDE-OP and no federation ladder places it above the seat', sender: 'TC', goal: '착지 10/시간' });
});

test('goalSetEnvelope: structured goal field + info intent; a non-setter is refused', () => {
  expect(goalSetEnvelope({ from: 'op', seat: 'op', goal: '착지 10/시간' })).toEqual({
    from: 'OP', to: 'OP', intent: 'info', kind: 'goal', goal: '착지 10/시간', body: 'Autopilot goal set by OP: 착지 10/시간' });
  expect(() => goalSetEnvelope({ from: 'TC', seat: 'OP', goal: 'x' })).toThrow('TC is not OP / CLAUDE-OP and no federation ladder places it above OP — only OP / CLAUDE-OP (any seat), a space coordinator (its own hands) or --crown-directive <id> may set a seat goal');
  expect(() => goalSetEnvelope({ from: 'OP', seat: 'OP', goal: '  ' })).toThrow('goal must be nonempty');
});

test('goalAppliedLine: English, names sender and msg id', () => {
  expect(goalAppliedLine({ goal: '착지 10/시간', sender: 'OP', msgId: 42, applied: true })).toBe('🎯 Goal set by OP (msg #42): 착지 10/시간');
  expect(goalAppliedLine({ goal: '착지 10/시간', sender: 'OP', applied: false })).toBe('🎯 Goal set by OP: 착지 10/시간 — applies when autopilot is on');
});

test('a stale crown goal is open → an OP goal mail replaces the chip at once, logs goal-applied and one transcript line', () => {
  const h = harness();
  expect(h.pilot.observeMail([staleCrown])).toBe(true);
  expect(h.pilot.state().goal).toBe('[지시] 오전 결과 전체를 한 장으로');
  // A second crown mail without a goal field and without goal:replace does NOT re-aim the chip (the 11:0x failure).
  h.pilot.observeMail([{ msgId: 151, crownDirective: '701', sender: 'CLAUDE-OP', body: '골을 착지 10/시간 으로', text: 'msg:151 · 골을 착지 10/시간 으로' }]);
  expect(h.pilot.state().goal).toBe('[지시] 오전 결과 전체를 한 장으로');
  // The structured goal field does.
  expect(h.pilot.observeMail([{ msgId: 160, sender: 'OP', goal: '착지 10/시간', body: 'Autopilot goal set by OP: 착지 10/시간', text: 'msg:160' }])).toBe(true);
  expect(h.pilot.state().goal).toBe('착지 10/시간');
  expect(readAutopilotState(file)?.goal).toBe('착지 10/시간');
  expect(h.events('goal-applied')).toEqual([{ source: 'mail:OP', by: 'OP', msgId: 160, goal: '착지 10/시간', applied: true }]);
  expect(h.notes.filter((l) => l.startsWith('🎯 Goal set'))).toEqual(['🎯 Goal set by OP (msg #160): 착지 10/시간']);
  expect(h.events('goal-superseded').map((d) => d.id)).toEqual(['crown:700']);
  expect(readAutopilotState(file)?.firstClass?.map((g) => g.id)).toEqual(['goal:160']);
  // Re-delivery of the same goal mail changes nothing.
  expect(h.pilot.observeMail([{ msgId: 160, sender: 'OP', goal: '착지 10/시간', body: 'x', text: 'msg:160' }])).toBe(false);
  expect(h.events('goal-applied').length).toBe(1);
});

test('three goal mails in a row are all applied (an explicit setter is never thrash-frozen)', () => {
  const h = harness();
  for (const [id, g] of [[301, 'A 골'], [302, 'B 골'], [303, 'C 골']] as const) {
    h.pilot.observeMail([{ msgId: id, sender: 'CLAUDE-OP', goal: g, body: g, text: `msg:${id}` }]);
    expect(h.pilot.state().goal).toBe(g);
  }
  expect(readAutopilotState(file)?.freezeUntil).toBeUndefined();
});

test('a goal field from a non-setter is refused and logged; the goal stays', () => {
  const h = harness();
  expect(h.pilot.observeMail([{ msgId: 170, sender: 'TC', goal: '내 골로 바꿔', body: 'x', text: 'msg:170' }])).toBe(false);
  expect(h.pilot.state().goal).toBeUndefined();
  expect(h.events('goal-apply-refused')).toEqual([{ reason: 'sender-not-allowed', sender: 'TC', msgId: 170, goal: '내 골로 바꿔' }]);
  expect(h.events('goal-applied')).toEqual([{ source: 'mail:TC', by: 'TC', msgId: 170, goal: '내 골로 바꿔', applied: false, reason: 'sender-not-allowed',
    detail: 'TC is not OP / CLAUDE-OP and no federation ladder places it above the seat' }]);
});

test('a crown mail with a goal field: crown source, and the old crown path does not also pin it', () => {
  const h = harness();
  h.pilot.observeMail([staleCrown]);
  h.pilot.observeMail([{ msgId: 180, sender: 'CLAUDE-OP', crownDirective: '812', goal: '착지 10/시간', body: '골 = 착지 10/시간', text: 'msg:180' }]);
  expect(h.pilot.state().goal).toBe('[지시] 착지 10/시간');
  expect(h.pilot.pins()).toEqual([]);
  expect(h.events('goal-applied')).toEqual([{ source: 'crown:812', by: 'CLAUDE-OP', msgId: 180, goal: '착지 10/시간', applied: true }]);
});

test('msg store keeps the goal field (round trip) and an old row reads without it', () => {
  const store = new MsgStore(join(dir, 'messages.db'));
  try {
    const posted = store.post(goalSetEnvelope({ from: 'OP', seat: 'OP', goal: '착지 10/시간' }));
    const plain = store.post({ from: 'OP', to: 'TC', body: 'hello' });
    expect(store.getMessage(posted.id)?.goal).toBe('착지 10/시간');
    expect(store.getMessage(plain.id)?.goal).toBeUndefined();
    expect(store.listByRecipient('OP', 0, 10).map((m) => [m.id, m.goal])).toEqual([[posted.id, '착지 10/시간']]);
  } finally { store.close(); }
});

// ── GOAL-SET-COORD-BY-OP — federation hierarchy (independent literal ladder; receiving seats are NOT role:coordinator) ──
const PARENT: Record<string, string> = { OP: 'CEO', TC: 'OP', UX: 'OP', JUD: 'OP', 'TC-H-CX-1': 'TC', 'UX-H-1': 'UX' };
const literalLadder = { hq: 'OP', parentOf: (seat: string) => PARENT[seat] ?? 'OP' };

/** A non-coordinator seat (TC · UX · a hand): autopilot never switched — the 13:15 state on TC/UX/JUD/RES/REL/MK. */
function seatHarness(seat: string) {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const pilot = createAutopilot({ file, now: () => T0, seat, federationLadder: () => literalLadder, log: (e, d) => { logs.push([e, d]); }, notify: () => {} });
  pilot.refresh();
  return { pilot, events: (name: string) => logs.filter(([e]) => e === name).map(([, d]) => d) };
}

test('goalSetterVerdict follows the ladder: OP/CLAUDE-OP any seat · coordinator over its hand · TC over UX refused · crown any', () => {
  expect(goalSetterVerdict({ sender: 'OP', seat: 'TC', ladder: literalLadder })).toEqual({ ok: true, by: 'hq' });
  expect(goalSetterVerdict({ sender: 'CLAUDE-OP', seat: 'UX', ladder: literalLadder })).toEqual({ ok: true, by: 'hq' });
  expect(goalSetterVerdict({ sender: 'TC', seat: 'TC-H-CX-1', ladder: literalLadder })).toEqual({ ok: true, by: 'coordinator' });
  expect(goalSetterVerdict({ sender: 'TC', seat: 'UX', ladder: literalLadder }))
    .toEqual({ ok: false, reason: 'not-above-target', detail: 'TC is not above UX on the federation ladder (parent of UX = OP)' });
  expect(goalSetterVerdict({ sender: 'TC', seat: 'UX-H-1', ladder: literalLadder }))
    .toEqual({ ok: false, reason: 'not-above-target', detail: 'TC is not above UX-H-1 on the federation ladder (parent of UX-H-1 = UX)' });
  expect(goalSetterVerdict({ sender: 'CLAUDE-OP', seat: 'JUD', crownDirective: 'CEO-1125-1320-COORD-OWNER', ladder: literalLadder })).toEqual({ ok: true, by: 'hq' });
  expect(goalSetterVerdict({ sender: '', seat: 'TC', ladder: literalLadder })).toEqual({ ok: false, reason: 'no-sender', detail: 'the mail names no sender' });
  expect(maySetGoal('TC', null, 'TC-H-CX-1', literalLadder)).toBe(true);
});

test('OP → TC (autopilot never on): the goal applies, autopilot switches ON, logged with by', () => {
  const h = seatHarness('TC');
  expect(h.pilot.observeMail([{ msgId: 162153, sender: 'OP', goal: '스페이스 주인: 유휴 손 0', body: 'x', text: 'msg:162153' }])).toBe(true);
  expect(h.pilot.state().goal).toBe('스페이스 주인: 유휴 손 0');
  expect(readAutopilotState(file)?.on).toBe(true);
  expect(readAutopilotState(file)?.by).toBe('goal-mail');
  expect(h.events('goal-applied')).toEqual([{ source: 'mail:OP', by: 'OP', msgId: 162153, goal: '스페이스 주인: 유휴 손 0', applied: true }]);
});

test('CLAUDE-OP → UX applies', () => {
  const h = seatHarness('UX');
  expect(h.pilot.observeMail([{ msgId: 162154, sender: 'CLAUDE-OP', goal: 'UX 스페이스 골', body: 'x', text: 'msg:162154' }])).toBe(true);
  expect(h.pilot.state().goal).toBe('UX 스페이스 골');
  expect(h.events('goal-applied')).toEqual([{ source: 'mail:CLAUDE-OP', by: 'CLAUDE-OP', msgId: 162154, goal: 'UX 스페이스 골', applied: true }]);
});

test('TC → its own hand applies', () => {
  const h = seatHarness('TC-H-CX-1');
  expect(h.pilot.observeMail([{ msgId: 500, sender: 'TC', goal: '손 골', body: 'x', text: 'msg:500' }])).toBe(true);
  expect(h.pilot.state().goal).toBe('손 골');
  expect(h.events('goal-applied')).toEqual([{ source: 'mail:TC', by: 'TC', msgId: 500, goal: '손 골', applied: true }]);
});

test('TC → UX is refused with the reason; the goal does not change', () => {
  const h = seatHarness('UX');
  expect(h.pilot.observeMail([{ msgId: 501, sender: 'TC', goal: '남의 골', body: 'x', text: 'msg:501' }])).toBe(false);
  expect(h.pilot.state().goal).toBeUndefined();
  expect(h.events('goal-applied')).toEqual([{ source: 'mail:TC', by: 'TC', msgId: 501, goal: '남의 골', applied: false, reason: 'not-above-target',
    detail: 'TC is not above UX on the federation ladder (parent of UX = OP)' }]);
});

test('crown from CLAUDE-OP → JUD (not a coordinator by role) applies with the crown source', () => {
  const h = seatHarness('JUD');
  expect(h.pilot.observeMail([{ msgId: 162177, sender: 'CLAUDE-OP', crownDirective: 'CEO-1125-1320-COORD-OWNER', goal: '판정국 주인 골', body: 'x', text: 'msg:162177' }])).toBe(true);
  expect(h.pilot.state().goal).toBe('[지시] 판정국 주인 골');
  expect(h.events('goal-applied')).toEqual([{ source: 'crown:CEO-1125-1320-COORD-OWNER', by: 'CLAUDE-OP', msgId: 162177, goal: '판정국 주인 골', applied: true }]);
});

test('an explicit human off is kept: the goal is recorded, applied:false with reason autopilot-off', () => {
  const h = seatHarness('TC');
  h.pilot.set({ on: true }, 'slash');
  h.pilot.set({ on: false }, 'slash');
  h.pilot.observeMail([{ msgId: 502, sender: 'OP', goal: '꺼진 자리 골', body: 'x', text: 'msg:502' }]);
  expect(readAutopilotState(file)?.on).toBe(false);
  expect(h.events('goal-applied')).toEqual([{ source: 'mail:OP', by: 'OP', msgId: 502, goal: '꺼진 자리 골', applied: false, reason: 'autopilot-off' }]);
});
