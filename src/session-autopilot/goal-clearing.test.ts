// AUTOPILOT-GOAL-CLEARING — literal expectations (fresh temp universe per test · injected clock · injected release resolver).
// Incident 11-25: «0.3.36 로스터 재조정» stayed in the 🚗 chip 1h+ after another seat finished the roster; crown directives
// stacked on top; the seat kept spending turns on mail-reply follow-ups.
import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutopilot, readAutopilotState } from './autopilot.js';
import { dispatchAutopilotTool } from './autopilot-tool.js';
import { goalDoneMail, goalDoneRefs, parseDoneCheck } from './goal-clearing.js';
import { registerSeatBootCommands } from '../cli/seat-cli.js';
import { MsgStore } from '../msg/msg-store.js';

const root = mkdtempSync(join(tmpdir(), 'goal-clear-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dir = '';
let file = '';
let n = 0;
beforeEach(() => { dir = join(root, `u${++n}`); mkdirSync(dir, { recursive: true }); file = join(dir, '.autopilot', 'state.json'); });

const T0 = Date.parse('2026-11-25T05:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const hhmm = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function harness(opts: { slowCheck?: () => Promise<boolean> } = {}) {
  let t = T0;
  const logs: Array<[string, Record<string, unknown>]> = [];
  const notices: string[] = [];
  const losses: string[] = [];
  const cards: string[] = [];
  const pilot = createAutopilot({ file, now: () => t, coordinator: true, checkRoot: dir, handoffDir: join(dir, 'handoffs'),
    log: (e, d) => { logs.push([e, d]); }, notify: (line) => { notices.push(line); }, lossLedger: (line) => { losses.push(line); },
    raiseDecision: (card) => { cards.push(card.title); return `D-${cards.length}`; }, postProgress: () => {},
    standingGoal: () => ({ version: '0.3.36', phase: '개발' }), ...(opts.slowCheck ? { slowCheck: opts.slowCheck } : {}) });
  pilot.refresh();
  pilot.noteTurnStart('human');
  return { pilot, logs, notices, losses, cards, advance: (ms: number) => { t += ms; }, now: () => t,
    events: (name: string) => logs.filter(([e]) => e === name).map(([, d]) => d) };
}

const goal = (h: ReturnType<typeof harness>, text: string, extra: Record<string, unknown> = {}) =>
  h.pilot.set({ on: true, goal: text, doneCriterion: `${text} 끝`, kind: 'autopilot', deadline: iso(h.now() + 120 * MIN), expectedTurns: 4, ...extra }, 'tool');

test('check-based clear: done_check «file:plans/X.md» — the next tick after the file appears clears the goal', () => {
  const h = harness();
  expect(goal(h, '0.3.36 로스터 재조정', { doneCheck: 'file:plans/X.md' })).toEqual({ ok: true, text: '🚗 AUTO · 0.3.36 로스터 재조정 · demo D-1' });
  h.advance(MIN);
  h.pilot.tick();
  expect(h.pilot.state().goal).toBe('0.3.36 로스터 재조정');
  mkdirSync(join(dir, 'plans'), { recursive: true });
  writeFileSync(join(dir, 'plans', 'X.md'), '# final\n');
  h.pilot.tick();
  expect(h.pilot.state().goal).toBe('0.3.36 개발');
  expect(h.events('goal-cleared')).toEqual([{ by: 'check', goal: '0.3.36 로스터 재조정', id: h.pilot.history()[0]!.id, outcome: 'done' }]);
  expect(h.notices).toContain('✓ goal cleared: 0.3.36 로스터 재조정 (done by check)');
  expect(h.pilot.takeNudges()).toEqual(['✓ goal cleared: 0.3.36 로스터 재조정 (done by check)']);
  expect(h.pilot.statusText()).toBe('🚗 AUTO · 0.3.36 개발 · demo D-1');
  expect(readAutopilotState(file)?.life).toBeUndefined();
});

test('slow check (pr merged) runs async and clears on the next tick', async () => {
  const h = harness({ slowCheck: async () => true });
  goal(h, 'PR 40100 착지', { doneCheck: 'pr:40100' });
  h.pilot.tick();
  await Promise.resolve(); await Promise.resolve();
  h.pilot.tick();
  expect(h.events('goal-cleared').map((d) => [d.by, d.goal])).toEqual([['check', 'PR 40100 착지']]);
});

test('mail-based clear: another seat\'s goal-done mail (ref or body token) clears the goal; a reply from the check seat clears too', () => {
  expect(goalDoneMail({ from: 'OPC', to: 'OP', goalRef: 'current', reason: 'ROSTER-0.3.36-FINAL.md written' }))
    .toEqual({ from: 'OPC', to: 'OP', intent: 'info', refs: ['goal-done:current'], body: 'goal-done:current — ROSTER-0.3.36-FINAL.md written' });
  expect(goalDoneRefs({ body: 'goal-done:로스터 재조정 — done' })).toEqual(['로스터']);
  const h = harness();
  goal(h, '0.3.36 로스터 재조정');
  expect(h.pilot.observeMail([{ msgId: 9001, sender: 'OPC', refs: ['goal-done:current'], body: 'goal-done:current — ROSTER-0.3.36-FINAL.md written' }])).toBe(true);
  expect(h.pilot.state().goal).toBe('0.3.36 개발');
  expect(h.events('goal-cleared').map((d) => [d.by, d.goal, d.reason])).toEqual([['mail', '0.3.36 로스터 재조정', 'OPC msg:9001']]);
  expect(h.notices).toContain('✓ goal cleared: 0.3.36 로스터 재조정 (done by mail)');

  h.advance(31 * MIN);
  goal(h, 'JUD 판정 회신 받기', { doneCheck: 'mail:JUD' });
  h.pilot.observeMail([{ msgId: 9002, sender: 'TC', body: '무관한 우편' }]);
  expect(h.pilot.state().goal).toBe('JUD 판정 회신 받기');
  h.pilot.observeMail([{ msgId: 9003, sender: 'JUD', body: '판정 PASS', createdAt: iso(h.now()) }]);
  expect(h.pilot.state().goal).toBe('0.3.36 개발');
});

test('deadline: one nudge at the deadline, then expired 30 min later with a loss-ledger line', () => {
  const h = harness();
  goal(h, '택틱 한 장', { deadline: iso(T0 + 60 * MIN) });
  h.advance(60 * MIN);
  h.pilot.tick();
  h.pilot.tick();
  expect(h.pilot.takeNudges()).toEqual(['⏰ goal past due: 택틱 한 장 — close with partial result, extend with new deadline, or drop (reason)']);
  expect(h.events('goal-nudge-due').length).toBe(1);
  expect(h.pilot.goalFeed()).toContain(`\n⏰ 기한 ${hhmm(T0 + 60 * MIN)} · id `);
  h.advance(30 * MIN);
  h.pilot.tick();
  expect(h.pilot.state().goal).toBe('0.3.36 개발');
  expect(h.events('goal-expired').map((d) => d.goal)).toEqual(['택틱 한 장']);
  expect(h.losses.length).toBe(1);
  expect(h.losses[0]!.startsWith(`- ${iso(T0 + 90 * MIN)} · expired · 택틱 한 장 · id=human:`)).toBe(true);
  expect(h.losses[0]!.endsWith(' · tokens=0 · turns=0 · no action 30 min past due')).toBe(true);
  expect(h.pilot.pinRows()).toEqual(['🎯 history: 택틱 한 장 (expired)']);
});

test('deadline answered: extend moves the deadline (no expiry); drop needs a reason and writes the loss ledger', () => {
  const h = harness();
  goal(h, '택틱 한 장', { deadline: iso(T0 + 60 * MIN) });
  h.advance(60 * MIN);
  h.pilot.tick();
  expect(h.pilot.set({ on: true, deadline: iso(T0 + 150 * MIN) }, 'tool')).toEqual({ ok: true, text: `⏰ 기한 연장: 택틱 한 장 → ${hhmm(T0 + 150 * MIN)}` });
  h.advance(40 * MIN);
  h.pilot.tick();
  expect(h.pilot.state().goal).toBe('택틱 한 장');
  expect(h.pilot.set({ goalDone: true, outcome: 'dropped' }, 'tool')).toEqual({ ok: false, text: '골 포기(outcome:"dropped")에는 사유(reason)가 필요하다' });
  expect(h.pilot.set({ goalDone: true, outcome: 'dropped', reason: '대표가 방향 바꿈' }, 'tool').ok).toBe(true);
  expect(h.losses.length).toBe(1);
  expect(h.losses[0]!.endsWith(' · 대표가 방향 바꿈')).toBe(true);
  expect(h.pilot.history().map((a) => [a.text, a.outcome, a.by])).toEqual([['택틱 한 장', 'dropped', 'tool']]);
});

test('supersede: a new goal archives the open one as «superseded» and the 🎯 history line lists it', () => {
  const h = harness();
  goal(h, '로스터 재조정');
  h.advance(31 * MIN);
  goal(h, '데모 리허설');
  expect(h.pilot.state().goal).toBe('데모 리허설');
  expect(h.pilot.history().map((a) => [a.text, a.outcome])).toEqual([['로스터 재조정', 'superseded']]);
  expect(h.notices).toContain('🎯 goal superseded: 로스터 재조정 → 데모 리허설');
  expect(h.pilot.pinRows()).toEqual(['🎯 history: 로스터 재조정 (superseded)']);
  expect(h.pilot.goalFeed()).toContain('\n🎯 history: 로스터 재조정 (superseded)');
});

test('crown while a first-class goal is open → a P0 pin (bar met); below the bar → a normal turn; goal:replace → replaces', () => {
  const h = harness();
  goal(h, '로스터 재조정');
  h.pilot.observeMail([{ msgId: 1, crownDirective: '501', body: 'TUI 답변 소멸 결함 먼저', doneWhen: '수리 PR 착지', deadlineAt: iso(T0 + 90 * MIN) }]);
  expect(h.pilot.state().goal).toBe('로스터 재조정');
  expect(h.pilot.pinRows()).toEqual([`📌 1/1 [지시] TUI 답변 소멸 결함 먼저 · done when: 수리 PR 착지 · due ${hhmm(T0 + 90 * MIN)} · P0`]);
  h.pilot.observeMail([{ msgId: 2, crownDirective: '502', body: '상태 알려줘' }]);
  expect(h.pilot.pins().length).toBe(1);
  expect(h.events('goal-rejected')).toEqual([{ reason: 'crown-below-bar', goal: '[지시] 상태 알려줘', id: 'crown:502' }]);
  h.pilot.observeMail([{ msgId: 3, crownDirective: '503', body: '판 방향 전환: 0.3.37 로 간다', refs: ['goal:replace'] }]);
  expect(h.pilot.state().goal).toBe('[지시] 판 방향 전환: 0.3.37 로 간다');
  expect(h.pilot.history().map((a) => [a.text, a.outcome])).toEqual([['로스터 재조정', 'superseded']]);
});

test('threshold: too small · no deadline · ≤1 autopilot goal / 30 min · ≤3 pin changes / 30 min — each logged goal-rejected', async () => {
  const h = harness();
  expect(goal(h, '상태 확인', { expectedTurns: 1 })).toEqual({ ok: false, text: '골은 여러 턴 일만 — expected_turns ≥ 3 또는 expected_minutes > 15 을 적는다. 상태 확인·답장·한 걸음 일은 그냥 이번 턴에 한다' });
  expect(await dispatchAutopilotTool('autopilot_set', { on: true, goal: '로스터', done_criterion: '표 발송', kind: 'autopilot', expected_turns: 3 }, { cwd: dir, file, now: () => h.now() }))
    .toEqual({ error: '골에는 기한(deadline «HH:MM»·ISO)이 필요하다' });
  expect(goal(h, '로스터 재조정').ok).toBe(true);
  h.advance(10 * MIN);
  expect(goal(h, '다른 골')).toEqual({ ok: false, text: '자율주행 골은 30분에 1개까지 — 지금 골을 끝내거나(goal_done) 30분 뒤에 바꾼다' });
  h.pilot.noteTurnStart('human', '이거 골로 잡아'); const pin = (text: string) => h.pilot.set({ explicitAsk: '골로 잡아', on: true, goal: text, doneCriterion: `${text} 끝`, deadline: iso(h.now() + 60 * MIN), expectedMinutes: 20 }, 'tool');
  expect([pin('핀 1').ok, pin('핀 2').ok, pin('핀 3').ok]).toEqual([true, true, true]);
  expect(pin('핀 4')).toEqual({ ok: false, text: '작업 골(핀) 변경은 30분에 3번까지 — 지금 핀부터 끝낸다' });
  expect(h.events('goal-rejected').map((d) => d.reason)).toEqual(['too-small', 'rate-autopilot', 'rate-pin']);
});

test('escape stall → narrow: 4 turns without a state change → 30-min deadline + one notice + loss line', () => {
  const h = harness();
  goal(h, '로스터 재조정');
  for (let i = 0; i < 4; i += 1) { h.pilot.noteHuman(); h.pilot.turnEnded({ selfInitiated: false, failed: false, fingerprint: `답장 ${i}`, stateChanged: false }); }
  expect(h.events('goal-escape')).toEqual([{ kind: 'narrow', goal: '로스터 재조정', id: h.pilot.lives()[0]!.id, tokens: 0, turns: 4 }]);
  expect(h.pilot.lives()[0]!.deadline).toBe(T0 + 30 * MIN);
  expect(h.notices).toContain(`⤴ escape: narrow — «로스터 재조정» stalled; shrink it to the next smallest deliverable and finish by ${hhmm(T0 + 30 * MIN)}`);
  expect(h.losses.length).toBe(1);
});

test('escape thrash → freeze: the 2nd replacement within 30 min keeps the oldest goal, the others become pins, changes frozen', () => {
  const h = harness();
  h.pilot.set({ on: true, goal: 'A 로스터', kind: 'autopilot' }, 'slash');
  h.advance(5 * MIN);
  h.pilot.set({ on: true, goal: 'B 데모', kind: 'autopilot' }, 'slash');
  h.advance(5 * MIN);
  h.pilot.set({ on: true, goal: 'C 착지', kind: 'autopilot' }, 'slash');
  expect(h.pilot.state().goal).toBe('A 로스터');
  expect(h.pilot.pins().map((p) => p.text).sort()).toEqual(['B 데모', 'C 착지']);
  expect(h.events('goal-escape').map((d) => [d.kind, d.goal])).toEqual([['freeze', 'A 로스터']]);
  expect(h.notices).toContain(`⤴ escape: freeze — goal replaced too often; «A 로스터» stays, the others became pins; goal changes frozen until ${hhmm(T0 + 40 * MIN)}`);
  h.advance(5 * MIN);
  h.pilot.set({ on: true, goal: 'D 기타', kind: 'autopilot' }, 'slash');
  expect(h.pilot.state().goal).toBe('A 로스터');
  expect(h.events('goal-rejected').map((d) => d.reason)).toEqual(['frozen']);
});

test('escape token burn → hand off: > 300k tokens → handoff note + decision card + notice', () => {
  const h = harness();
  goal(h, '로스터 재조정');
  h.pilot.noteHuman();
  h.pilot.turnEnded({ selfInitiated: false, failed: false, tokens: 180_000, stateChanged: true });
  expect(h.cards).toEqual([]);
  h.pilot.noteHuman();
  h.pilot.turnEnded({ selfInitiated: false, failed: false, tokens: 130_000, stateChanged: true });
  expect(h.cards).toEqual(['goal hand-off · 로스터 재조정']);
  const id = h.pilot.lives()[0]!.id;
  const note = join(dir, 'handoffs', `${id.replace(/[^A-Za-z0-9_-]+/gu, '_')}.md`);
  expect(readFileSync(note, 'utf8').split('\n').slice(0, 1)).toEqual(['# Hand-off · 로스터 재조정']);
  expect(h.events('goal-escape')).toEqual([{ kind: 'hand-off', goal: '로스터 재조정', id, tokens: 310_000, turns: 2, note, decisionId: 'D-1' }]);
  expect(h.notices).toContain(`⤴ escape: hand off — «로스터 재조정» burned its budget; handoff note ${note}; delegate to a space coordinator/hand or decide on card D-1`);
});

test('escape loop → break loop: the same tool + args 3× → stop it, diagnosis line', () => {
  const h = harness();
  goal(h, '로스터 재조정');
  const sig = 'msg_post:{"to":"OPC","body":"진행 중"}';
  for (let i = 0; i < 3; i += 1) { h.pilot.noteHuman(); h.pilot.turnEnded({ selfInitiated: false, failed: false, toolSigs: [sig], stateChanged: true }); }
  expect(h.events('goal-escape').map((d) => [d.kind, d.sig])).toEqual([['break-loop', sig]]);
  expect(h.pilot.takeNudges()).toEqual([`⤴ escape: break loop — «로스터 재조정» repeats ${sig}; stop it, write a one-line diagnosis, try another path`]);
});

test('escape blocked → parallel: waiting on replies > 15 min parks the goal as a pin; the reply wakes it', () => {
  const h = harness();
  goal(h, 'JUD 판정 받기');
  h.pilot.noteHuman();
  h.pilot.turnEnded({ selfInitiated: false, failed: false, waitingOn: 1, stateChanged: true });
  h.advance(16 * MIN);
  h.pilot.tick();
  expect(h.pilot.state().goal).toBe('0.3.36 개발');
  expect(h.pilot.pins().map((p) => p.text)).toEqual(['JUD 판정 받기']);
  expect(h.events('goal-escape').map((d) => d.kind)).toEqual(['parallel']);
  expect(h.pilot.takeNudges()).toEqual(['⤴ escape: parallel — «JUD 판정 받기» parked until the reply arrives; pull the next roster item']);
  h.pilot.observeMail([{ msgId: 77, sender: 'JUD', replyTo: 70, body: 'PASS' }]);
  expect(h.pilot.lives()[0]!.parked).toBeUndefined();
  expect(h.pilot.takeNudges()).toEqual(['↩ reply arrived for parked goal: JUD 판정 받기']);
});

test('done_check parser: the short forms', () => {
  expect(['file:plans/X.md', 'file-updated:~/a.md', 'pr:40100', 'mail:opc', 'checklist:0.3.36:done>=10', 'checklist:0.3.36:A1=done', 'nope'].map(parseDoneCheck)).toEqual([
    { kind: 'file', path: 'plans/X.md' }, { kind: 'file', path: '~/a.md', updated: true }, { kind: 'pr-merged', pr: 40100 }, { kind: 'mail', from: 'OPC' },
    { kind: 'checklist', version: '0.3.36', status: 'done', min: 10 }, { kind: 'checklist', version: '0.3.36', id: 'A1', status: 'done' }, null,
  ]);
});

test('`eln seat goal-done OP current --reason … --from OPC` posts the structured mail; the seat clears its goal on arrival', async () => {
  const msgPath = join(dir, 'msg', 'messages.db');
  const out: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((line: string) => { out.push(line); });
  const cli = new Command();
  registerSeatBootCommands(cli.command('seat'), { msgPath: () => msgPath });
  try { await cli.parseAsync(['seat', 'goal-done', 'OP', 'current', '--reason', 'ROSTER-0.3.36-FINAL.md written', '--from', 'OPC'], { from: 'user' }); }
  finally { spy.mockRestore(); }
  expect(out).toEqual(['goal-done mail #1 → OP: goal-done:current — ROSTER-0.3.36-FINAL.md written']);
  const store = new MsgStore(msgPath);
  const rows = store.listByRecipient('OP', 0, 10);
  store.close();
  expect(rows.map((m) => [m.from, m.refs, m.intent])).toEqual([['OPC', ['goal-done:current'], 'info']]);
  const h = harness();
  goal(h, '0.3.36 로스터 재조정');
  h.pilot.observeMail(rows.map((m) => ({ msgId: m.id, sender: m.from, body: m.body, ...(m.refs ? { refs: m.refs } : {}) })));
  expect(h.pilot.state().goal).toBe('0.3.36 개발');
  expect(h.events('goal-cleared').map((d) => [d.by, d.reason])).toEqual([['mail', 'OPC msg:1']]);
});
