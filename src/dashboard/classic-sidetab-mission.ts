import type { LLMToolSpec } from '../llm/tool-spec.js';

import { debug } from '../debug/log.js';
import { isClassicMissionId, redactMissionResultPath } from './mission-cli-consumer.js';

export const CLASSIC_SIDETAB_MISSION_TOOL_NAME = 'RunSidetabMission';
export const CLASSIC_SIDETAB_MISSION_CANCEL_TOOL_NAME = 'CancelSidetabMission';
export const CLASSIC_SIDETAB_HAND_REPLY_TOOL_NAME = 'HandReply';
const AGENT_TOOL_NAME = 'Agent';

export interface ClassicSidetabHandReplyInput {
  missionId: string;
  kind: 'answer' | 'correct';
  text: string;
  actor: 'agent' | 'human';
  replyTo: number;
  runId?: string;
  scope?: string;
  stop?: boolean;
  priority?: string;
}

export interface ClassicSidetabMissionResult {
  ok: boolean;
  status?: 'running' | 'completed' | 'cancelled' | 'failed';
  path?: string;
  content?: string;
  error?: string;
  /** PTY process status when it exited before the result was finalized; null means signal/unknown. */
  exitCode?: number | null;
  interactionId?: string;
  /** Final raw child PTY screen, retained in the parent comparison recording. */
  finalScreen?: string;
  /** Child PTY exit status, if the session ended while the mission was observed. */
  exitObservation?: 'natural-exit' | 'cleanup-exit' | 'cleanup-unobserved';
  /** Whether the separate completion marker was observed after the result file. */
  completionMarker?: boolean;
  /** First child PTY frame, retained to explain startup menus and input interception. */
  initialScreen?: string;
  failureStage?: string;
  failureScreen?: string;
}
export interface ClassicSidetabMissionToolResult {
  status: 'running' | 'done' | 'error' | 'aborted';
  body: string;
  artifacts: string[];
  id: string | null;
}

export interface ClassicSidetabMissionTool {
  spec: LLMToolSpec;
  dispatch(args: unknown, context?: ClassicSidetabMissionDispatchContext): Promise<ClassicSidetabMissionToolResult>;
}

export interface ClassicSidetabMissionPairResult {
  pairId: string;
  codex: ClassicSidetabMissionResult;
  claude: ClassicSidetabMissionResult;
}

export type ClassicSidetabMissionAgent = 'codex' | 'claude' | 'grok';
export interface ClassicSidetabMissionTrioResult {
  trioId: string;
  members: Record<ClassicSidetabMissionAgent, ClassicSidetabMissionResult>;
  grokFallback?: string;
}

export interface ClassicSidetabMissionPairSessionRegistry {
  register(missionIds: readonly string[], sessionIds: readonly string[]): void;
  cancel(missionId: string, hasSession: (sessionId: string) => boolean, killSession: (sessionId: string) => void): boolean | undefined;
  clear(missionIds: readonly string[]): void;
}

/** Map either public mission ID to the full visible PTY pair until completion/cancellation. */
export function createClassicSidetabMissionPairSessionRegistry(): ClassicSidetabMissionPairSessionRegistry {
  const pairs = new Map<string, readonly string[]>();
  return {
    register(missionIds, sessionIds) {
      const pair = [...sessionIds];
      for (const missionId of missionIds) pairs.set(missionId, pair);
    },
    cancel(missionId, hasSession, killSession) {
      const pair = pairs.get(missionId);
      if (!pair) return undefined;
      let cancelled = false;
      for (const sessionId of pair) {
        if (!hasSession(sessionId)) continue;
        killSession(sessionId);
        cancelled = true;
      }
      for (const [id, mappedPair] of pairs) if (mappedPair === pair) pairs.delete(id);
      return cancelled;
    },
    clear(missionIds) {
      for (const missionId of missionIds) pairs.delete(missionId);
    },
  };
}

export interface ClassicSidetabMissionIntegration {
  getTools(tools: readonly LLMToolSpec[]): LLMToolSpec[];
  dispatchTool(name: string, args: unknown, context?: ClassicSidetabMissionDispatchContext): Promise<ClassicSidetabMissionToolResult> | undefined;
}

export interface ClassicSidetabMissionDispatchContext {
  callId?: string;
  parentSessionId?: string;
  linearIssueId?: string;
}

/** A classic ACP-only tool. Result paths remain internal; the final mission text returns to chat. */
export function createClassicSidetabMissionTool(
  runMission: (agent: 'codex' | 'claude', mission: string, context?: ClassicSidetabMissionDispatchContext) => Promise<ClassicSidetabMissionResult>,
  runMissionPair?: (agent: 'codex' | 'claude', mission: string, parallelMission: string, context?: ClassicSidetabMissionDispatchContext) => Promise<ClassicSidetabMissionPairResult>,
  runMissionTrio?: (mission: string, context?: ClassicSidetabMissionDispatchContext) => Promise<ClassicSidetabMissionTrioResult>,
): ClassicSidetabMissionTool {
  return {
    spec: {
      name: CLASSIC_SIDETAB_MISSION_TOOL_NAME,
      description: 'Run a stateless coding mission with the selected sidetab agent. For a two-hand Codex/Claude pair, keep the original parent request in mission and provide decomposition.status=ready plus separate codex and claude briefs, each with distinct scope, deliverables, and dependencies. Split into non-overlapping work; dependencies must already be satisfied and neither child may depend on the other child output. If the work cannot run independently, set status=cannot-split and give a reason. Both child briefs are launched under this tool call ID. Set withGrok=true to send the exact same mission to Codex, Claude Code, and Grok concurrently; omit both parallelMission and linearIssueId in this mode. For any parallel mission, omit linearIssueId because Linear progress sync only supports one sidetab mission. After a Codex + Claude pair completes, combine both complementary results rather than discarding either hand. For withGrok=true, compare candidates, adopt the strongest answer, and explain the choice. If Grok login or startup is unavailable, continue with Codex and Claude and disclose the fallback. For parallel runs, either listed mission ID cancels all members. Return a structured result with status, body, artifacts, and id. Parent-turn cancellation does not cancel missions; explicit mission-ID cancellation or the one-hour safety timeout can stop them.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: ['codex', 'claude'], description: 'Visible coding agent to run.' },
          mission: { type: 'string', minLength: 1, description: 'Original parent request. For a Codex + Claude decomposition, split it into the separate briefs in decomposition.' },
          // Some strict tool callers materialize every optional property and
          // use empty sentinels instead of omitting it. Accept those at the
          // boundary; dispatch normalizes them before validating combinations.
          linearIssueId: { anyOf: [{ type: 'string' }, { type: 'null' }, { type: 'array', items: { type: 'string' }, maxItems: 0 }], description: 'Optional Linear child issue ID for a single sidetab mission only; omit or send an empty value when parallelMission or withGrok is used.' },
          parallelMission: { anyOf: [{ type: 'string' }, { type: 'null' }, { type: 'array', items: { type: 'string' }, maxItems: 0 }], description: 'Backward-compatible second prompt for an existing two-hand pair. New parent-request splits should use structured decomposition.' },
          decomposition: { type: 'object', description: 'Required for a new parent-request split. Legacy parallelMission calls remain supported. The parent decomposes mission into non-overlapping Codex and Claude briefs; mark cannot-split and explain if parallel work is not safe.', properties: { status: { type: 'string', enum: ['ready', 'cannot-split'] }, reason: { type: 'string', description: 'Required when status=cannot-split.' }, codex: { type: 'object', properties: { scope: { type: 'string' }, deliverables: { type: 'string' }, dependsOn: { type: 'string', description: 'Prerequisite that is already satisfied, or state none. If this depends on the other child output, mark cannot-split instead.' } }, required: ['scope', 'deliverables', 'dependsOn'], additionalProperties: false }, claude: { type: 'object', properties: { scope: { type: 'string' }, deliverables: { type: 'string' }, dependsOn: { type: 'string', description: 'Prerequisite that is already satisfied, or state none. If this depends on the other child output, mark cannot-split instead.' } }, required: ['scope', 'deliverables', 'dependsOn'], additionalProperties: false } }, required: ['status'], additionalProperties: false },
          withGrok: { anyOf: [{ type: 'boolean' }, { type: 'null' }, { type: 'string', enum: [''] }, { type: 'array', items: { type: 'string' }, maxItems: 0 }], description: 'Run this exact mission concurrently with Codex, Claude Code, and Grok, then compare and adopt the strongest result; omit parallelMission and linearIssueId. Grok login failure degrades to Codex + Claude.' },
        },
        required: ['agent', 'mission'],
        additionalProperties: false,
      },
    },
    async dispatch(args, context) {
      const output = (status: ClassicSidetabMissionToolResult['status'], body: string, id: string | null = null): ClassicSidetabMissionToolResult => ({
        status,
        body,
        artifacts: [],
        id,
      });
      if (!args || typeof args !== 'object' || Array.isArray(args)) return output('error', 'arguments must be an object');
      const input = args as Record<string, unknown>;
      if (Object.keys(input).some(key => key !== 'agent' && key !== 'mission' && key !== 'parallelMission' && key !== 'decomposition' && key !== 'withGrok' && key !== 'linearIssueId')) {
        return output('error', 'arguments contain unsupported fields');
      }
      const normalizeOptional = (value: unknown): unknown => {
        if (value === undefined || value === null) return undefined;
        if (typeof value === 'string') return value.trim() ? value.trim() : undefined;
        if (Array.isArray(value) && value.length === 0) return undefined;
        return value;
      };
      const agent = input.agent;
      const mission = typeof input.mission === 'string' ? input.mission.trim() : '';
      const normalizedParallelMission = normalizeOptional(input.parallelMission);
      const normalizedLinearIssueId = normalizeOptional(input.linearIssueId);
      const normalizedWithGrok = normalizeOptional(input.withGrok);
      const requestedParallelMission = typeof normalizedParallelMission === 'string' ? normalizedParallelMission : '';
      const decomposition = normalizeOptional(input.decomposition);
      const linearIssueId = typeof normalizedLinearIssueId === 'string' ? normalizedLinearIssueId : '';
      const withGrok = normalizedWithGrok === true;
      // Some parent tool callers duplicate the same prompt into both fields.
      // Treat that redundant pair field as omitted in trio mode; a distinct
      // second prompt remains an invalid combination below.
      const parallelMission = withGrok && requestedParallelMission === mission ? '' : requestedParallelMission;
      if (agent !== 'codex' && agent !== 'claude') return output('error', 'agent must be codex or claude');
      if (!mission) return output('error', 'mission text is required');
      if (normalizedParallelMission !== undefined && typeof normalizedParallelMission !== 'string') return output('error', 'parallelMission must contain prompt text');
      if (normalizedLinearIssueId !== undefined && typeof normalizedLinearIssueId !== 'string') return output('error', 'linearIssueId must be omitted or contain a non-empty ID');
      if (normalizedWithGrok !== undefined && typeof normalizedWithGrok !== 'boolean') return output('error', 'withGrok must be a boolean');
      if (decomposition !== undefined && (!decomposition || typeof decomposition !== 'object' || Array.isArray(decomposition))) return output('error', 'decomposition must describe a pair split');
      const split = decomposition as Record<string, unknown> | undefined;
      if (withGrok && (parallelMission || split)) return output('error', 'withGrok compares the same mission; omit parallelMission');
      if (split && Object.keys(split).some(key => !['status', 'reason', 'codex', 'claude'].includes(key))) return output('error', 'decomposition contains unsupported fields');
      if (split && split.status !== 'ready' && split.status !== 'cannot-split') return output('error', 'decomposition.status must be ready or cannot-split');
      if (split?.status === 'cannot-split') {
        const reason = typeof split.reason === 'string' ? split.reason.trim() : '';
        return reason ? output('error', `Pair dispatch held: ${reason}`) : output('error', 'Pair dispatch held: explain why the parent request cannot be split');
      }
      let pairBriefs: { codex: string; claude: string } | undefined;
      if (parallelMission && !split) {
        const normalizeBrief = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
        if (normalizeBrief(parallelMission) === normalizeBrief(mission)) {
          return output('error', 'Pair missions must be distinct child briefs; split the parent task before dispatch');
        }
        pairBriefs = agent === 'codex'
          ? { codex: mission, claude: parallelMission }
          : { codex: parallelMission, claude: mission };
      }
      if (split?.status === 'ready') {
        const brief = (value: unknown): { scope: string; deliverables: string; dependsOn: string } | undefined => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
          const fields = value as Record<string, unknown>;
          if (Object.keys(fields).some(key => !['scope', 'deliverables', 'dependsOn'].includes(key))) return undefined;
          const scope = typeof fields.scope === 'string' ? fields.scope.trim() : '';
          const deliverables = typeof fields.deliverables === 'string' ? fields.deliverables.trim() : '';
          const dependsOn = typeof fields.dependsOn === 'string' ? fields.dependsOn.trim() : '';
          return scope && deliverables && dependsOn ? { scope, deliverables, dependsOn } : undefined;
        };
        const codex = brief(split.codex);
        const claude = brief(split.claude);
        if (!codex || !claude) return output('error', 'Pair dispatch held: each child needs scope, deliverables, and dependencies');
        const normalized = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
        if (normalized(codex.scope) === normalized(claude.scope) || normalized(codex.deliverables) === normalized(claude.deliverables)) {
          return output('error', 'Pair dispatch held: Codex and Claude scopes and deliverables must be distinct');
        }
        const childPrompt = (hand: 'Codex' | 'Claude', child: typeof codex) => [
          `Parent request: ${mission}`,
          `Assigned hand: ${hand}`,
          `Scope: ${child.scope}`,
          `Deliverables: ${child.deliverables}`,
          `Dependencies: ${child.dependsOn}`,
          "Work only within this brief. Do not duplicate the other hand's scope.",
        ].join('\n');
        pairBriefs = { codex: childPrompt('Codex', codex), claude: childPrompt('Claude', claude) };
      }
      if (parallelMission && parallelMission === mission) {
        return output('error', 'Pair missions must be distinct child briefs; split the parent task before dispatch');
      }
      // Non-empty IDs remain single-agent only because parallel runs do not
      // support Linear progress sync.
      debug.log('agent-mission.sidetab', 'guard-input', {
        hasLinearIssueId: Boolean(linearIssueId),
        parallelMission: Boolean(pairBriefs),
        source: normalizedLinearIssueId !== undefined
          ? (context?.linearIssueId ? 'tool-input+linear-dispatch-context' : 'tool-input')
          : context?.linearIssueId ? 'dispatch-context' : 'none',
      });
      const parallelHasLinearIssueId = Boolean(pairBriefs && (linearIssueId || context?.linearIssueId));
      if (parallelHasLinearIssueId) {
        debug.log('agent-mission.sidetab', 'linear-sync-skipped-for-parallel', {
          source: linearIssueId && context?.linearIssueId ? 'tool-input+dispatch-context' : linearIssueId ? 'tool-input' : 'dispatch-context',
          reason: 'Linear progress sync is only supported for a single sidetab mission',
        }, { level: 'warn' });
      }
      if (withGrok && (parallelMission || pairBriefs)) return output('error', 'withGrok compares the same mission; omit parallelMission');
      if (withGrok && !runMissionTrio) return output('error', 'Codex + Claude + Grok comparison is unavailable in this runtime');
      if (withGrok && runMissionTrio) {
        try {
          const trio = await runMissionTrio(mission, linearIssueId ? { ...context, linearIssueId } : context);
          const ids = Object.values(trio.members).map((member) => member.interactionId).filter((id): id is string => Boolean(id));
          const grok = trio.members.grok;
          const disclosure = trio.grokFallback ?? (!grok.ok ? grok.error : undefined);
          return output('running', `Three-hand comparison started (${trio.trioId}; mission IDs: ${ids.join(', ') || 'unavailable'})${disclosure ? ` · Grok fallback: ${disclosure}` : ''}${linearIssueId ? ' · Linked Linear progress is not synchronized by three-hand missions.' : ''}. One combined completion notification will compare the results and show the adopted answer.`, trio.members.codex.interactionId ?? trio.members.claude.interactionId ?? trio.trioId);
        } catch {
          return output('error', 'Codex + Claude + Grok missions failed before the comparison could start');
        }
      }
      if (pairBriefs && !runMissionPair) return output('error', 'parallel Codex/Claude missions are unavailable in this runtime');
      if (pairBriefs && runMissionPair) {
        try {
          const pairContext = context?.linearIssueId
            ? { callId: context.callId, parentSessionId: context.parentSessionId }
            : context;
          const pair = await runMissionPair('codex', pairBriefs.codex, pairBriefs.claude, pairContext);
          const codex = pair.codex;
          const claude = pair.claude;
          const format = (name: string, result: ClassicSidetabMissionResult): string => {
            if (result.status === 'running') return `${name}: still running (${result.interactionId ?? 'no mission ID'})`;
            if (!result.ok) return `${name}: ${result.status ?? 'failed'}; no answer returned`;
            const content = result.content?.trim();
            return content ? `${name} answer:\n${redactMissionResultPath(content, result.path)}` : `${name}: completed without an answer`;
          };
          const bothDone = codex.status !== 'running' && claude.status !== 'running';
          const bothOk = codex.ok && claude.ok && Boolean(codex.content?.trim()) && Boolean(claude.content?.trim());
          const ids = [codex.interactionId, claude.interactionId].filter((id): id is string => Boolean(id));
          return output(bothDone && bothOk ? 'done' : bothDone ? 'error' : 'running',
            `Concurrent Codex + Claude mission pair (${pair.pairId}; mission IDs: ${ids.join(', ') || 'unavailable'})\n\n${format('Codex', codex)}\n\n${format('Claude', claude)}`,
            codex.interactionId ?? claude.interactionId ?? null);
        } catch {
          return output('error', 'Concurrent Codex/Claude missions failed before both results were available');
        }
      }
      let result: ClassicSidetabMissionResult;
      try {
        result = await runMission(agent, mission, linearIssueId ? { ...context, linearIssueId } : context);
      } catch {
        return output('error', 'Sidetab mission failed before a result was available');
      }
      if (result.status === 'running') {
        if (!result.interactionId) return output('error', 'Sidetab mission started without an interaction ID');
        const body = result.content?.trim() || 'Independent sidetab job started; this conversation can continue.';
        return output('running', redactMissionResultPath(body, result.path), result.interactionId);
      }
      // The dashboard production seam returns running; this terminal branch serves embedders and tests.
      if (!result.ok) {
        return output(result.status === 'cancelled' ? 'aborted' : 'error', 'Sidetab mission failed; no result was returned', result.interactionId ?? null);
      }
      const content = result.content?.trim();
      if (!content) return output('error', 'Sidetab mission completed without an answer', result.interactionId ?? null);
      if (!result.path) return output('error', 'Sidetab mission completed without an internal result reference', result.interactionId ?? null);
      const userSafeContent = redactMissionResultPath(content, result.path);
      if (!result.interactionId) return output('error', 'Sidetab mission completed without an interaction ID');
      return output('done', userSafeContent, result.interactionId);
    },
  };
}

/** Keep classic ACP tool catalog and dispatch wired through the same production seam. */
export function createClassicSidetabMissionIntegration(
  runMission: (agent: 'codex' | 'claude', mission: string, context?: ClassicSidetabMissionDispatchContext) => Promise<ClassicSidetabMissionResult>,
  cancelMission?: (interactionId: string) => Promise<boolean>,
  runMissionPair?: (agent: 'codex' | 'claude', mission: string, parallelMission: string, context?: ClassicSidetabMissionDispatchContext) => Promise<ClassicSidetabMissionPairResult>,
  handReply?: (input: ClassicSidetabHandReplyInput) => Promise<{ ok: boolean; body: string }>,
  runMissionTrio?: (mission: string, context?: ClassicSidetabMissionDispatchContext) => Promise<ClassicSidetabMissionTrioResult>,
): ClassicSidetabMissionIntegration {
  const tool = createClassicSidetabMissionTool(runMission, runMissionPair, runMissionTrio);
  const dispatchAgentHand = async (args: unknown, context?: ClassicSidetabMissionDispatchContext): Promise<ClassicSidetabMissionToolResult> => {
    const output = (status: ClassicSidetabMissionToolResult['status'], body: string, id: string | null = null): ClassicSidetabMissionToolResult => ({
      status,
      body,
      artifacts: [],
      id,
    });
    if (!args || typeof args !== 'object' || Array.isArray(args)) return output('error', 'arguments must be an object');
    const input = args as Record<string, unknown>;
    const hand = input.hand;
    if (hand !== 'codex' && hand !== 'claude') return output('error', 'hand must be internal, codex, or claude');
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) return output('error', 'prompt is required');
    try {
      const result = await runMission(hand, prompt, context);
      if (result.status === 'running') {
        if (!result.interactionId) return output('error', 'Sidetab mission started without an interaction ID');
        const body = result.content?.trim() || 'Independent sidetab agent started; this conversation can continue.';
        return output('running', redactMissionResultPath(body, result.path), result.interactionId);
      }
      if (!result.ok) return output(result.status === 'cancelled' ? 'aborted' : 'error', 'Sidetab mission failed; no result was returned', result.interactionId ?? null);
      const body = result.content?.trim();
      if (!body) return output('error', 'Sidetab mission completed without an answer', result.interactionId ?? null);
      if (!result.interactionId) return output('error', 'Sidetab mission completed without an interaction ID');
      return output('done', redactMissionResultPath(body, result.path), result.interactionId);
    } catch {
      return output('error', 'Sidetab mission failed before a result was available');
    }
  };
  const withHandOption = (spec: LLMToolSpec): LLMToolSpec => {
    const parameters = spec.parameters;
    const properties = parameters.properties && typeof parameters.properties === 'object' && !Array.isArray(parameters.properties)
      ? parameters.properties as Record<string, unknown>
      : {};
    return {
      ...spec,
      description: `${spec.description}\nOptional hand: internal (default), codex, or claude. External hands start a visible sidetab agent and return immediately; completion arrives as a task notification. Parent-turn cancellation does not cancel the mission; explicit mission-ID cancellation or the one-hour safety timeout can stop it.`,
      parameters: {
        ...parameters,
        properties: {
          ...properties,
          hand: { type: 'string', enum: ['internal', 'codex', 'claude'], description: 'Execution hand. Defaults to the built-in internal sub-agent.' },
        },
      },
    };
  };
  return {
    getTools: (tools) => [...tools.map(spec => spec.name === AGENT_TOOL_NAME ? withHandOption(spec) : spec), tool.spec, ...(handReply ? [{
      name: CLASSIC_SIDETAB_HAND_REPLY_TOOL_NAME,
      description: 'Answer or correct a question from a running visible sidetab mission. Answers are recorded in the mission ledger for the matching ask waiter. Corrections require child runId, actor=agent, scope, stop, and priority, then are delivered to the mapped PTY through the input arbiter.',
      parameters: {
        type: 'object',
        properties: {
          missionId: { type: 'string', format: 'uuid' }, kind: { type: 'string', enum: ['answer', 'correct'] },
          text: { type: 'string', minLength: 1 }, actor: { type: 'string', enum: ['agent', 'human'] },
          replyTo: { type: 'integer', minimum: 1 }, runId: { type: 'string', description: 'Required for kind=correct; omitted for kind=answer.' }, scope: { type: 'string' }, stop: { type: 'boolean' }, priority: { type: 'string' },
        },
        required: ['missionId', 'kind', 'text', 'actor', 'replyTo'], additionalProperties: false,
      },
    } satisfies LLMToolSpec] : []), ...(cancelMission ? [{
      name: CLASSIC_SIDETAB_MISSION_CANCEL_TOOL_NAME,
      description: 'Explicitly cancel a running sidetab mission. Cancelling the parent conversation turn does not cancel its detached mission.',
      parameters: {
        type: 'object',
        properties: { missionId: { type: 'string', format: 'uuid', description: 'The mission ID returned by RunSidetabMission.' } },
        required: ['missionId'],
        additionalProperties: false,
      },
    } satisfies LLMToolSpec] : [])],
    dispatchTool: (name, args, context) => {
      if (name === CLASSIC_SIDETAB_MISSION_TOOL_NAME) return tool.dispatch(args, context);
      if (name === CLASSIC_SIDETAB_HAND_REPLY_TOOL_NAME && handReply) {
        return (async () => {
          if (!args || typeof args !== 'object' || Array.isArray(args)) return { status: 'error', body: 'arguments must be an object', artifacts: [], id: null };
          const input = args as Record<string, unknown>;
          if (Object.keys(input).some((key) => !['missionId', 'kind', 'text', 'actor', 'replyTo', 'runId', 'scope', 'stop', 'priority'].includes(key))) return { status: 'error', body: 'arguments contain unsupported fields', artifacts: [], id: null };
          if (typeof input.missionId !== 'string' || !isClassicMissionId(input.missionId) || (input.kind !== 'answer' && input.kind !== 'correct') || typeof input.text !== 'string' || !input.text.trim() || (input.actor !== 'agent' && input.actor !== 'human') || typeof input.replyTo !== 'number' || !Number.isInteger(input.replyTo) || input.replyTo < 1) return { status: 'error', body: 'missionId, kind, text, actor, or replyTo is invalid', artifacts: [], id: null };
          if (input.runId !== undefined && typeof input.runId !== 'string') return { status: 'error', body: 'runId must be a string', artifacts: [], id: input.missionId };
          if (input.kind === 'correct' && (typeof input.scope !== 'string' || typeof input.stop !== 'boolean' || typeof input.priority !== 'string')) return { status: 'error', body: 'correct requires scope, stop, and priority', artifacts: [], id: input.missionId };
          const result = await handReply({ missionId: input.missionId, kind: input.kind, text: input.text, actor: input.actor, replyTo: input.replyTo, ...(typeof input.runId === 'string' ? { runId: input.runId } : {}), ...(typeof input.scope === 'string' ? { scope: input.scope } : {}), ...(typeof input.stop === 'boolean' ? { stop: input.stop } : {}), ...(typeof input.priority === 'string' ? { priority: input.priority } : {}) });
          return { status: result.ok ? 'done' : 'error', body: result.body, artifacts: [], id: input.missionId };
        })();
      }
      if (name === AGENT_TOOL_NAME) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) return dispatchAgentHand(args, context);
        const hand = (args as Record<string, unknown>).hand;
        if (hand === undefined || hand === 'internal') return undefined;
        return dispatchAgentHand(args, context);
      }
      if (name !== CLASSIC_SIDETAB_MISSION_CANCEL_TOOL_NAME || !cancelMission) return undefined;
      return (async () => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) return { status: 'error', body: 'arguments must be an object', artifacts: [], id: null };
        const input = args as Record<string, unknown>;
        if (Object.keys(input).some(key => key !== 'missionId')) return { status: 'error', body: 'arguments contain unsupported fields', artifacts: [], id: null };
        const missionId = typeof input.missionId === 'string' ? input.missionId : '';
        if (!isClassicMissionId(missionId)) {
          return { status: 'error', body: 'missionId must be a UUID', artifacts: [], id: null };
        }
        try {
          const cancelled = await cancelMission(missionId);
          return { status: cancelled ? 'done' : 'error', body: cancelled ? 'Sidetab mission cancellation requested.' : 'Sidetab mission could not be cancelled.', artifacts: [], id: missionId };
        } catch {
          return { status: 'error', body: 'Sidetab mission could not be cancelled.', artifacts: [], id: missionId };
        }
      })();
    },
  };
}
