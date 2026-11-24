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
export const AUTOPILOT_PROMPT_LINE = `자율주행 모드: 사람의 말이 ${AUTOPILOT_WORDS.map((w) => `«${w}»`).join('·')} 모드를 켜거나(${AUTOPILOT_ON_VERBS.join('·')}) 끄는(${AUTOPILOT_OFF_VERBS.join('·')}) 뜻이면 — 낱말과 켜기/끄기 동사가 있으면 확인 없이 — 바로 ${AUTOPILOT_TOOL_NAME}({on:true, goal?} | {on:false})를 부른다. «다시 자율주행»=on:true · «계속 내가 운전»=on:true,hold:true. 사람이 목표(단기 발행 일정·중기 데모 같은 마일스톤·장기 월/분기)를 정하거나 고치거나 지우면 ${AUTOPILOT_GOAL_SET_TOOL_NAME}/${AUTOPILOT_GOAL_REMOVE_TOOL_NAME} 을 부른다 — 목표를 스스로 만들지 않는다.`;

export function buildAutopilotTools(): LLMToolSpec[] {
  return [
    {
      name: AUTOPILOT_TOOL_NAME,
      description: `Turn this session's autopilot (자율주행) mode on or off. Call it whenever the person's message is about the mode — words ${AUTOPILOT_WORDS.join(', ')} with an on verb (${AUTOPILOT_ON_VERBS.join(', ')}) or an off verb (${AUTOPILOT_OFF_VERBS.join(', ')}), e.g. «자율주행 시작», «오토파일럿 켜줘», «autopilot on», «자율주행 꺼», «오토파일럿 끝». No confirmation when the word and the verb are present; ask only if genuinely ambiguous. «다시 자율주행» = on:true (resume) · «계속 내가 운전» = on:true + hold:true. While ON, record each in-policy decision you make yourself with decided:{kind, criterion}.`,
      parameters: {
        type: 'object',
        properties: {
          on: { type: 'boolean', description: 'true = start / resume · false = stop' },
          goal: { type: 'string', description: 'what to drive toward (optional)' },
          until: { type: 'string', description: '«HH:MM» or ISO time to turn itself off (optional)' },
          hold: { type: 'boolean', description: 'with on:true — the person keeps driving: stay paused until resumed' },
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
      ...(typeof args.until === 'string' ? { until: args.until } : {}),
      ...(args.hold === true ? { hold: true } : {}),
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
