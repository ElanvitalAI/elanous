// SESSION-AUTOPILOT — the structured door. The model calls `autopilot_set` whenever the person's message is about
// turning the autopilot mode on / off / resuming / holding (any phrasing — the words and verbs below are listed in the
// tool description and the one system-prompt line so the model reliably calls it; nothing here matches keywords).
// `autopilot_goal_set` / `autopilot_goal_remove` edit the person's goal stack (a write in an autonomous turn is refused
// and becomes a proposal card). The REPL child writes the state file; the TUI re-reads it at turn end and on its tick.
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { autopilotStateFile, createAutopilot, raiseAutopilotDecision, raiseGoalProposalCard, readAutopilotState, type AutopilotSetRequest } from './autopilot.js';
import { autopilotGoalsFile, removeGoal, setGoal, type GoalSetInput } from './goals.js';

export const AUTOPILOT_TOOL_NAME = 'autopilot_set';
export const AUTOPILOT_GOAL_SET_TOOL_NAME = 'autopilot_goal_set';
export const AUTOPILOT_GOAL_REMOVE_TOOL_NAME = 'autopilot_goal_remove';

/** Words that name the mode, and the on / off verbs — listed for the model (description + prompt line), not matched. */
export const AUTOPILOT_WORDS = ['자율주행', '오토파일럿', 'autopilot', '자동 운행', '알아서 운전'] as const;
export const AUTOPILOT_ON_VERBS = ['시작', '켜', 'on'] as const;
export const AUTOPILOT_OFF_VERBS = ['끝', '꺼', '해제', '종료', 'off'] as const;

/** The one system-prompt line (stable prefix · present when the tool is in the profile). */
export const AUTOPILOT_PROMPT_LINE = `자율주행 모드: 사람의 말이 ${AUTOPILOT_WORDS.map((w) => `«${w}»`).join('·')} 모드를 켜거나(${AUTOPILOT_ON_VERBS.join('·')}) 끄는(${AUTOPILOT_OFF_VERBS.join('·')}) 뜻이면 — 낱말과 켜기/끄기 동사가 있으면 확인 없이 — 바로 ${AUTOPILOT_TOOL_NAME}({on:true, goal?} | {on:false})를 부른다. «다시 자율주행»=on:true · «이제부터 내가 운전하겠다»=on:true,hold:true. 새 요청·다른 방향·긴급 지시는 자율주행을 멈추지 않는다 — 켜진 채로 처리하고, 새 방향이면 {on:true, goal}로 목표만 바꾼다. 사람이 목표(단기 발행 일정·중기 데모 같은 마일스톤·장기 월/분기)를 정하거나 고치거나 지우면 ${AUTOPILOT_GOAL_SET_TOOL_NAME}/${AUTOPILOT_GOAL_REMOVE_TOOL_NAME} 을 부른다 — 목표를 스스로 만들지 않는다. 📌 작업 골은 사람이 «골로 잡아» 처럼 골 설정을 명시할 때만(explicit_ask 에 그 말을 그대로 인용) — 질문·요청·기한 있는 부탁은 이번 턴에 답하거나 처리한다.`;

export function buildAutopilotTools(): LLMToolSpec[] {
  return [
    {
      name: AUTOPILOT_TOOL_NAME,
      description: `Turn this session's autopilot (자율주행) mode on or off. Call it whenever the person's message is about the mode — words ${AUTOPILOT_WORDS.join(', ')} with an on verb (${AUTOPILOT_ON_VERBS.join(', ')}) or an off verb (${AUTOPILOT_OFF_VERBS.join(', ')}), e.g. «자율주행 시작», «오토파일럿 켜줘», «autopilot on», «자율주행 꺼», «오토파일럿 끝». No confirmation when the word and the verb are present; ask only if genuinely ambiguous. «다시 자율주행» = on:true (resume) · «이제부터 내가 운전하겠다» = on:true + hold:true. A new, different-direction or urgent request never pauses or stops autopilot — handle it while staying ON; only the person's new direction replaces the goal via on:true + goal (ordinary mail / requests are never a goal — an autonomous turn's goal is refused). When the open first-class goal (crown / person directive) is done, call goal_done:true. While ON, record each in-policy decision you make yourself with decided:{kind, criterion}.`,
      parameters: {
        type: 'object',
        properties: {
          on: { type: 'boolean', description: 'true = start / resume · false = stop' },
          goal: { type: 'string', description: 'what to drive toward — ONLY when the person explicitly says to set it as a goal (e.g. «이걸 골로 잡아», «make this a goal»). A question, a status ask, a request, an ack or a command is NOT a goal even with a deadline — answer or do it in this turn' },
          explicit_ask: { type: 'string', description: 'required with goal — the person\'s own words from this turn that ask to set the goal, quoted verbatim (checked against the turn; refused when absent or not found)' },
          done_criterion: { type: 'string', description: 'required with goal — one judgment line that says when the goal is done' },
          kind: { type: 'string', enum: ['task', 'autopilot'], description: 'task (default) = a multi-step deliverable — shown as a pin above the input, NOT the autopilot goal; needs done_criterion + deadline; at most 3 pins. autopilot = only the seat\'s standing/version goal or a crown P0 direction — replaces the 🚗 AUTO goal' },
          deadline: { type: 'string', description: 'required with any goal — «HH:MM» or ISO time it is due (one nudge at the deadline, expired 30 min after). Without goal = extend the open goal\'s deadline' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2'], description: 'with a task goal — default P1; beyond 3 pins the lowest priority (oldest) is evicted' },
          expected_turns: { type: 'number', description: 'required with goal (or expected_minutes) — your size estimate; a goal must be ≥ 3 turns or > 15 minutes of work, otherwise just do it in this turn' },
          expected_minutes: { type: 'number', description: 'alternative size estimate in minutes (> 15)' },
          done_check: { type: 'string', description: 'optional machine check that clears the goal by itself: file:<path> (exists) · file-updated:<path> (changed after the goal was set) · pr:<n> (merged) · mail:<SEAT> (a mail from that seat arrived) · checklist:<version>:<status>>=<n> · checklist:<version>:<id>=<status>' },
          outcome: { type: 'string', enum: ['done', 'partial', 'dropped'], description: 'with goal_done — done (default) · partial (closing with a partial result) · dropped (needs reason)' },
          reason: { type: 'string', description: 'with goal_done outcome:"dropped" (required) or "partial" — one line' },
          until: { type: 'string', description: '«HH:MM» or ISO time to turn itself off (optional)' },
          hold: { type: 'boolean', description: 'with on:true — the person keeps driving: stay paused until resumed' },
          goal_done: { type: 'boolean', description: 'true = a goal is done — with kind:"task" (+ goal text) it unpins that task pin; otherwise it closes the open first-class goal (crown / person directive) and the standing goal returns' },
          decided: { type: 'object', properties: { kind: { type: 'string' }, criterion: { type: 'string' } }, required: ['kind', 'criterion'], description: 'log one autonomous decision (no state change)' },
        },
        additionalProperties: false,
      },
    },
    {
      name: AUTOPILOT_GOAL_SET_TOOL_NAME,
      description: 'Add or edit one of the PERSON\'s goals (only when the person states or changes a goal). level: short = release schedule · mid = milestone such as a demo · long = month/quarter plan. due = ISO time. To edit, pass id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' }, level: { type: 'string', enum: ['short', 'mid', 'long'] }, title: { type: 'string' },
          due: { type: 'string' }, status: { type: 'string', enum: ['active', 'done', 'dropped'] }, measure: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      name: AUTOPILOT_GOAL_REMOVE_TOOL_NAME,
      description: 'Remove one of the person\'s goals by id (only when the person asks).',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    },
  ];
}

export interface AutopilotToolDeps {
  cwd: string;
  file?: string;
  now?: () => number;
  sessionId?: string;
  raiseDecision?: Parameters<typeof createAutopilot>[0]['raiseDecision'];
  proposeGoal?: (input: GoalSetInput) => void;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export async function dispatchAutopilotTool(name: string, args: Record<string, unknown>, deps: AutopilotToolDeps): Promise<unknown> {
  const file = deps.file ?? autopilotStateFile(deps.cwd);
  if (name === AUTOPILOT_TOOL_NAME) {
    const pilot = createAutopilot({ file, ...(deps.now ? { now: deps.now } : {}), ...(deps.log ? { log: deps.log } : {}),
      raiseDecision: deps.raiseDecision ?? raiseAutopilotDecision, ...(deps.sessionId ? { sessionId: deps.sessionId } : {}) });
    const req: AutopilotSetRequest = {
      ...(typeof args.on === 'boolean' ? { on: args.on } : {}),
      ...(typeof args.goal === 'string' ? { goal: args.goal } : {}),
      ...(typeof args.done_criterion === 'string' ? { doneCriterion: args.done_criterion } : {}),
      ...(typeof args.until === 'string' ? { until: args.until } : {}),
      ...(args.kind === 'task' || args.kind === 'autopilot' ? { kind: args.kind } : {}),
      ...(typeof args.deadline === 'string' ? { deadline: args.deadline } : {}),
      ...(typeof args.priority === 'string' || typeof args.priority === 'number' ? { priority: args.priority } : {}),
      ...(args.hold === true ? { hold: true } : {}),
      ...(args.goal_done === true ? { goalDone: true } : {}),
      ...(typeof args.expected_turns === 'number' ? { expectedTurns: args.expected_turns } : {}),
      ...(typeof args.expected_minutes === 'number' ? { expectedMinutes: args.expected_minutes } : {}),
      ...(args.done_check !== undefined ? { doneCheck: args.done_check } : {}),
      ...(args.outcome === 'done' || args.outcome === 'partial' || args.outcome === 'dropped' ? { outcome: args.outcome } : {}),
      ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
      ...(typeof args.explicit_ask === 'string' ? { explicitAsk: args.explicit_ask } : {}),
      ...(args.decided && typeof args.decided === 'object' ? { decided: args.decided as { kind: string; criterion: string } } : {}),
    };
    const result = pilot.set(req, 'tool');
    return result.ok ? { ok: true, status: result.text } : { error: result.text };
  }
  // Goal writes: only a person's turn writes (the TUI marks the running turn's origin in the state file).
  const by = readAutopilotState(file)?.turnOrigin === 'auto' ? 'autopilot' : 'person';
  const goalsFile = autopilotGoalsFile(file);
  if (name === AUTOPILOT_GOAL_SET_TOOL_NAME) {
    const input: GoalSetInput = Object.fromEntries(['id', 'level', 'title', 'due', 'status', 'measure']
      .filter((k) => typeof args[k] === 'string').map((k) => [k, args[k] as string]));
    const result = setGoal(goalsFile, input, by, deps.proposeGoal ?? ((i) => { raiseGoalProposalCard(i, deps.sessionId); }));
    return result.ok ? { ok: true, status: result.text } : { error: result.text, ...('proposal' in result && result.proposal ? { proposal: true } : {}) };
  }
  if (name === AUTOPILOT_GOAL_REMOVE_TOOL_NAME) {
    const result = removeGoal(goalsFile, String(args.id ?? ''), by);
    return result.ok ? { ok: true, status: result.text } : { error: result.text };
  }
  return { error: `unknown autopilot tool ${name}` };
}
