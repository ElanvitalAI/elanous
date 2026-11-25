// SIM-SEAT-TURN-CONTINUE (대표 11-25 «goal 턴이 왜 이렇게 빨리 끝나나 · 시뮬레이션 장치로 다 테스트») — replays the OP seat cases
// against the production decisions, before vs after:
//   budget  = acp/turn-budget.ts decideTurnBudget (fact-question budget · fact instruction · quick-route allowlist)
//   drive   = session-autopilot/goal-drive.ts decideGoalDrive (bounded continuation of an open goal)
//   queue   = tui/core/queue.ts (passive hold) ⊕ tui/queue-finish-first.ts (idle verdict · person-only typeahead)
// The model is scripted: it keeps requesting tools for SCRIPT_TOOL_ROUNDS rounds, then answers. «before» = the same
// decisions with the pre-fix inputs (no seat profile · no drive · queue.count as typeahead · passive held on idle).
// SEAT-TURN-FOLLOWUPS (#40092 FU) adds:
//   g   = llm.ts tool loop ⊕ llm/seat-action-stationarity.ts — identical calls: member chat keeps its old guards,
//         a seat loop nudges at 8 and ends with one tools-off summary at 12
//   h   = tui/seat-mail-turn-policy.ts `delegated-result` ⊕ notice-producers P1 ⊕ decideIdleQueue (60 s join → one turn)
//   j   = session-autopilot/goal-drive.ts HAND-PULL-FIRST — a hand whose cell went green pulls `eln work next` in the same session
//   k   = llm.ts repair-action phase — a failed shell step no longer rejects a seat loop's next non-repair calls
//   H3  = skills/tools/schedule-wakeup.ts — a refused wake backs off · two wakes with the same cause open one turn
//   H4  = tui/input/internal-turn.ts — a mail/queued turn resets the self-started run · the drive is bounded by its own limit
//   H5  = llm.ts dedup ⊕ stationarity freshness — re-reading a file that changed is not «identical» in a seat loop
//   Q10 = seat/seat-leadership.ts ⊕ prompt-library/leader-card.ts — a space lead gets the leader card; its turn runs the board work
//   L   = GOAL-DRIVE-NARROW — the 11-25 assign storm: a standing goal never drives; a task continuation ≤5 outward, no repeat
//   R   = op-requirements — announcements/info crown mails are not requirements · old ones close on load · BLOCKED = one card
//   F   = idle flush rate-limit (≤1 per 10 min · only non-info) · X = a retraction refuses same-target outward actions
//   j2  = GOAL-BLOCK-NOT-HUMAN ⊕ HAND-PULL-ON-BLOCK (rail 31) — TC-H-CX-2's plan ends «blocked: needs RES isolation approval»:
//         before ✋ «a person is needed» and the hand sits until RES answers; after no ✋ · one internal turn · work block ⊕
//         work next pulls a different READY cell in the same turn (goal-continue ⊕ hand-block-pull ⊕ cell-block ⊕ work-next)
//   i   = seat/seat-turn-prose.ts — the seat prose no longer ends a turn at «일감 0 · 한 줄 · 기다린다» / «제안하라»
//
// 세 얼굴: 관측 = the case table (one row per case × arm) · 판단 = the production functions above · 수복 = none (a sim).

import { isFactQuestion } from '../acp/fact-question.js';
import { decideTurnBudget, SEAT_TURN_MAX_TOOL_ROUNDS } from '../acp/turn-budget.js';
import { classifyTuiChatIntent } from '../core-turn/short-question.js';
import { RESEARCH_TURN_MAX_TOOL_TURNS } from '../core-turn/research-policy.js';
import { decideGoalDrive, DRIVE_HAND_PULL_PROMPT, DRIVE_MAX_CONTINUES, handCellState, modelWakeDelayMs } from '../session-autopilot/goal-drive.js';
import { createNextTuiQueue } from '../tui/core/queue.js';
import { streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from '../llm.js';
import { classifySeatMail, decideIdleQueue, midTurnMailAction, NO_WAITS, personQueuedCount, QUEUE_P1_JOIN_AFTER_MS } from '../tui/queue-finish-first.js';
import { seatMailRoute } from '../tui/seat-mail-turn-policy.js';
import { createInternalTurnGate } from '../tui/input/internal-turn.js';
import { buildUniversalPreamble } from '../prompt-library/universal-preamble.js';
import { seatLeadership } from '../seat/seat-leadership.js';
import { runRequirementTurnEnd } from '../op-requirements/turn-end.js';
import { closeRequirement, readStore, requirementStorePath, writeStore, emptyStore } from '../op-requirements/requirement-loop.js';
import { createWakeupScheduler } from '../skills/tools/schedule-wakeup.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChildNoticeProducers } from '../tui/core/notice-producers.js';
import { SEAT_REPEAT_NUDGE_AT, SEAT_REPEAT_STOP_AT, clearRetractedTargets, noteRetractedRefs } from '../llm/seat-action-stationarity.js';
import { createGoalContinue } from '../tui/input/goal-continue.js';
import { decideHandBlockPull, type HandPlanStop } from '../seat/hand-block-pull.js';
import { blockState, openBlocks, workBlock, type CellBlockRow } from '../steward/space/cell-block.js';
import { workNext, type BoardCell } from '../steward/space/work-next.js';
import { SEAT_FIRST_ANSWER_LINE, SEAT_NO_CAUSE_CONTINUE, SEAT_ZERO_WORK_CONTINUE } from '../seat/seat-turn-prose.js';

/** The scripted model asks for this many tool rounds before it answers. */
export const SCRIPT_TOOL_ROUNDS = 30;
/** The member fact budget default (user-config chat.ts CHAT_DEFAULTS.factQuestion.maxToolTurns). */
export const MEMBER_FACT_MAX = 6;

export type Arm = 'before' | 'after';
export interface CaseRow {
  readonly id: string;
  readonly arm: Arm;
  /** Tool rounds the turn may run (∞ = family default, no counter). */
  readonly roundsAllowed: number | '∞';
  readonly factInstruction: boolean;
  readonly toolsNarrowed: boolean;
  readonly endReason: string;
  readonly continued: boolean | null;
  readonly queueDrained: boolean | null;
}

const NOW = Date.parse('2026-11-25T07:10:00.000Z');

/** One bridged turn of the scripted model under the budget verdict. */
function bridgedTurn(text: string, seatTurn: boolean): { rounds: number | '∞'; fact: boolean; narrowed: boolean; end: string } {
  const verdict = classifyTuiChatIntent(text, { seat: seatTurn });
  const quickRoute = !verdict.goalLoop && verdict.route !== '코딩·구현' && verdict.route !== '읽기·분석';
  const budget = decideTurnBudget({ factShaped: isFactQuestion(text), seatTurn, armGoalLoop: false, researchAgent: false, goalLoopResearch: false,
    quickRoute, factMaxToolTurns: MEMBER_FACT_MAX, researchMaxToolTurns: RESEARCH_TURN_MAX_TOOL_TURNS });
  const cap = budget.maxToolTurns;
  const ran = cap === undefined ? SCRIPT_TOOL_ROUNDS : Math.min(cap, SCRIPT_TOOL_ROUNDS);
  return { rounds: cap ?? '∞', fact: budget.factQuestion, narrowed: budget.narrowTools,
    end: ran < SCRIPT_TOOL_ROUNDS ? `cap(${cap})` : 'model-end' };
}

export const CEO_LINE_STATUS = '지금 전체 연방 운영중인가요? 매시 10개의 랜딩을 위해서 무엇을 하고 있어요?';
export const CEO_LINE_GO = '지금 바로 해주세요. 계속 더 나아가면 되는데 왜 멈췄죠';
export const MEMBER_FACT = '지금 최저시급 얼마야?';

function caseBudget(id: string, text: string, member = false): CaseRow[] {
  return (['before', 'after'] as const).map((arm) => {
    // before: the bridge had no seat profile — a seat turn was decided like a member turn.
    const t = bridgedTurn(text, !member && arm === 'after');
    return { id, arm, roundsAllowed: t.rounds, factInstruction: t.fact, toolsNarrowed: t.narrowed, endReason: t.end, continued: null, queueDrained: null };
  });
}

/** (b) an autopilot goal turn: tools ran, the reply names a next step, and the model set ScheduleWakeup(600 s). */
function caseGoalTurn(): CaseRow[] {
  const rows = [
    { role: 'tool', toolName: 'Bash', toolArgs: { command: 'eln seat pool' } },
    { role: 'tool', toolName: 'ScheduleWakeup', toolArgs: { delaySeconds: 600, reason: '16:18 에 다시 확인' } },
  ];
  const wake = modelWakeDelayMs(rows);
  const after = decideGoalDrive({ goalId: 'pin:land-10', failed: false, paused: false, backoff: false, personQueued: 0, needsHuman: false,
    waitingOn: 0, backgroundRunning: 0, sameReply: false, ...(wake !== undefined ? { modelWakeInMs: wake } : {}), stateChanged: true, history: [], now: NOW });
  return [
    // before: turnEnded saw the model's own wake as «scheduled → arm nothing»; the shortest self wake was 5 min.
    { id: 'b goal turn + ScheduleWakeup(10m)', arm: 'before', roundsAllowed: '∞', factInstruction: false, toolsNarrowed: false, endReason: 'model-end → wait wake 10m', continued: false, queueDrained: null },
    { id: 'b goal turn + ScheduleWakeup(10m)', arm: 'after', roundsAllowed: '∞', factInstruction: false, toolsNarrowed: false,
      endReason: after.kind === 'continue' ? `model-end → drive(${after.signal})` : `model-end → stop(${after.reason})`, continued: after.kind === 'continue', queueDrained: null },
  ];
}

/** Old fear: no nag loop — a drive stops on the same reply, a repeated tool call, a failure, and after 3 per 30 min. */
export function driveGuards(): Record<string, string> {
  const base = { goalId: 'pin:land-10', failed: false, paused: false, backoff: false, personQueued: 0, needsHuman: false, waitingOn: 0,
    backgroundRunning: 0, sameReply: false, modelWakeInMs: 600_000, history: [] as number[], now: NOW };
  const verdict = (over: Partial<typeof base> & { repeatToolCall?: boolean }): string => {
    const v = decideGoalDrive({ ...base, ...over });
    return v.kind === 'continue' ? `continue:${v.signal}` : `stop:${v.reason}`;
  };
  return {
    sameReply: verdict({ sameReply: true }),
    repeatTool: verdict({ repeatToolCall: true }),
    failed: verdict({ failed: true }),
    person: verdict({ personQueued: 1 }),
    approval: verdict({ needsHuman: true }),
    cap: verdict({ history: Array.from({ length: DRIVE_MAX_CONTINUES }, (_, i) => NOW - (i + 1) * 60_000) }),
    noGoal: verdict({ goalId: undefined as unknown as string }),
  };
}

/** (c) a crown mail arriving mid-turn: P0 → steer at the next tool boundary; the turn goes on under the seat budget. */
function caseCrownSteer(): CaseRow[] {
  const cls = classifySeatMail({ intent: 'request', crownDirective: 'CEO-1610-NOW' });
  const action = midTurnMailAction({ id: 'q1', text: CEO_LINE_GO, source: 'seat-mail', mailClass: cls }, cls, true, NOW);
  return (['before', 'after'] as const).map((arm) => {
    const t = bridgedTurn(CEO_LINE_GO, arm === 'after');
    return { id: 'c crown steer mid-turn', arm, roundsAllowed: t.rounds, factInstruction: t.fact, toolsNarrowed: t.narrowed,
      endReason: `${action.kind} → ${t.end}`, continued: true, queueDrained: null };
  });
}

/** (d) idle pane after «Turn done» with 28 passive seat mails held (+ the last mail turn 1 min ago). */
function caseIdleQueue(): CaseRow[] {
  const out: CaseRow[] = [];
  for (const arm of ['before', 'after'] as const) {
    const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
    for (let i = 0; i < 28; i += 1) queue.enqueueNotice(`[seat-mail] info #${164600 + i}`, 'seat-mail', { msgId: 164600 + i, passive: true, mailClass: 'P2', mailIntent: 'info' });
    if (arm === 'after') queue.setSeatIdle(true);
    const items = queue.items.filter((item) => item.status === 'queued');
    // the internal-turn gate's «typeahead»: before = every queued item · after = a person's queued line only
    const typeahead = arm === 'before' ? queue.count : personQueuedCount(items);
    const watchdogSees = queue.autoDispatchCount;
    const verdict = decideIdleQueue({ items, waits: NO_WAITS, workInProgress: false, continuationsWhileHolding: 0, awaitingStartSince: null,
      continuationTried: false, lastMailTurnAt: NOW - 60_000, now: NOW, ...(arm === 'after' ? { holdOnlyWhileBusy: true } : {}) });
    const drained = watchdogSees > 0 && verdict.kind === 'release';
    out.push({ id: 'd idle pane · 28 held', arm, roundsAllowed: '∞', factInstruction: false, toolsNarrowed: false,
      endReason: `wake ${typeahead > 0 ? 'refused(typeahead)' : 'open'} · door ${verdict.kind}${verdict.kind === 'hold' ? `(${verdict.reason})` : ''} · auto ${watchdogSees}`,
      continued: typeahead === 0, queueDrained: drained });
  }
  return out;
}

export function runSeatTurnCases(): CaseRow[] {
  return [
    ...caseBudget('a1 CEO «운영중인가요?»', CEO_LINE_STATUS),
    ...caseBudget('a2 CEO «지금 바로 해주세요»', CEO_LINE_GO),
    ...caseGoalTurn(),
    ...caseCrownSteer(),
    ...caseIdleQueue(),
    ...caseBudget('e member fact question', MEMBER_FACT, true),
  ];
}

/** (f) a terra OP turn that needs 15 Bash rounds (eln CLIs — never Read/Edit), run through the real tool loop. */
export const NEEDED_ROUNDS = 15;
/** Family dimension: the same Bash-only task on a codex-family seat (terra) and a claude-family seat (opus). */
export const FAMILIES = [
  { label: 'terra', provider: 'openai-codex', model: 'gpt-6.1-terra' },
  { label: 'opus', provider: 'anthropic', model: 'claude-opus-4-5' },
] as const;
export async function runToolRoundsCase(neededRounds: number = NEEDED_ROUNDS, family: (typeof FAMILIES)[number] = FAMILIES[0]): Promise<CaseRow[]> {
  const NEEDED_ROUNDS = neededRounds;
  const out: CaseRow[] = [];
  for (const arm of ['before', 'after'] as const) {
    let dispatched = 0;
    let forced = false;
    const provider: LLMProvider = {
      name: family.provider, defaultModel: family.model, available: () => true,
      // the force-synthesis pass may use the non-streaming call
      async *chat() { forced = true; yield 'forced synthesis: stopped early, the remaining rounds were never run in this turn.'; },
      streamChat(messages, options) {
        // the force-synthesis pass: tool_choice none (codex keeps the tools array) or no tools at all
        const synthesis = (options as { toolChoice?: string } | undefined)?.toolChoice === 'none' || !(options as { tools?: unknown[] } | undefined)?.tools?.length
          || String(messages.at(-1)?.content ?? '').startsWith('Your tool budget is exhausted');
        if (synthesis) forced = true;
        const call = !synthesis && dispatched < NEEDED_ROUNDS;
        const round = dispatched;
        return (async function* () {
          if (call) {
            yield { type: 'tool_call', id: `c${round}`, name: 'Bash', args: { command: `eln seat pool --round ${round}` } } as LLMStreamEvent;
            yield { type: 'finish', reason: 'tool_calls' } as LLMStreamEvent;
          } else {
            yield { type: 'text', delta: synthesis ? 'forced synthesis: stopped early, the remaining rounds were never run in this turn.' : `done: ${NEEDED_ROUNDS} rounds` } as LLMStreamEvent;
            yield { type: 'finish', reason: 'stop' } as LLMStreamEvent;
          }
        })();
      },
    };
    const text = await streamLLMWithTools([{ role: 'user', content: '착지 10/h 를 위해 지금 할 일을 끝까지 한다' }],
      { onText() {}, dispatchTool: async () => { dispatched += 1; return 'ok'; } },
      { provider, model: provider.defaultModel, tools: [{ name: 'Bash', description: 'run a shell command', parameters: { type: 'object' } }],
        sessionId: `sim-seat-rounds-${family.label}-${NEEDED_ROUNDS}-${arm}`, seatLoop: arm === 'after' });
    out.push({ id: `f ${family.label} OP · ${NEEDED_ROUNDS} rounds needed`, arm, roundsAllowed: arm === 'after' ? SEAT_TURN_MAX_TOOL_ROUNDS : '∞',
      factInstruction: false, toolsNarrowed: false,
      endReason: `${dispatched}/${NEEDED_ROUNDS} rounds · ${forced || text.includes('forced synthesis') ? 'forced synthesis' : text.includes('done') ? 'model-end' : 'other'}`,
      continued: dispatched >= NEEDED_ROUNDS, queueDrained: null });
  }
  return out;
}

/** (g) a terra turn whose model calls the same Bash command with the same args every round (30 scripted). */
export const REPEAT_SCRIPT_CALLS = 30;
export async function runRepeatCase(): Promise<CaseRow[]> {
  const out: CaseRow[] = [];
  for (const arm of ['before', 'after'] as const) {
    let dispatched = 0;
    let nudgeAt: number | null = null;
    let summaryStep = false;
    const sawNudge = (messages: readonly { content?: unknown }[]): boolean => messages.some((m) => typeof m.content === 'string' && m.content.includes('You are repeating Bash'));
    const provider: LLMProvider = {
      name: 'openai-codex', defaultModel: 'gpt-6.1-terra', available: () => true,
      async *chat(messages) {
        const last = String(messages.at(-1)?.content ?? '');
        if (last.startsWith('Tools are off for this step')) summaryStep = true;
        yield summaryStep
          ? 'Done: checked the pool 12 times. Remaining: land 10 per hour. Next: assign the idle owner instead of re-reading the pool.'
          : 'forced synthesis: stopped early, the remaining rounds were never run in this turn.';
      },
      streamChat(messages, options) {
        const synthesis = (options as { toolChoice?: string } | undefined)?.toolChoice === 'none' || !(options as { tools?: unknown[] } | undefined)?.tools?.length;
        if (nudgeAt === null && sawNudge(messages)) nudgeAt = dispatched;
        const call = !synthesis && dispatched < REPEAT_SCRIPT_CALLS;
        return (async function* () {
          if (call) {
            yield { type: 'tool_call', id: `r${dispatched}`, name: 'Bash', args: { command: 'eln seat pool' } } as LLMStreamEvent;
            yield { type: 'finish', reason: 'tool_calls' } as LLMStreamEvent;
          } else {
            yield { type: 'text', delta: `done: ${dispatched} calls` } as LLMStreamEvent;
            yield { type: 'finish', reason: 'stop' } as LLMStreamEvent;
          }
        })();
      },
    };
    const text = await streamLLMWithTools([{ role: 'user', content: '착지 10/h 를 위해 지금 할 일을 끝까지 한다' }],
      { onText() {}, dispatchTool: async () => { dispatched += 1; return 'pool: 3 idle'; } },
      { provider, model: provider.defaultModel, tools: [{ name: 'Bash', description: 'run a shell command', parameters: { type: 'object' } }],
        sessionId: `sim-seat-repeat-${arm}`, seatLoop: arm === 'after' });
    const end = summaryStep && text.includes('Remaining:') ? 'summary(done/remaining/next)' : text.includes('forced synthesis') ? 'forced synthesis' : text.includes('done:') ? 'model-end' : 'other';
    out.push({ id: 'g identical Bash calls', arm, roundsAllowed: arm === 'after' ? SEAT_TURN_MAX_TOOL_ROUNDS : '∞', factInstruction: false, toolsNarrowed: false,
      endReason: `${dispatched} calls · nudge ${nudgeAt === null ? '-' : `@${nudgeAt}`} · ${end}`, continued: null, queueDrained: null });
  }
  return out;
}

/** (h) three delegated results from below (reply to OP's order · pr: ref on an OP-assigned cell · receipt: ref) inside 60 s while OP works. */
export function caseDelegatedResults(): CaseRow[] {
  const T0 = NOW;
  const mails = [
    { id: 170001, sender: 'TC', body: 'PR #40100 올렸다', kind: 'status', replyTo: 169900, replyToOwn: true },
    { id: 170002, sender: 'UX', body: '칸 끝', kind: 'result', refs: ['cell:SEAT-TURN-FOLLOWUPS', 'pr:40101'], cellDelegated: true },
    { id: 170003, sender: 'RES', body: 'pregate PASS', kind: 'notice', refs: ['cell:LAND-QUEUE-1', 'receipt:minim5-0712'], cellDelegated: true },
  ];
  const out: CaseRow[] = [];
  for (const arm of ['before', 'after'] as const) {
    const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
    const producers = createChildNoticeProducers(queue);
    const reasons: string[] = [];
    mails.forEach((mail, i) => {
      // before: the router had no delegation facts (replyToOwn · cellDelegated were not read).
      const { replyToOwn, cellDelegated, ...ledger } = mail as typeof mail & { replyToOwn?: boolean; cellDelegated?: boolean };
      const input = { ...ledger, senderAbove: false, createdAt: new Date(T0 + i * 15_000).toISOString(),
        ...(arm === 'after' && replyToOwn ? { replyToOwn } : {}), ...(arm === 'after' && cellDelegated ? { cellDelegated } : {}) };
      reasons.push(seatMailRoute({ ...input, origin: null }).reason);
      producers.seatMessageArrived(input);
    });
    const items = queue.items.filter((item) => item.status === 'queued').map((item) => ({ ...item, enqueuedAt: T0 }));
    const base = { items, waits: NO_WAITS, workInProgress: true, continuationsWhileHolding: 0, awaitingStartSince: null, continuationTried: false, lastMailTurnAt: null };
    const at30 = decideIdleQueue({ ...base, now: T0 + 30_000 });
    const at61 = decideIdleQueue({ ...base, now: T0 + QUEUE_P1_JOIN_AFTER_MS + 1_000 });
    const joined = at61.kind === 'deliver-p1' ? at61.ids.length : 0;
    out.push({ id: 'h 3 delegated results in 60 s', arm, roundsAllowed: '∞', factInstruction: false, toolsNarrowed: false,
      endReason: `${[...new Set(reasons)].join('+')} · @30s ${at30.kind} · @61s ${at61.kind}${joined ? `(${joined})` : ''}`,
      continued: joined > 0, queueDrained: null });
  }
  return out;
}

/** The pre-fix seat prose (literal copies of what #40092 left on main) — the «before» arm of case i. */
export const BEFORE_SEAT_PROSE = [
  '내 칸·우편이 모두 0건이면 «일감 0»이라고 한 줄로 알리고 기다린다(막힘 아님).',
  "사람이 다른 일을 먼저 시키지 않았다면, 첫 답에서 자리 이름·'자리 역할' 절의 역할·안 읽은 우편 수를 각각 명시하고 처리할 일을 제안하라.",
  '- 원인이 없으면 «원인 없음 · 근거(무엇을 봤나)» 한 줄로 끝낸다.',
];
/** (i) does the seat prose end the turn early (announce-and-wait · propose-and-stop · one-line end) or point at done-when? */
export function caseSeatProse(): CaseRow[] {
  const early = /한 줄로 알리고 기다린다|제안하라|한 줄로 끝낸다/u;
  return (['before', 'after'] as const).map((arm) => {
    const prose = arm === 'before' ? BEFORE_SEAT_PROSE : [SEAT_ZERO_WORK_CONTINUE, SEAT_FIRST_ANSWER_LINE, SEAT_NO_CAUSE_CONTINUE];
    const earlyEnds = prose.filter((line) => early.test(line)).length;
    const doneWhen = prose.filter((line) => line.includes('완료선')).length;
    return { id: 'i seat prose (zero work · first answer · no cause)', arm, roundsAllowed: '∞' as const, factInstruction: false, toolsNarrowed: false,
      endReason: `early-end lines ${earlyEnds}/3 · done-when lines ${doneWhen}/3`, continued: earlyEnds === 0, queueDrained: null };
  });
}

/** (j) hand seat TC finishes its cell (status green) with no open goal; `eln work next` is installed. */
export function caseHandPull(): CaseRow[] {
  const cells = [{ id: 'SEAT-TURN-FOLLOWUPS', status: 'green', owner: 'TC' }, { id: 'LAND-QUEUE-1', status: 'yellow', owner: 'OP' }];
  const state = handCellState('TC', cells);
  const base = { failed: false, paused: false, backoff: false, personQueued: 0, needsHuman: false, waitingOn: 0, backgroundRunning: 0,
    sameReply: false, stateChanged: true, history: [] as number[], now: NOW };
  return (['before', 'after'] as const).map((arm) => {
    // before: the drive had no hand facts — a hand with no open goal stopped and waited to be assigned.
    const v = decideGoalDrive({ ...base, ...(arm === 'after' ? { handPull: { cell: state, workNextAvailable: true } } : {}) });
    const next = v.kind === 'continue' && v.signal === 'hand-pull' && DRIVE_HAND_PULL_PROMPT(state).includes('eln work next') ? ' → eln work next' : '';
    return { id: `j hand TC cell ${state}`, arm, roundsAllowed: '∞' as const, factInstruction: false, toolsNarrowed: false,
      endReason: v.kind === 'continue' ? `drive(${v.signal})${next}` : `stop(${v.reason}) · waits for assignment`, continued: v.kind === 'continue', queueDrained: null };
  });
}

/** (j2) minutes RES takes to answer the isolation approval in the replay (the live screen said «waiting 120 min»). */
export const J2_RES_ANSWER_MIN = 120;
/**
 * (j2) TC-H-CX-2 holds ISO-PROBE-1 (no PR) · its plan ends blocked on RES approval · TSC-DIET-2 waits on the TC board.
 * idle-hand-minutes = minutes the hand holds no active work before it starts its next cell.
 */
export function caseHandBlockPull(): CaseRow[] {
  return (['before', 'after'] as const).map((arm) => {
    const cells: BoardCell[] = [
      { id: 'ISO-PROBE-1', title: 'isolation probe', status: 'yellow', owner: 'TC-H-CX-2', priority: 'P0', updatedAt: '2026-11-25T09:00:00Z' },
      { id: 'TSC-DIET-2', title: 'type check diet', status: 'yellow', owner: 'TC', priority: 'P1', updatedAt: '2026-11-25T08:00:00Z' },
    ];
    const rows: CellBlockRow[] = [];
    const swap = (id: string, input: { expectedOwner: string | null; to: string | null }) => {
      const i = cells.findIndex((c) => c.id === id);
      if (i < 0) return { outcome: 'missing' as const };
      if ((cells[i]!.owner ?? null) !== input.expectedOwner) return { outcome: 'lost' as const };
      cells[i] = { ...cells[i]!, ...(input.to ? { owner: input.to } : {}) };
      return { outcome: 'swapped' as const };
    };
    const scopeOf = (seat: string): string => (seat.startsWith('TC-') ? 'TC' : 'OP');
    let raised = 0;
    let stop = undefined as HandPlanStop | undefined;
    const gc = createGoalContinue({ startTurnIfIdle: () => ({ opened: true, turnId: 't' }) as never, isEnabled: () => true, log: () => {}, notify: () => {},
      onBlocked: () => { raised += 1; }, seat: 'TC-H-CX-2',
      ...(arm === 'after' ? { handSeat: true, onHandCellWait: (s: HandPlanStop) => { stop = s; } } : {}) });
    gc.noteTurnEnded({ lines: ['⏸ Blocked'], plan: { version: 2, versionAtTurnStart: 1, steps: [
      { status: 'blocked', step: 'run isolation probe', reason: 'needs RES isolation approval', code: 'APPROVAL_PENDING' }] } });
    let pulled = '';
    if (stop) {
      const v = decideHandBlockPull({ hand: true, stop, progressed: false, now: NOW, cells: ['ISO-PROBE-1'] });
      if (v.act) {
        // the internal turn: the model follows the prompt — block the waiting cell, then work next
        workBlock('TC-H-CX-2', 'ISO-PROBE-1', { on: 'RES', reason: 'needs RES isolation approval' }, { now: () => NOW, version: 'v', cells: () => cells, scopeOf,
          blocks: () => rows, swap, mail: () => 1, record: (r) => { rows.push(r); } });
        const next = workNext('TC-H-CX-2', { now: () => NOW, version: 'v', cells: () => cells, scopeOf, lastActiveMs: () => NOW, swap,
          blockOf: (c) => { const b = openBlocks(rows, 'v').get(c.id); return b ? blockState(b, 'TC-H-CX-2', undefined, NOW) : undefined; } });
        if (next.code === 0) pulled = next.cell.id;
      }
    }
    const idle = pulled ? 0 : J2_RES_ANSWER_MIN;
    return { id: 'j2 hand TC-H-CX-2 blocked on RES approval', arm, roundsAllowed: '∞' as const, factInstruction: false, toolsNarrowed: false,
      endReason: `✋ ${raised} · ${pulled ? `work block → work next → ${pulled}` : 'sits on ISO-PROBE-1'} · idle-hand-minutes ${idle}`, continued: pulled !== '', queueDrained: null };
  });
}

/** (k) a terra turn of 12 actions: the 1st Bash fails (exit 1), then 11 WebSearch calls (not repair-phase tools). */
export const REPAIR_SCRIPT_ACTIONS = 12;
export async function runRepairPhaseCase(): Promise<CaseRow[]> {
  const out: CaseRow[] = [];
  for (const arm of ['before', 'after'] as const) {
    let requested = 0;
    let dispatched = 0;
    let rejected = 0;
    const provider: LLMProvider = {
      name: 'openai-codex', defaultModel: 'gpt-6.1-terra', available: () => true,
      async *chat() { yield 'forced synthesis: stopped early, the remaining actions were never run in this turn.'; },
      streamChat(messages, options) {
        const synthesis = (options as { toolChoice?: string } | undefined)?.toolChoice === 'none' || !(options as { tools?: unknown[] } | undefined)?.tools?.length;
        const lastText = JSON.stringify(messages.at(-1)?.content ?? '');
        if (lastText.includes('REPAIR ACTION REQUIRED')) rejected += 1;
        const call = !synthesis && requested < REPAIR_SCRIPT_ACTIONS;
        const n = requested;
        if (call) requested += 1;
        return (async function* () {
          if (call) {
            yield (n === 0
              ? { type: 'tool_call', id: `k${n}`, name: 'Bash', args: { command: 'eln release checklist status --owner OP' } }
              : { type: 'tool_call', id: `k${n}`, name: 'WebSearch', args: { query: `bun test flake ${n === 1 ? 'pregate' : `case ${n}`}` } }) as LLMStreamEvent;
            yield { type: 'finish', reason: 'tool_calls' } as LLMStreamEvent;
          } else {
            yield { type: 'text', delta: `done: ${dispatched} actions` } as LLMStreamEvent;
            yield { type: 'finish', reason: 'stop' } as LLMStreamEvent;
          }
        })();
      },
    };
    const text = await streamLLMWithTools([{ role: 'user', content: '내 칸 상태를 확인하고 증거를 모은다' }],
      { onText() {}, dispatchTool: async (name: string) => { dispatched += 1; return name === 'Bash' ? { exitCode: 1, outcome: 'exit', stdout: '', stderr: 'checklist: version not found' } : 'no match'; } },
      { provider, model: provider.defaultModel, tools: [
        { name: 'Bash', description: 'run a shell command', parameters: { type: 'object' } },
        { name: 'WebSearch', description: 'search the web', parameters: { type: 'object' } }],
        sessionId: `sim-seat-repair-${arm}`, seatLoop: arm === 'after' });
    const end = text.includes('forced synthesis') ? 'forced synthesis' : text.includes('done:') ? 'model-end' : 'hard-stop';
    out.push({ id: 'k failed Bash then 11 WebSearch', arm, roundsAllowed: arm === 'after' ? SEAT_TURN_MAX_TOOL_ROUNDS : '∞', factInstruction: false, toolsNarrowed: false,
      endReason: `${dispatched}/${REPAIR_SCRIPT_ACTIONS} actions · repair rejections ${rejected} · ${end}`, continued: dispatched >= REPAIR_SCRIPT_ACTIONS, queueDrained: null });
  }
  return out;
}

/** (H4) 5 self-started turns · then 3 queued-mail turns (outside the gate) · then 3 goal-drive opens. */
export function casePacingReset(): CaseRow[] {
  return (['before', 'after'] as const).map((arm) => {
    const gate = createInternalTurnGate({ isTurnRunning: () => false, getBufferText: () => '', getTypeaheadCount: () => 0,
      pendingKeyCount: () => 0, lastHumanKeyAt: () => 0, now: () => NOW, log: () => {}, turnLifeLog: () => {},
      pacing: { minIntervalMs: 0, maxConsecutive: 5 } });
    gate.port.attach(() => true);
    const runOne = (opened: boolean): void => { if (opened) { gate.takePending(); gate.noteTurnStarted(); gate.noteTurnSettled(); } };
    for (let i = 0; i < 5; i += 1) runOne(gate.startTurnIfIdle('계속', { origin: 'goal-continue' }).opened);
    // before: queued-mail turns started outside the gate never touched the run counter (the old noteTurnStarted path).
    for (let i = 0; i < 3; i += 1) if (arm === 'after') { gate.noteTurnStarted(); gate.noteTurnSettled(); }
    let refused = 0;
    for (let i = 0; i < 3; i += 1) {
      const r = gate.startTurnIfIdle('🚗 자율주행', { origin: 'goal-continue', reason: 'autopilot drive', ...(arm === 'after' ? { ownLimit: true } : {}) });
      if (r.opened) runOne(true); else refused += 1;
    }
    return { id: 'H4 drive after 5 self turns + 3 mail turns', arm, roundsAllowed: '∞' as const, factInstruction: false, toolsNarrowed: false,
      endReason: `drive refused ${refused}/3${refused ? ' (pacing:run-cap 5/5)' : ''}`, continued: refused === 0, queueDrained: null };
  });
}

/** Fake clock ⊕ timer queue for the wake scheduler. */
function wakeWorld(gateResult: (t: number) => { opened: true; turnId: string } | { opened: false; reason: 'Cap'; retryAt: number }) {
  let t = NOW;
  let seq = 0;
  const timers: { at: number; seq: number; fn: () => void }[] = [];
  let attempts = 0;
  let opened = 0;
  const skipped: string[] = [];
  const scheduler = createWakeupScheduler({
    now: () => t,
    setTimer: (fn, ms) => { const h = { at: t + ms, seq: ++seq, fn }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h as (typeof timers)[number]); if (i >= 0) timers.splice(i, 1); },
    startTurnIfIdle: () => { attempts += 1; const r = gateResult(t); if (r.opened) opened += 1; return r; },
    log: (_c, event, data) => { if (event === 'skipped') skipped.push(String(data.reason)); },
  });
  const runUntil = (end: number): void => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = timers[0];
      if (!next || next.at > end) { t = end; return; }
      timers.shift();
      t = next.at;
      next.fn();
    }
  };
  return { scheduler, runUntil, stats: () => ({ attempts, opened, skipped }), start: NOW };
}

/** (H3) a wake refused by pacing that names a retry 100 ms ahead, for 9 min · and two wakes with the same cause 5 min apart. */
export function caseWakeThrash(): CaseRow[] {
  const hot = wakeWorld((t) => ({ opened: false, reason: 'Cap', retryAt: t + 100 }));
  hot.scheduler.schedule({ delaySeconds: 60, reason: '30분 점검' });
  hot.runUntil(hot.start + 60_000 + 9 * 60_000);
  let turn = 0;
  const dup = wakeWorld(() => ({ opened: true, turnId: `auto-${++turn}` }));
  dup.scheduler.schedule({ delaySeconds: 60, repeatMinutes: 30, reason: '30분 점검' });
  dup.scheduler.schedule({ delaySeconds: 360, reason: '30분 점검' });
  dup.runUntil(dup.start + 10 * 60_000);
  // before (the old formula): the paced retry used retryAt − now (100 ms) with no floor → 9 min / 100 ms attempts; no same-cause check.
  const beforeAttempts = Math.round((9 * 60_000) / 100);
  return [
    { id: 'H3 refused wake for 9 min', arm: 'before', roundsAllowed: '∞', factInstruction: false, toolsNarrowed: false,
      endReason: `${beforeAttempts} retries (retryAt−now, no floor)`, continued: null, queueDrained: null },
    { id: 'H3 refused wake for 9 min', arm: 'after', roundsAllowed: '∞', factInstruction: false, toolsNarrowed: false,
      endReason: `${hot.stats().attempts} retries (back-off 5 s→60 s)`, continued: null, queueDrained: null },
    { id: 'H3 two «30분 점검» wakes 5 min apart', arm: 'before', roundsAllowed: '∞', factInstruction: false, toolsNarrowed: false,
      endReason: '2 turns opened', continued: null, queueDrained: null },
    { id: 'H3 two «30분 점검» wakes 5 min apart', arm: 'after', roundsAllowed: '∞', factInstruction: false, toolsNarrowed: false,
      endReason: `${dup.stats().opened} turn opened · skipped ${dup.stats().skipped.join('+') || '-'}`, continued: null, queueDrained: null },
  ];
}

/** (H5) a 10-call turn: 6 Reads of a file that changes after every read, then 4 ListDirs of its directory. */
export async function runFreshReadCase(): Promise<CaseRow[]> {
  const out: CaseRow[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'sim-h5-'));
  try {
    mkdirSync(join(dir, 'OPC'), { recursive: true });
    const file = join(dir, 'OPC', 'coach-notes.md');
    for (const arm of ['before', 'after'] as const) {
      writeFileSync(file, 'note 0\n');
      let requested = 0;
      let dispatched = 0;
      let nudged = false;
      const plan = [...Array.from({ length: 6 }, () => ({ name: 'Read', args: { file_path: file } })),
        ...Array.from({ length: 4 }, () => ({ name: 'ListDir', args: { path: join(dir, 'OPC') } }))];
      const provider: LLMProvider = {
        name: 'openai-codex', defaultModel: 'gpt-6.1-terra', available: () => true,
        async *chat() { yield 'forced synthesis: stopped early, the remaining calls were never run in this turn.'; },
        streamChat(messages, options) {
          const synthesis = (options as { toolChoice?: string } | undefined)?.toolChoice === 'none' || !(options as { tools?: unknown[] } | undefined)?.tools?.length;
          if (messages.some((m) => typeof m.content === 'string' && m.content.includes('You are repeating'))) nudged = true;
          const step = !synthesis ? plan[requested] : undefined;
          const n = requested;
          if (step) requested += 1;
          return (async function* () {
            if (step) {
              yield { type: 'tool_call', id: `h${n}`, name: step.name, args: step.args } as LLMStreamEvent;
              yield { type: 'finish', reason: 'tool_calls' } as LLMStreamEvent;
            } else {
              yield { type: 'text', delta: `done: ${dispatched} calls` } as LLMStreamEvent;
              yield { type: 'finish', reason: 'stop' } as LLMStreamEvent;
            }
          })();
        },
      };
      await streamLLMWithTools([{ role: 'user', content: '코치 노트가 바뀌는 동안 따라 읽는다' }],
        { onText() {}, dispatchTool: async (name: string) => {
          dispatched += 1;
          if (name === 'Read') { const body = `note ${dispatched}\n`.repeat(dispatched); writeFileSync(file, body); return body; }
          return 'coach-notes.md';
        } },
        { provider, model: provider.defaultModel, tools: [
          { name: 'Read', description: 'read a file', parameters: { type: 'object' } },
          { name: 'ListDir', description: 'list a directory', parameters: { type: 'object' } }],
          sessionId: `sim-seat-fresh-${arm}`, seatLoop: arm === 'after' });
      out.push({ id: 'H5 6 Reads of a changing file + 4 ListDir', arm, roundsAllowed: arm === 'after' ? SEAT_TURN_MAX_TOOL_ROUNDS : '∞', factInstruction: false, toolsNarrowed: false,
        endReason: `${dispatched}/${requested} dispatched · blocked ${requested - dispatched} · nudge ${nudged ? 'y' : 'n'}`, continued: requested === 10 && dispatched === 10, queueDrained: null });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return out;
}

/** The leader duties the card must carry (independent phrases). */
export const LEADER_DUTIES = ['ready cells', 'exception cards', '✋ within 10 minutes', '`eln work next`', 'one-line rollup to OP'] as const;

/** (Q10) space lead TC: fixture = thin board (1 ready cell · 3 hands) ⊕ 2 steward exception cards ⊕ 1 ✋. Prompt contract ⊕ one seat-loop turn. */
export async function runLeaderCase(): Promise<CaseRow[]> {
  const out: CaseRow[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'sim-q10-'));
  try {
    for (const arm of ['before', 'after'] as const) {
      // before: seatRole() knew coordinator|hand only — TC resolved to «hand» and no leadership.
      const lead = arm === 'after' ? seatLeadership('TC', { spaces: { build: { coordinator: 'TC' } }, hq: 'OP', seats: [{ id: 'TC' }, { id: 'OP', role: 'coordinator' }] }) : null;
      const prompt = buildUniversalPreamble({ cwd: dir, enabledTools: ['Bash'], seatRole: 'hand', ...(lead ? { seatLeader: lead } : {}), sessionPinned: true })
        .map((m) => String(m.content)).join('\n');
      const duties = LEADER_DUTIES.filter((d) => prompt.includes(d)).length;
      // The scripted leader turn (the model's choices are scripted — the sim proves the loop carries them in one turn).
      const plan = arm === 'after' ? [
        'eln release checklist split SEAT-TURN-FOLLOWUPS --into 3', 'eln release checklist split LAND-QUEUE-1 --into 2',
        'eln steward card judge sc-1 --decision accept', 'eln steward card judge sc-2 --decision reject', 'eln msg hand resolve 171001',
      ] : ['eln release checklist status --owner TC'];
      let i = 0;
      let dispatched = 0;
      const provider: LLMProvider = {
        name: 'openai-codex', defaultModel: 'gpt-6.1-terra', available: () => true,
        async *chat() { yield 'forced synthesis'; },
        streamChat() {
          const cmd = plan[i];
          if (cmd !== undefined) i += 1;
          return (async function* () {
            if (cmd !== undefined) { yield { type: 'tool_call', id: `q${i}`, name: 'Bash', args: { command: cmd } } as LLMStreamEvent; yield { type: 'finish', reason: 'tool_calls' } as LLMStreamEvent; }
            else { yield { type: 'text', delta: 'board ready · 2 cards judged · ✋ resolved' } as LLMStreamEvent; yield { type: 'finish', reason: 'stop' } as LLMStreamEvent; }
          })();
        },
      };
      await streamLLMWithTools([{ role: 'user', content: 'TC 공간 점검' }], { onText() {}, dispatchTool: async () => { dispatched += 1; return 'ok'; } },
        { provider, model: provider.defaultModel, tools: [{ name: 'Bash', description: 'run a shell command', parameters: { type: 'object' } }],
          sessionId: `sim-q10-${arm}`, seatLoop: true });
      const done = arm === 'after' ? 'split 2 · judged 2 · ✋ resolved 1' : 'status only';
      out.push({ id: 'Q10 space lead TC · 2 cards + 1 ✋ + thin board', arm, roundsAllowed: SEAT_TURN_MAX_TOOL_ROUNDS, factInstruction: false, toolsNarrowed: false,
        endReason: `profile ${lead ? 'leader' : 'hand'} · duties ${duties}/5 · ${dispatched} actions (${done})`, continued: duties === 5 && dispatched === 5, queueDrained: null });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return out;
}

/** The scripted continuation of the 11-25 incident: 20 `eln seat assign` calls, 8 of them repeats of an earlier target. */
export const ASSIGN_STORM = ['CX1 LAND-QUEUE-1', 'CX2 TSC-ROOTS', 'CX1 LAND-QUEUE-1', 'CX3 DRAFT-ZERO', 'CX2 TSC-ROOTS', 'CX4 NEXTMOVE', 'CX1 LAND-QUEUE-1',
  'CX5 GRAPH-EDGES', 'CX3 DRAFT-ZERO', 'CX6 PRLAND-HEAVY', 'CX2 TSC-ROOTS', 'CX7 HARDEN', 'CX8 REFUSAL', 'CX1 LAND-QUEUE-1', 'CX9 WORKER',
  'CX4 NEXTMOVE', 'CX10 ROSTER', 'CX11 REVIEW', 'CX5 GRAPH-EDGES', 'CX12 PODS'];

/** (L) OP standing goal «착지 10/h — 멈춘 칸 재배정» (goal set without --task) ⊕ the assign storm in a continuation. */
export async function runAssignStormCase(): Promise<CaseRow[]> {
  const base = { goalId: 'first:land-10', failed: false, paused: false, backoff: false, personQueued: 0, needsHuman: false, waitingOn: 0,
    backgroundRunning: 0, sameReply: false, stateChanged: true, history: [] as number[], now: NOW };
  const out: CaseRow[] = [];
  for (const arm of ['before', 'after'] as const) {
    // before: every open goal drove (no task judgement); after: the goal set without --task is standing.
    const v = decideGoalDrive({ ...base, ...(arm === 'after' ? { taskGoal: false } : {}) });
    out.push({ id: 'L standing goal «착지 10/h — 멈춘 칸 재배정»', arm, roundsAllowed: '∞', factInstruction: false, toolsNarrowed: false,
      endReason: v.kind === 'continue' ? `continuation opened (drive:${v.signal})` : `0 continuations (${v.reason})`, continued: v.kind === 'continue', queueDrained: null });
  }
  for (const arm of ['before', 'after'] as const) {
    const assigned: string[] = [];
    let i = 0;
    const provider: LLMProvider = {
      name: 'openai-codex', defaultModel: 'gpt-6.1-terra', available: () => true,
      async *chat() { yield 'Done: assigned the stalled cells once each. Remaining: 7 cells unowned. Next: read the board before any new assign.'; },
      streamChat(_messages, options) {
        const synthesis = (options as { toolChoice?: string } | undefined)?.toolChoice === 'none' || !(options as { tools?: unknown[] } | undefined)?.tools?.length;
        const target = !synthesis ? ASSIGN_STORM[i] : undefined;
        if (target !== undefined) i += 1;
        return (async function* () {
          if (target !== undefined) { yield { type: 'tool_call', id: `l${i}`, name: 'Bash', args: { command: `eln seat assign ${target}` } } as LLMStreamEvent; yield { type: 'finish', reason: 'tool_calls' } as LLMStreamEvent; }
          else { yield { type: 'text', delta: 'done' } as LLMStreamEvent; yield { type: 'finish', reason: 'stop' } as LLMStreamEvent; }
        })();
      },
    };
    const text = await streamLLMWithTools([{ role: 'user', content: '🚗 자율주행 · 골 미완: 착지 10/h' }],
      { onText() {}, dispatchTool: async (_name: string, args: Record<string, unknown>) => { assigned.push(String(args.command)); return 'assigned · mail posted'; } },
      { provider, model: provider.defaultModel, tools: [{ name: 'Bash', description: 'run a shell command', parameters: { type: 'object' } }],
        sessionId: `sim-assign-storm-${arm}`, seatLoop: true, driveContinuation: arm === 'after' });
    const duplicates = assigned.length - new Set(assigned).size;
    out.push({ id: 'L task continuation · 20 assigns (8 repeats)', arm, roundsAllowed: SEAT_TURN_MAX_TOOL_ROUNDS, factInstruction: false, toolsNarrowed: false,
      endReason: `${assigned.length} assign mails · ${duplicates} duplicates · ${text.includes('Remaining:') ? 'summary' : 'model-end'}`,
      continued: null, queueDrained: null });
  }
  return out;
}

/** The live examples (11-25): relayed crown-flagged mail (bulletin · «keep going» nudge · a request naming a cell) and the CEO's own typed lines. */
export const LIVE_CEO_TURNS = [
  { turnId: 'relay-bulletin', text: '[공보] 0.3.37 데모 빌드 · 오늘 18:00', kind: 'announce', announce: true, human: false },
  { turnId: 'relay-nudge', text: '계속 더 나아가면 되는데 왜 멈췄죠', kind: 'info', human: false },
  { turnId: 'relay-cell', text: 'SEAT-TURN-FOLLOWUPS 오늘 착지', kind: 'request', refs: ['cell:SEAT-TURN-FOLLOWUPS'], human: false },
  { turnId: 'typed-ref', text: 'PR 40097 오늘 착지시켜', refs: ['pr:40097'], human: true },
  { turnId: 'typed-noref', text: '지금 전체 연방 운영중인가요?', human: true },
] as const;

/** (R) the five lines over two turn ends each (door open · nothing changes) ⊕ a store holding 2 old unreferenced blocked requirements. */
export async function runRequirementCase(): Promise<CaseRow[]> {
  const out: CaseRow[] = [];
  const root = mkdtempSync(join(tmpdir(), 'sim-req-'));
  try {
    for (const arm of ['before', 'after'] as const) {
      const dir = join(root, arm);
      const path = requirementStorePath(dir, 'OP');
      mkdirSync(dir, { recursive: true });
      const old = emptyStore();
      for (const id of ['ceo:old-1', 'ceo:old-2']) old.requirements.push({ id, source: { kind: 'ceo-directive', turnId: id.slice(4) }, title: 'old line', closeCondition: 'x', next: 'y', status: 'blocked', revision: 1, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() });
      writeStore(path, old);
      const sticky: string[] = [];
      const cards: string[] = [];
      for (let i = 0; i < LIVE_CEO_TURNS.length; i += 1) {
        const t = LIVE_CEO_TURNS[i]!;
        // before: the turn carried no kind/refs/origin to the loop — every line became `ceo:<turn>` with artifact evidence only.
        const line = arm === 'before' ? { turnId: t.turnId, text: t.text, refs: ['cell:ANY'] } : { ...t, refs: 'refs' in t ? [...t.refs] : [] };
        for (let k = 0; k < 2; k += 1) {
          await runRequirementTurnEnd({ seat: 'OP', humanTurn: k === 0 ? line : null, now: () => new Date(NOW + (i * 2 + k) * 60_000), stateRoot: () => dir,
            startTurnIfIdle: () => ({ opened: true, turnId: `t${i}${k}` }), gather: async () => ({ seed: {}, waitState: () => 'none' }), log: () => {},
            notify: (l) => { sticky.push(l); }, postMail: () => undefined, coordinatorOf: () => undefined,
            raiseException: arm === 'after' ? (r: { id: string }) => { cards.push(r.id); return `card-${r.id}`; } : (_r: unknown, l: string) => { sticky.push(l); return undefined; } });
        }
      }
      const store = readStore(path);
      const reqs = store.requirements.filter((r) => r.source.kind === 'ceo-directive' && r.status !== 'superseded').map((r) => `${r.id.slice(4)}:${r.evidenceMode ?? 'artifact'}`).sort();
      const preUnify = store.requirements.filter((r) => r.supersededReason === 'pre-unify migration').length;
      const digest = sticky.filter((l) => l.includes('pre-unify')).length;
      // REQ-BLOCK-ROUTE-TO-ASKEE: the before arm (pre-route code) turned every BLOCKED bulletin into a sticky line; the after
      // arm routes it — a CEO line without a CEO-only gap closes as stale, never as a CEO card.
      const stickyBlocked = arm === 'before' ? store.bulletin.length : sticky.filter((l) => l.includes('BLOCKED')).length;
      const stale = store.requirements.filter((r) => r.status === 'stale').length;
      // the seat answers the typed line without refs; an «answered» close on an artifact requirement is refused
      const answered = closeRequirement(store, 'ceo:typed-noref', { kind: 'answered', replyTurnId: 't41' }, new Date(NOW + 20 * 60_000).toISOString());
      const refused = store.requirements.some((r) => r.id === 'ceo:typed-ref') ? closeRequirement(store, 'ceo:typed-ref', { kind: 'answered', done: 'done' }, new Date(NOW + 20 * 60_000).toISOString()) : { closed: false, reason: 'absent' };
      out.push({ id: 'R relayed bulletin/nudge/cell-request + CEO typed with/without ref · 2 old', arm, roundsAllowed: '∞', factInstruction: false, toolsNarrowed: false,
        endReason: `reqs [${reqs.join(',')}] · pre-unify closed ${preUnify} (digest ${digest}) · sticky BLOCKED ${stickyBlocked} · cards ${cards.length}${arm === 'after' ? ` · stale ${stale}` : ''} · answered-close ${answered.closed ? 'ok' : answered.reason} · artifact-by-answer ${refused.closed ? 'closed' : refused.reason}`,
        continued: null, queueDrained: null });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  return out;
}

/** (F) an idle seat after a mail turn 3 min ago: 28 info held · 28 info + 1 request · 28 info held 21 min · 28 info + request, no turn for 11 min. */
export function caseIdleFlush(): CaseRow[] {
  const run = (label: string, opts: { request?: boolean; ageMs?: number; lastTurnAgoMs: number }): CaseRow[] => (['before', 'after'] as const).map((arm) => {
    const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
    for (let i = 0; i < 28; i += 1) queue.enqueueNotice(`[seat-mail] info #${165000 + i}`, 'seat-mail', { msgId: 165000 + i, passive: true, mailClass: 'P2', mailIntent: 'info' });
    if (opts.request) queue.enqueueNotice('[seat-mail] request #165100', 'seat-mail', { msgId: 165100, passive: true, mailClass: 'P2', mailIntent: 'request' });
    const items = queue.items.filter((item) => item.status === 'queued').map((item) => ({ ...item, enqueuedAt: NOW - (opts.ageMs ?? 60_000) }));
    // before (#40092 PASSIVE-HOLD-WHILE-BUSY, read from its code): idle with held mail and no open work = release(work-done) every time.
    const v = arm === 'before' ? { kind: 'release' as const, reason: 'work-done' as const }
      : decideIdleQueue({ items, waits: NO_WAITS, workInProgress: false, continuationsWhileHolding: 0, awaitingStartSince: null, continuationTried: false,
        lastMailTurnAt: NOW - opts.lastTurnAgoMs, now: NOW, holdOnlyWhileBusy: true });
    return { id: `F ${label}`, arm, roundsAllowed: '∞' as const, factInstruction: false, toolsNarrowed: false,
      endReason: `${v.kind}${'reason' in v ? `(${v.reason})` : ''}`, continued: null, queueDrained: v.kind === 'release' };
  });
  return [
    ...run('28 info · last flush 3 min ago', { lastTurnAgoMs: 3 * 60_000 }),
    ...run('28 info + 1 request · last flush 3 min ago', { request: true, lastTurnAgoMs: 3 * 60_000 }),
    ...run('28 info + 1 request · last flush 11 min ago', { request: true, lastTurnAgoMs: 11 * 60_000 }),
    ...run('28 info held 21 min', { ageMs: 21 * 60_000, lastTurnAgoMs: 3 * 60_000 }),
  ];
}

/** (X) OP retracts #170500 (refs cell:LAND-QUEUE-1 · pr:40111) mid-continuation; the model still plans pregate + a msg on it. */
export async function runRetractCase(): Promise<CaseRow[]> {
  const out: CaseRow[] = [];
  for (const arm of ['before', 'after'] as const) {
    clearRetractedTargets();
    const plan = ['gh pr ready 40111', 'eln msg post --to RES --body "pregate 40111" --ref pr:40111', 'git push origin fix/land-queue',
      'eln seat assign CX2 LAND-QUEUE-1', 'eln msg post --to TC --body "TSC-ROOTS next" --ref cell:TSC-ROOTS'];
    let i = 0;
    const sent: string[] = [];
    const provider: LLMProvider = {
      name: 'openai-codex', defaultModel: 'gpt-6.1-terra', available: () => true,
      async *chat() { yield 'done'; },
      streamChat() {
        const cmd = plan[i];
        if (cmd !== undefined) i += 1;
        // the retraction lands after the first action (mid-continuation)
        if (i === 2 && arm === 'after') noteRetractedRefs(['cell:LAND-QUEUE-1', 'pr:40111']);
        return (async function* () {
          if (cmd !== undefined) { yield { type: 'tool_call', id: `x${i}`, name: 'Bash', args: { command: cmd } } as LLMStreamEvent; yield { type: 'finish', reason: 'tool_calls' } as LLMStreamEvent; }
          else { yield { type: 'text', delta: 'done' } as LLMStreamEvent; yield { type: 'finish', reason: 'stop' } as LLMStreamEvent; }
        })();
      },
    };
    await streamLLMWithTools([{ role: 'user', content: '착지 열차 진행' }], { onText() {}, dispatchTool: async (_n: string, args: Record<string, unknown>) => { sent.push(String(args.command)); return 'ok'; } },
      { provider, model: provider.defaultModel, tools: [{ name: 'Bash', description: 'run a shell command', parameters: { type: 'object' } }], sessionId: `sim-retract-${arm}`, seatLoop: true });
    clearRetractedTargets();
    const onTarget = sent.slice(1).filter((c) => /40111|LAND-QUEUE-1/u.test(c)).length;
    out.push({ id: 'X retract #170500 (cell:LAND-QUEUE-1 · pr:40111) mid-continuation', arm, roundsAllowed: SEAT_TURN_MAX_TOOL_ROUNDS, factInstruction: false, toolsNarrowed: false,
      endReason: `after the retraction: ${onTarget} action(s) on the target · ${sent.length - 1 - onTarget} other`, continued: null, queueDrained: null });
  }
  return out;
}

export { SEAT_REPEAT_NUDGE_AT, SEAT_REPEAT_STOP_AT };

const yn = (v: boolean | null): string => (v === null ? '-' : v ? 'y' : 'n');
export function caseTable(rows: readonly CaseRow[]): string[] {
  return ['| case | arm | tool rounds allowed | fact instr | allowlist narrowed | turn end | continued | queue drained |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.arm} | ${r.roundsAllowed} | ${yn(r.factInstruction)} | ${yn(r.toolsNarrowed)} | ${r.endReason} | ${yn(r.continued)} | ${yn(r.queueDrained)} |`)];
}

export { SEAT_TURN_MAX_TOOL_ROUNDS };

// ── SIM-SIGNAL (Q5 DIRECTIVE-EXPIRY ⊕ Q6 SIGNAL-INBOX-SNAPSHOT) ─────────────────────────────────────────────────────────
// A real ledger (temp MsgStore) replays one TC seat over four turns: OP orders «assign PR 7 now» (crown directive), mail
// keeps arriving, then OP withdraws the order. The scripted seat model reads its inbox with MsgList unless the turn's
// volatile context already carries the «Inbox (unhandled)» block, and it executes every live directive it finds.
// before = no expiry stamp · no retract · no snapshot · after = postExpiry ⊕ store.retract ⊕ seatInboxSnapshotText.

export interface SignalRow { readonly arm: Arm; readonly turns: number; readonly msgListCalls: number; readonly staleDirectiveExecutions: number; readonly expiredShown: number }

export function runSignalCase(): SignalRow[] {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  const { openMsgStore } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
  const { postExpiry } = require('../msg/directive-expiry.js') as typeof import('../msg/directive-expiry.js');
  const { seatInboxSnapshotText, resetInboxSnapshotMemory, LAPSED_LOOKBACK_MS: _l } = require('../msg/inbox-snapshot-turn.js') as typeof import('../msg/inbox-snapshot-turn.js');
  const out: SignalRow[] = [];
  for (const arm of ['before', 'after'] as const) {
    resetInboxSnapshotMemory();
    const store = openMsgStore(join(mkdtempSync(join(tmpdir(), `sim-signal-${arm}-`)), 'messages.db'));
    const stamp = (kind: string, crown?: string) => (arm === 'after' ? postExpiry({ kind, ...(crown ? { crownDirective: crown } : {}), now: new Date() }).expiresAt : undefined);
    const post = (body: string, kind: string, crown?: string, supersedes?: number) => {
      const expiresAt = stamp(kind, crown);
      return store.post({ from: 'OP', to: 'TC', body, kind, ...(crown ? { crownDirective: crown } : {}), ...(expiresAt ? { expiresAt } : {}), ...(supersedes ? { supersedes } : {}) }, { dedupe: false });
    };
    const directive = post('assign PR 7 to TC now', 'request', '501');
    let msgListCalls = 0;
    let stale = 0;
    let expiredShown = 0;
    let retracted = false;
    const turn = (): void => {
      const snapshot = arm === 'after' ? seatInboxSnapshotText('TC', { openStore: () => store }) : null;
      if (snapshot !== null) expiredShown += snapshot.split('\n').filter((l) => l.startsWith('expired: #')).length;
      // the scripted model: no snapshot block → it polls MsgList (once per turn) to find its work
      const inbox = snapshot === null ? (msgListCalls += 1, store.list('TC', store.getCursor('TC'), 200)) : store.list('TC', store.getCursor('TC'), 200);
      const visible = snapshot === null ? inbox : inbox.filter((m) => snapshot.includes(`#${m.id} ·`));
      for (const m of visible) if (m.crownDirective && retracted && m.id === directive.id) stale += 1;
    };
    turn(); // T1 — the order is live: acting on it is right
    post('PR 7 is already taken by UX', 'info');
    turn(); // T2
    const withdraw = post('withdraw: do not assign PR 7', 'info', undefined, directive.id);
    if (arm === 'after') store.retract(directive.id, 'OP');
    retracted = true;
    void withdraw;
    turn(); // T3 — the order was withdrawn: acting on it is stale
    turn(); // T4
    out.push({ arm, turns: 4, msgListCalls, staleDirectiveExecutions: stale, expiredShown });
    store.close();
  }
  return out;
}

export function signalTable(rows: readonly SignalRow[]): string[] {
  return ['| arm | turns | MsgList calls | MsgList / turn | stale directive executions | «expired: #id» lines |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.arm} | ${r.turns} | ${r.msgListCalls} | ${(r.msgListCalls / r.turns).toFixed(2)} | ${r.staleDirectiveExecutions} | ${r.expiredShown} |`)];
}

// ── SIM-OUTBOUND (H6 OUTBOUND-COALESCE) — OP sends 8 ordinary orders to TC and 4 to UX inside 10 min, plus 1 crown
// order to TC. before = every post is a row and a wake · after = coalesceEligible ⊕ store.coalesceInto (real ledger).
export interface OutboundRow { readonly arm: Arm; readonly posts: number; readonly rows: number; readonly wakes: number; readonly crownRows: number }

export function runOutboundCase(): OutboundRow[] {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  const { openMsgStore } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
  const { coalesceEligible, COALESCE_WINDOW_MS } = require('../msg/outbound-coalesce.js') as typeof import('../msg/outbound-coalesce.js');
  const out: OutboundRow[] = [];
  for (const arm of ['before', 'after'] as const) {
    const store = openMsgStore(join(mkdtempSync(join(tmpdir(), `sim-outbound-${arm}-`)), 'messages.db'));
    const plan: Array<{ to: string; crown?: string }> = [
      ...Array.from({ length: 8 }, () => ({ to: 'TC' })), ...Array.from({ length: 4 }, () => ({ to: 'UX' })), { to: 'TC', crown: '600' }];
    let wakes = 0;
    plan.forEach((p, i) => {
      const body = `step ${i + 1}`;
      if (arm === 'after' && coalesceEligible({ senderAbove: true, kind: 'info', crownDirective: p.crown ?? null })
        && store.coalesceInto('OP', p.to, body, COALESCE_WINDOW_MS) !== null) return; // joined: no new row, no wake
      store.post({ from: 'OP', to: p.to, body, kind: 'info', ...(p.crown ? { crownDirective: p.crown } : {}) }, { dedupe: false });
      wakes += 1;
    });
    const rows = store.countSentSince('OP', new Date(Date.now() - 60 * 60_000));
    const crownRows = store.list('TC', 0, 100).filter((m) => m.crownDirective).length;
    out.push({ arm, posts: plan.length, rows, wakes, crownRows });
    store.close();
  }
  return out;
}

export function outboundTable(rows: readonly OutboundRow[]): string[] {
  return ['| arm | OP posts | rows stored | receiver wakes | crown rows kept |', '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.arm} | ${r.posts} | ${r.rows} | ${r.wakes} | ${r.crownRows} |`)];
}

// ── SIM-FLOOD (Q9 SEAT-MAIL-FLOOD) — 12 passive-class ordinary mails (kind request · not passive-flagged, so each would
// open a turn) to an idle OP in 2 min, 1 crown and 1 alert inside the burst, then quiet; 1 ordinary mail 12 min later.
// before = no meter (every arrival knocks) · after = createFloodMeter on the real arrival door (seatMailOnArrived).
export interface FloodRow { readonly arm: Arm; readonly arrivals: number; readonly turnsOpened: number; readonly foldedToDigest: number; readonly exemptOpened: number; readonly afterQuietOpened: boolean; readonly floodEvents: string }

export function runFloodCase(): FloodRow[] {
  const { seatMailOnArrived } = require('../tui/seat-mail-on-arrived.js') as typeof import('../tui/seat-mail-on-arrived.js');
  const { createFloodMeter } = require('../tui/seat-mail-flood.js') as typeof import('../tui/seat-mail-flood.js');
  const t0 = Date.parse('2026-11-25T09:00:00.000Z');
  const out: FloodRow[] = [];
  for (const arm of ['before', 'after'] as const) {
    let knocks = 0;
    let now = t0;
    const events: string[] = [];
    const door = seatMailOnArrived({ busy: () => false, injectKey: () => { knocks += 1; }, queueWake: 'wake', now: () => now,
      ...(arm === 'after' ? { flood: createFloodMeter('OP', (e, d) => events.push(`${e}@${d.rate}`)) } : {}) });
    let exemptOpened = 0;
    const burst: Array<{ crown?: string; kind: string }> = [
      ...Array.from({ length: 6 }, () => ({ kind: 'request' })), { kind: 'request', crown: '700' },
      ...Array.from({ length: 6 }, () => ({ kind: 'request' })), { kind: 'alert' }];
    burst.forEach((m, i) => {
      now = t0 + Math.round((i * 120_000) / burst.length);
      const before = knocks;
      door([{ msgId: i + 1, seat: 'OP', text: `m${i + 1}`, kind: m.kind, ...(m.crown ? { crownDirective: m.crown } : {}) }]);
      if ((m.crown || m.kind === 'alert') && knocks > before) exemptOpened += 1;
    });
    const inBurst = knocks;
    now = t0 + 12 * 60_000;
    door([{ msgId: 100, seat: 'OP', text: 'later', kind: 'request' }]);
    out.push({ arm, arrivals: burst.length, turnsOpened: inBurst, foldedToDigest: burst.length - inBurst, exemptOpened, afterQuietOpened: knocks > inBurst, floodEvents: events.join(' ') || '-' });
  }
  return out;
}

export function floodTable(rows: readonly FloodRow[]): string[] {
  return ['| arm | burst mails (2 min) | turns opened | folded to digest | crown/alert opened | ordinary mail at +12 min opens | msg.flood |', '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.arm} | ${r.arrivals} | ${r.turnsOpened} | ${r.foldedToDigest} | ${r.exemptOpened}/2 | ${r.afterQuietOpened ? 'y' : 'n'} | ${r.floodEvents} |`)];
}

// ── SIM-RAIL30 (verify-3u gaps after rail 28) ─────────────────────────────────────────────────────────────────────────
//   ①  msg/post-gate.ts G ⊕ msg/delegation-facts.ts — OP at 25 self-started + 5 mail-opened turns in the hour; TC posts
//      the result of OP's own ask (replyTo OP's mail). before = every turn stamped as one (30/h > 20) and no delegation
//      facts → folded · after = only mail-opened turns count (5/h) and the reply is urgent → a row.
//   ②  G ⊕ tui/seat-mail-flood.ts Q9 ⊕ tui/self-wake-coach-feed.ts — OP over 20 mail-opened turns/h; TC sends 12 info
//      lines in 2 min plus a crown order, an alert and a legacy `needs-human` mail. before = the folds never reach the
//      meter (Q9 never engages) and G folds the legacy needs-human · after = the feed hands the folds to the meter (flood
//      engages) and G folds nothing Q9 would let through.
//   ④  skills/tools/schedule-wakeup.ts restore — JUD restarts at 16:55 with one-shots due 00:01 · 05:23 · 16:40.
//   ⑤  seat/wake-ledger.ts — the steward wakes a dead hand on the same cell every 20 min for 2 h (no turn after any).
export interface Rail30Row { readonly id: string; readonly arm: Arm; readonly result: string }

export function runRail30MailCase(): Rail30Row[] {
  const { gatePost } = require('../msg/post-gate.js') as typeof import('../msg/post-gate.js');
  const { isUrgentPost } = require('../msg/post-discipline.js') as typeof import('../msg/post-discipline.js');
  const { noteTurnStamp, turnsLastHour, appendDiverted } = require('../msg/diverted-mail.js') as typeof import('../msg/diverted-mail.js');
  const { createFloodMeter } = require('../tui/seat-mail-flood.js') as typeof import('../tui/seat-mail-flood.js');
  const { createSelfWakeCoachFeed } = require('../tui/self-wake-coach-feed.js') as typeof import('../tui/self-wake-coach-feed.js');
  const t0 = Date.parse('2026-11-25T09:00:00.000Z');
  const out: Rail30Row[] = [];
  for (const arm of ['before', 'after'] as const) {
    const root = mkdtempSync(join(tmpdir(), `sim-rail30-${arm}-`));
    try {
      // ① 25 self-started (goal drive · self-wake) + 5 mail-opened turns in the last hour.
      for (let i = 0; i < 30; i += 1) noteTurnStamp('OP', t0 - 55 * 60_000 + i * 60_000, root, arm === 'before' ? true : i % 6 === 0);
      const perHour = turnsLastHour('OP', t0, root);
      const deps = (now: number) => ({
        pendingPassive: () => 0, turnsLastHour: () => turnsLastHour('OP', now, root), log: () => {}, now: () => new Date(now),
        append: (ledger: Parameters<typeof appendDiverted>[0], entry: Parameters<typeof appendDiverted>[1]) => appendDiverted(ledger, entry, root),
        ...(arm === 'after' ? { delegation: { replyToOwn: (id: number, seat: string) => id === 4101 && seat === 'OP', cellDelegated: () => false } } : {}),
      });
      const result = gatePost({ envelope: { from: 'TC', to: 'OP', body: 'PR 7 green — your ask #4101 is done', kind: 'status', replyTo: 4101 }, entrance: 'cli' }, deps(t0));
      out.push({ id: '① delegated result to OP (25 self + 5 mail turns/h)', arm, result: `turns/h read ${perHour} · ${result.action === 'post' ? 'row (reaches the router)' : `folded (${result.action})`}` });
      // ② saturate OP's mail-opened turns, then the burst.
      for (let i = 0; i < 22; i += 1) noteTurnStamp('OP', t0 - 30 * 60_000 + i * 60_000, root, true);
      const meter = createFloodMeter('OP');
      let now = t0;
      const feed = createSelfWakeCoachFeed({ seat: 'OP', root, now: () => now, schedule: () => true, enqueuePassive: () => {}, log: () => {},
        ...(arm === 'after' ? { onFoldedArrivals: (entries) => { meter.noteFolded(entries.map((e) => Date.parse(e.at)), now); } } : {}) });
      let folded = 0;
      const exemptFolded: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        now = t0 + i * 10_000;
        if (gatePost({ envelope: { from: 'TC', to: 'OP', body: `status line ${i + 1}`, kind: 'info' }, entrance: 'cli' }, deps(now)).action === 'divert') folded += 1;
      }
      const exempt: Array<{ label: string; env: Record<string, unknown>; entrance: 'cli' | 'legacy' }> = [
        { label: 'crown', env: { kind: 'request', crownDirective: '701' }, entrance: 'cli' },
        { label: 'alert', env: { kind: 'alert' }, entrance: 'cli' },
        { label: 'needs-human', env: { kind: 'needs-human' }, entrance: 'legacy' },
      ];
      for (const e of exempt) {
        now += 5_000;
        const g = gatePost({ envelope: { from: 'TC', to: 'OP', body: e.label, ...e.env } as never, entrance: e.entrance }, deps(now));
        // before = the old G urgent rule alone (isUrgentPost) — the post would have been folded when it says «not urgent».
        const folds = arm === 'before' ? !isUrgentPost({ from: 'TC', to: 'OP', ...e.env, cls: e.entrance === 'legacy' ? 'info' : undefined } as never) : g.action === 'divert';
        if (folds) exemptFolded.push(e.label);
      }
      now = t0 + 150_000;
      feed.tick();
      const state = meter.state(now);
      out.push({ id: '② 12 info lines in 2 min to a saturated OP', arm,
        result: `G folded ${folded}/12 · Q9 meter rate ${state.rate} · flood ${state.flood ? 'ENGAGED' : 'off'} · exempt folded by G: ${exemptFolded.join('+') || 'none'}` });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  return out;
}

export function runRail30WakeCase(): Rail30Row[] {
  const { claimSeatWake } = require('../seat/wake-ledger.js') as typeof import('../seat/wake-ledger.js');
  const out: Rail30Row[] = [];
  const restartAt = new Date(2026, 10, 25, 16, 55, 0).getTime();
  const due = (h: number, m: number): number => new Date(2026, 10, 25, h, m, 0).getTime();
  for (const arm of ['before', 'after'] as const) {
    // ④ restore after a restart.
    const saved: Array<{ id: string; reason: string; dueAt: number; retried: boolean; fireCount: number }> = [
      { id: 'w1', reason: '00:01 판정 점검', dueAt: due(0, 1), retried: false, fireCount: 0 },
      { id: 'w2', reason: '05:23 발행 확인', dueAt: due(5, 23), retried: false, fireCount: 0 },
      { id: 'w3', reason: '16:40 PR 7 재확인', dueAt: due(16, 40), retried: false, fireCount: 0 },
    ];
    const notes: string[] = [];
    let fired = 0;
    const timers: Array<() => void> = [];
    const scheduler = createWakeupScheduler({
      now: () => restartAt,
      setTimer: (fn) => { timers.push(fn); return timers.length; },
      clearTimer: () => {},
      startTurnIfIdle: () => { fired += 1; return { opened: true, turnId: `t${fired}` }; },
      persist: { load: () => saved.map((e) => ({ ...e })), save: () => {} },
      notify: (line: string) => { notes.push(line); },
      log: () => {},
      ...(arm === 'before' ? { restoreDropAfterMs: Number.POSITIVE_INFINITY } : {}),
    } as Parameters<typeof createWakeupScheduler>[0]);
    const replayed = scheduler.list().some((e) => e.reason.includes('00:01') || e.reason.includes('05:23'));
    out.push({ id: '④ JUD restart 16:55 · saved wakes 00:01 · 05:23 · 16:40', arm,
      result: `00:01/05:23 replayed ${replayed ? 'yes' : 'no'} · 16:40 kept ${scheduler.list().some((e) => e.reason.includes('16:40')) ? 'yes' : 'no'} · ${notes.find((n) => n.includes('dropped 2 stale wakes')) ? 'one line «dropped 2 stale wakes»' : 'no drop line'}` });
    // ⑤ a dead hand (idle since 09:00) woken on CELL-9 every 20 min for 2 h.
    const dir = mkdtempSync(join(tmpdir(), `sim-rail30-wake-${arm}-`));
    try {
      const path = join(dir, 'wake.sqlite');
      const start = due(10, 0);
      let wakes = 0; let raised = 0; let quiet = 0;
      for (let i = 0; i < 7; i += 1) {
        const claim = claimSeatWake(path, { seat: 'TC-H-CX-6', by: 'steward:TC', cell: 'CELL-9', atMs: start + i * 20 * 60_000,
          ...(arm === 'after' ? { lastActivityMs: due(9, 0) } : {}) });
        if (claim.ok) wakes += 1;
        else if (claim.unanswered?.raise) raised += 1;
        else quiet += 1;
      }
      out.push({ id: '⑤ dead hand · same cell · 7 wake attempts over 2 h', arm, result: `wakes ${wakes} · ✋ cards ${raised} · quiet refusals ${quiet}` });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

export function rail30Table(rows: readonly Rail30Row[]): string[] {
  return ['| case | arm | result |', '|---|---|---|', ...rows.map((r) => `| ${r.id} | ${r.arm} | ${r.result} |`)];
}
