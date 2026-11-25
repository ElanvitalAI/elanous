// SIM-SEAT-TURN-CONTINUE — OP seat cases before/after (budget · drive · idle queue) and the two old fears (member fact
// question stays fast · no nag loop). Independent literals; no dynamic imports in test bodies.
import { expect, test } from 'bun:test';
import { decideGoalDrive, handCellState, isTaskGoal } from '../session-autopilot/goal-drive.js';
import { createSideEffectBudget, outwardActionKey } from '../llm/seat-action-stationarity.js';
import { SEAT_HAND_PULL_LINE } from '../seat/seat-turn-prose.js';
import { seatLeadership } from '../seat/seat-leadership.js';
import { leaderCard } from '../prompt-library/leader-card.js';
import { caseDelegatedResults, caseHandBlockPull, caseHandPull, caseIdleFlush, runAssignStormCase, runRequirementCase, runRetractCase, runLeaderCase, casePacingReset, caseWakeThrash, runFreshReadCase, runRepairPhaseCase, caseSeatProse, caseTable, driveGuards, FAMILIES, outboundTable, runOutboundCase, runRepeatCase, runSeatTurnCases, runSignalCase, runToolRoundsCase, signalTable } from './seat-turn-continue-world.js';

const rows = runSeatTurnCases();
const row = (id: string, arm: 'before' | 'after') => rows.find((r) => r.id.startsWith(id) && r.arm === arm)!;

test('sim table (printed for the PR body) · f — a terra OP turn needing 15 Bash rounds: before cut at round 4, after all 15', async () => {
  const f = await runToolRoundsCase();
  const family = [...await runToolRoundsCase(40, FAMILIES[0]), ...await runToolRoundsCase(40, FAMILIES[1])];
  const followups = [...await runRepeatCase(), ...caseDelegatedResults(), ...caseSeatProse(), ...caseHandPull(), ...caseHandBlockPull(), ...await runRepairPhaseCase(), ...casePacingReset(), ...caseWakeThrash(), ...await runFreshReadCase(), ...await runLeaderCase(), ...await runAssignStormCase(), ...await runRequirementCase(), ...caseIdleFlush(), ...await runRetractCase()];
  console.log(caseTable([...rows, ...f, ...family, ...followups]).join('\n'));
  // family dimension: the same 40-round Bash task — after, both families finish it (before = printed: the family caps)
  for (const r of family.filter((x) => x.arm === 'after')) expect(r.endReason).toBe('40/40 rounds · model-end');
  expect(family.find((r) => r.id.startsWith('f terra') && r.arm === 'before')!.endReason).toBe('4/40 rounds · forced synthesis');
  expect(rows.length).toBe(12);
  expect(f.find((r) => r.arm === 'before')!.endReason).toBe('4/15 rounds · forced synthesis');
  expect(f.find((r) => r.arm === 'after')!.endReason).toBe('15/15 rounds · model-end');
}, 60_000); // 출처: #40092 real tool loop · six arms of ≤ 41 provider requests

test('a1 — the CEO status line on a seat: before a 6-round fact turn with the stop-early instruction; after full budget', () => {
  expect(row('a1', 'before').factInstruction).toBe(true);
  expect(row('a1', 'before').roundsAllowed).toBe(6);
  expect(row('a1', 'before').endReason).toBe('cap(6)');
  expect(row('a1', 'after').factInstruction).toBe(false);
  expect(row('a1', 'after').toolsNarrowed).toBe(false);
  expect(row('a1', 'after').roundsAllowed).toBe(400);
  expect(row('a1', 'after').endReason).toBe('model-end');
});

test('a2 / c — «지금 바로 해주세요» and a crown steer: no fact budget, seat cap 400, the steer joins at the tool boundary', () => {
  expect(row('a2', 'after').roundsAllowed).toBe(400);
  expect(row('a2', 'after').factInstruction).toBe(false);
  expect(row('c ', 'after').endReason).toBe('steer-now → model-end');
  expect(row('c ', 'after').continued).toBe(true);
});

test('b — a goal turn ending with ScheduleWakeup(600 s): before waits for the wake, after continues now', () => {
  expect(row('b ', 'before').continued).toBe(false);
  expect(row('b ', 'after').continued).toBe(true);
  expect(row('b ', 'after').endReason).toBe('model-end → drive(model-wake-short)');
});

test('d — idle pane with 28 held passive info mails: before deadlocked (wake refused · door coalescing); after the wake is open and pure info waits for the digest (F)', () => {
  expect(row('d ', 'before').queueDrained).toBe(false);
  expect(row('d ', 'before').endReason).toBe('wake refused(typeahead) · door hold(coalescing) · auto 0');
  expect(row('d ', 'after').queueDrained).toBe(false);
  expect(row('d ', 'after').endReason).toBe('wake open · door hold(info-only) · auto 28');
});

test('e — old fear 1: a member fact question keeps the 6-round fast budget and its instruction (unchanged)', () => {
  for (const arm of ['before', 'after'] as const) {
    expect(row('e ', arm).roundsAllowed).toBe(6);
    expect(row('e ', arm).factInstruction).toBe(true);
  }
});

test('old fear 2: no nag loop — the drive stops on same reply · repeated tool call · failure · person · approval · cap · no goal', () => {
  expect(driveGuards()).toEqual({
    sameReply: 'stop:no-progress', repeatTool: 'stop:repeat-tool', failed: 'stop:failed', person: 'stop:person-input',
    approval: 'stop:needs-human', cap: 'stop:cap', noGoal: 'stop:no-goal',
  });
});

test('g — identical Bash calls: member chat keeps its old guards (cut at round 4); a seat loop nudges at 8 and ends with one tools-off summary at 12', async () => {
  const g = await runRepeatCase();
  expect(g.find((r) => r.arm === 'before')!.endReason).toBe('4 calls · nudge - · forced synthesis');
  expect(g.find((r) => r.arm === 'after')!.endReason).toBe('12 calls · nudge @8 · summary(done/remaining/next)');
}, 60_000);

test('h — three delegated results inside 60 s: before all passive (digest); after delegated-result P1 → one turn at the 60 s join', () => {
  const h = caseDelegatedResults();
  expect(h.find((r) => r.arm === 'before')!.endReason).toBe('reply+info · @30s continue · @61s continue');
  expect(h.find((r) => r.arm === 'before')!.continued).toBe(false);
  expect(h.find((r) => r.arm === 'after')!.endReason).toBe('delegated-result · @30s continue · @61s deliver-p1(3)');
  expect(h.find((r) => r.arm === 'after')!.continued).toBe(true);
});

test('i — seat prose: before 3/3 lines end the turn early; after 0/3, all point at done-when', () => {
  const i = caseSeatProse();
  expect(i.find((r) => r.arm === 'before')!.endReason).toBe('early-end lines 3/3 · done-when lines 0/3');
  expect(i.find((r) => r.arm === 'after')!.endReason).toBe('early-end lines 0/3 · done-when lines 3/3');
});

test('j — HAND-PULL-FIRST: a hand whose cell went green claims the next one in the same session (eln work next); before it waited', () => {
  const j = caseHandPull();
  expect(j.find((r) => r.arm === 'before')!.endReason).toBe('stop(no-goal) · waits for assignment');
  expect(j.find((r) => r.arm === 'after')!.endReason).toBe('drive(hand-pull) → eln work next');
  expect(j.find((r) => r.arm === 'after')!.id).toBe('j hand TC cell closed');
});

test('j2 — GOAL-BLOCK-NOT-HUMAN: TC-H-CX-2 blocked on RES approval — before ✋ and 120 idle minutes; after it parks the cell and pulls TSC-DIET-2 in the same turn', () => {
  const j2 = caseHandBlockPull();
  expect(j2.find((r) => r.arm === 'before')!.endReason).toBe('✋ 1 · sits on ISO-PROBE-1 · idle-hand-minutes 120');
  expect(j2.find((r) => r.arm === 'after')!.endReason).toBe('✋ 0 · work block → work next → TSC-DIET-2 · idle-hand-minutes 0');
});

test('j guards — no pull while the cell is open · without `eln work next` (#40096 not installed) · after the cap · on person input', () => {
  const base = { failed: false, paused: false, backoff: false, personQueued: 0, needsHuman: false, waitingOn: 0, backgroundRunning: 0, sameReply: false, history: [] as number[], now: 1_000_000 };
  expect(decideGoalDrive({ ...base, handPull: { cell: 'open', workNextAvailable: true } })).toEqual({ kind: 'stop', reason: 'no-goal' });
  expect(decideGoalDrive({ ...base, handPull: { cell: 'closed', workNextAvailable: false } })).toEqual({ kind: 'stop', reason: 'no-goal' });
  expect(decideGoalDrive({ ...base, handPull: { cell: 'none', workNextAvailable: true } })).toEqual({ kind: 'continue', signal: 'hand-pull' });
  expect(decideGoalDrive({ ...base, handPull: { cell: 'none', workNextAvailable: true }, history: [999_000, 998_000, 997_000] })).toEqual({ kind: 'stop', reason: 'cap' });
  expect(decideGoalDrive({ ...base, handPull: { cell: 'closed', workNextAvailable: true }, personQueued: 1 })).toEqual({ kind: 'stop', reason: 'person-input' });
  expect(handCellState('tc', [{ status: 'Done', owner: 'TC' }, { status: 'landed', owner: 'TC' }])).toBe('closed');
  expect(handCellState('TC', [{ status: 'green', owner: 'TC' }, { status: 'yellow', owner: 'TC' }])).toBe('open');
  expect(handCellState('TC', [{ status: 'yellow', owner: 'UX' }])).toBe('none');
  expect(SEAT_HAND_PULL_LINE).toContain('`eln work next` 로 다음 칸을 가져가');
  expect(SEAT_HAND_PULL_LINE).toContain('배정을 기다리지 말 것');
  expect(SEAT_HAND_PULL_LINE).toContain('exit 3 이면 «일감 0» 한 줄로 턴을 닫는다');
});

test('k — a failed Bash then 11 WebSearch: the member path enters the repair-action phase; a seat loop runs all 12 actions', async () => {
  const k = await runRepairPhaseCase();
  console.log(caseTable(k).join('\n'));
  expect(k.find((r) => r.arm === 'after')!.endReason).toBe('12/12 actions · repair rejections 0 · model-end');
  expect(k.find((r) => r.arm === 'before')!.endReason).toBe('1/12 actions · repair rejections 1 · forced synthesis');
}, 60_000);

test('H3/H4/H5 — wake back-off and same-cause dedupe · mail turns reset the run · fresh re-reads are not blocked', async () => {
  const rows3 = caseWakeThrash();
  const rows4 = casePacingReset();
  const rows5 = await runFreshReadCase();
  console.log(caseTable([...rows3, ...rows4, ...rows5]).join('\n'));
  expect(rows4.find((r) => r.arm === 'before')!.endReason).toBe('drive refused 3/3 (pacing:run-cap 5/5)');
  expect(rows4.find((r) => r.arm === 'after')!.endReason).toBe('drive refused 0/3');
  expect(rows3[0]!.endReason).toBe('5400 retries (retryAt−now, no floor)');
  expect(rows3[1]!.endReason).toBe('12 retries (back-off 5 s→60 s)');
  expect(rows3[3]!.endReason).toBe('1 turn opened · skipped same-cause');
  expect(rows5.find((r) => r.arm === 'after')!.endReason).toBe('10/10 dispatched · blocked 0 · nudge n');
  expect(rows5.find((r) => r.arm === 'before')!.endReason).toBe('4/10 dispatched · blocked 6 · nudge n');
}, 60_000);

test('Q10 — a space lead gets the leader card (5/5 duties) and its turn carries the board work; before it got the hand profile', async () => {
  const q = await runLeaderCase();
  expect(q.find((r) => r.arm === 'before')!.endReason).toBe('profile hand · duties 0/5 · 1 actions (status only)');
  expect(q.find((r) => r.arm === 'after')!.endReason).toBe('profile leader · duties 5/5 · 5 actions (split 2 · judged 2 · ✋ resolved 1)');
}, 60_000);

test('Q10 resolution — federation space coordinator · kingdom seat · coord-tracks role lead · HQ and hands are not leaders', () => {
  const seats = [{ id: 'OP', role: 'coordinator' }, { id: 'TC' }, { id: 'MK', role: 'lead' }, { id: 'CX1' }];
  expect(seatLeadership('tc', { spaces: { build: { coordinator: 'TC' } }, seats })).toEqual({ kind: 'space', seat: 'TC', space: 'build' });
  expect(seatLeadership('JUD', { seats })).toEqual({ kind: 'kingdom', seat: 'JUD', kingdom: 'JUD' });
  expect(seatLeadership('MK', { seats })).toEqual({ kind: 'space', seat: 'MK', space: 'MK' });
  expect(seatLeadership('OP', { spaces: { hq: { coordinator: 'OP' } }, seats })).toBe(null);
  expect(seatLeadership('CX1', { spaces: { build: { coordinator: 'TC' } }, seats })).toBe(null);
  expect(seatLeadership('JUD-3', { seats })).toBe(null);
  const jud = leaderCard({ kind: 'kingdom', seat: 'JUD', kingdom: 'JUD' });
  expect(jud).toContain('Leader profile (this seat = leader of the JUD kingdom)');
  expect(jud).toContain('criteria, HOLD decisions and disagreements');
  expect(jud).toContain('Landing is the land graph');
  const tc = leaderCard({ kind: 'space', seat: 'TC', space: 'build' });
  expect(tc).toContain('The Board Steward ranks the board');
  expect(tc).toContain('without an owner and a deadline');
  expect(tc).toContain('Never wait for RES or REL approvals');
  expect(leaderCard({ kind: 'kingdom', seat: 'RES', kingdom: 'RES' })).toContain('host and VM policy');
  expect(leaderCard({ kind: 'kingdom', seat: 'REL', kingdom: 'REL' })).toContain('release schedule');
  expect(leaderCard({ kind: 'space', seat: 'TC', space: 'build' })).not.toContain('Kingdom duty');
  expect(leaderCard({ kind: 'space', seat: 'TC', space: 'build' })).toContain("work until the goal's done-when or a real blocker");
});

test('L — the 11-25 assign storm: a standing goal opens 0 continuations; a task continuation takes ≤5 outward actions and no duplicate', async () => {
  const l = await runAssignStormCase();
  console.log(caseTable(l).join('\n'));
  expect(l[0]!.endReason).toBe('continuation opened (drive:progress)');
  expect(l[1]!.endReason).toBe('0 continuations (standing-goal)');
  expect(l[2]!.endReason).toBe('20 assign mails · 8 duplicates · model-end');
  expect(l[3]!.endReason).toBe('2 assign mails · 0 duplicates · summary');
}, 60_000);

test('L rules — task goal facts · outward classification · budget · ledger progress stops', () => {
  expect(isTaskGoal({ hasCheck: false, taskFlag: false, crownDirective: false })).toBe(false);
  expect(isTaskGoal({ hasCheck: true, taskFlag: false, crownDirective: false })).toBe(true);
  expect(isTaskGoal({ hasCheck: false, taskFlag: true, crownDirective: false })).toBe(true);
  expect(isTaskGoal({ hasCheck: false, taskFlag: false, crownDirective: true })).toBe(true);
  expect(outwardActionKey('Bash', { command: 'eln  seat assign CX1 LAND-QUEUE-1' })).toBe('Bash|eln seat assign CX1 LAND-QUEUE-1');
  expect(outwardActionKey('Bash', { command: 'cd /x && gh pr create --fill' })).toBe('Bash|gh pr create --fill');
  expect(outwardActionKey('Bash', { command: 'ELANOUS_TRACK=OP eln msg post --to TC --body hi' })).toBe('Bash|eln msg post --to TC --body hi');
  expect(outwardActionKey('Bash', { command: 'eln msg list --to OP' })).toBe(null);
  expect(outwardActionKey('Read', { file_path: 'a.md' })).toBe(null);
  const budget = createSideEffectBudget();
  const verdicts = ['a', 'b', 'a', 'c', 'd', 'e', 'f'].map((x) => budget.check('Bash', { command: `eln seat assign ${x}` }));
  expect(verdicts).toEqual(['ok', 'ok', 'duplicate', 'ok', 'ok', 'ok', 'over-budget']);
  const base = { goalId: 'pin:t', failed: false, paused: false, backoff: false, personQueued: 0, needsHuman: false, waitingOn: 0, backgroundRunning: 0, sameReply: false, stateChanged: true, history: [] as number[], now: 1_000_000 };
  expect(decideGoalDrive({ ...base, taskGoal: true })).toEqual({ kind: 'continue', signal: 'progress' });
  expect(decideGoalDrive({ ...base, taskGoal: true, ledgerUnchanged: true })).toEqual({ kind: 'stop', reason: 'no-ledger-progress' });
  expect(decideGoalDrive({ ...base, taskGoal: true, blocked: true })).toEqual({ kind: 'stop', reason: 'blocked' });
});

test('R — relayed bulletin/nudge are not requirements · relayed cell request and CEO typed lines are · typed line without ref closes as answered · BLOCKED CEO line without a CEO-only gap = stale, zero CEO cards', async () => {
  const r = await runRequirementCase();
  console.log(caseTable(r).join('\n'));
  expect(r.find((x) => x.arm === 'before')!.endReason).toBe('reqs [relay-bulletin:artifact,relay-cell:artifact,relay-nudge:artifact,typed-noref:artifact,typed-ref:artifact] · pre-unify closed 2 (digest 1) · sticky BLOCKED 5 · cards 0 · answered-close artifact-evidence-required · artifact-by-answer artifact-evidence-required');
  expect(r.find((x) => x.arm === 'after')!.endReason).toBe('reqs [relay-cell:artifact,typed-noref:answered,typed-ref:artifact] · pre-unify closed 2 (digest 1) · sticky BLOCKED 0 · cards 0 · stale 3 · answered-close ok · artifact-by-answer artifact-evidence-required');
}, 60_000);

test('F / X — idle flush ≤1 per 10 min and only for non-info · a retraction refuses same-target actions mid-continuation', async () => {
  const f = caseIdleFlush();
  const x = await runRetractCase();
  console.log(caseTable([...f, ...x]).join('\n'));
  expect(f.filter((r) => r.arm === 'after').map((r) => r.endReason)).toEqual(['hold(info-only)', 'hold(flush-limit)', 'release(work-done)', 'release(starvation)']);
  expect(x.map((r) => r.endReason)).toEqual(['after the retraction: 2 action(s) on the target · 2 other', 'after the retraction: 0 action(s) on the target · 2 other']);
}, 60_000);

test('SIM-SIGNAL (Q5 ⊕ Q6) — before: MsgList every turn · withdrawn order acted on twice; after: 0 MsgList · 0 stale · expired shown once', async () => {
  const signal = runSignalCase();
  console.log(signalTable(signal).join('\n'));
  expect(signal).toEqual([
    { arm: 'before', turns: 4, msgListCalls: 4, staleDirectiveExecutions: 2, expiredShown: 0 },
    { arm: 'after', turns: 4, msgListCalls: 0, staleDirectiveExecutions: 0, expiredShown: 1 },
  ]);
});

test('SIM-OUTBOUND (H6) — 13 OP posts in 10 min: before 13 rows · 13 wakes; after 3 rows · 3 wakes · crown kept', async () => {
  const rows = runOutboundCase();
  console.log(outboundTable(rows).join('\n'));
  expect(rows).toEqual([
    { arm: 'before', posts: 13, rows: 13, wakes: 13, crownRows: 1 },
    { arm: 'after', posts: 13, rows: 3, wakes: 3, crownRows: 1 },
  ]);
});

test('SIM-FLOOD (Q9) — 14 mails in 2 min: before 14 turns; after 10 then flood · crown and alert still open · back to normal after quiet', async () => {
  const { runFloodCase, floodTable } = await import('./seat-turn-continue-world.js');
  const rows = runFloodCase();
  console.log(floodTable(rows).join('\n'));
  expect(rows).toEqual([
    { arm: 'before', arrivals: 14, turnsOpened: 14, foldedToDigest: 0, exemptOpened: 2, afterQuietOpened: true, floodEvents: '-' },
    { arm: 'after', arrivals: 14, turnsOpened: 11, foldedToDigest: 3, exemptOpened: 2, afterQuietOpened: true, floodEvents: 'enter@11 exit@0' },
  ]);
});

// SIM-RAIL30 — verify-3u gaps after rail 28 (① delegated result folded · ② G vs Q9 · ④ stale wake replay · ⑤ dead-hand wakes).
test('SIM-RAIL30 ① a result for OP\'s own ask reaches OP even at 30 turns/h · ② a 12-mail burst engages Q9 flood mode', () => {
  const { runRail30MailCase, rail30Table } = require('./seat-turn-continue-world.js') as typeof import('./seat-turn-continue-world.js');
  const rows = runRail30MailCase();
  console.log(rail30Table(rows).join('\n'));
  const at = (id: string, arm: 'before' | 'after') => rows.find((r) => r.id.startsWith(id) && r.arm === arm)!.result;
  expect(at('①', 'before')).toBe('turns/h read 30 · folded (divert)');
  expect(at('①', 'after')).toBe('turns/h read 5 · row (reaches the router)');
  expect(at('②', 'before')).toBe('G folded 12/12 · Q9 meter rate 0 · flood off · exempt folded by G: needs-human');
  expect(at('②', 'after')).toBe('G folded 12/12 · Q9 meter rate 12 · flood ENGAGED · exempt folded by G: none');
});

test('SIM-RAIL30 ④ restart drops wakes overdue > 2 h with one line · ⑤ a dead hand gets 2 wakes then one ✋ card', () => {
  const { runRail30WakeCase, rail30Table } = require('./seat-turn-continue-world.js') as typeof import('./seat-turn-continue-world.js');
  const rows = runRail30WakeCase();
  console.log(rail30Table(rows).join('\n'));
  const at = (id: string, arm: 'before' | 'after') => rows.find((r) => r.id.startsWith(id) && r.arm === arm)!.result;
  expect(at('④', 'before')).toBe('00:01/05:23 replayed yes · 16:40 kept yes · no drop line');
  expect(at('④', 'after')).toBe('00:01/05:23 replayed no · 16:40 kept yes · one line «dropped 2 stale wakes»');
  expect(at('⑤', 'before')).toBe('wakes 7 · ✋ cards 0 · quiet refusals 0');
  expect(at('⑤', 'after')).toBe('wakes 2 · ✋ cards 1 · quiet refusals 4');
});
