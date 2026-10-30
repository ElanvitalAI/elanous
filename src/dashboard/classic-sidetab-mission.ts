import type { LLMToolSpec } from '../llm.js';
import { isClassicMissionId, redactMissionResultPath } from './mission-cli-consumer.js';

export const CLASSIC_SIDETAB_MISSION_TOOL_NAME = 'RunSidetabMission';
export const CLASSIC_SIDETAB_MISSION_CANCEL_TOOL_NAME = 'CancelSidetabMission';
const AGENT_TOOL_NAME = 'Agent';

export interface ClassicSidetabMissionResult {
  ok: boolean;
  status?: 'running' | 'completed' | 'cancelled' | 'failed';
  path?: string;
  content?: string;
  error?: string;
  interactionId?: string;
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

export interface ClassicSidetabMissionIntegration {
  getTools(tools: readonly LLMToolSpec[]): LLMToolSpec[];
  dispatchTool(name: string, args: unknown, context?: ClassicSidetabMissionDispatchContext): Promise<ClassicSidetabMissionToolResult> | undefined;
}

export interface ClassicSidetabMissionDispatchContext {
  callId?: string;
}

/** A classic ACP-only tool. Result paths remain internal; the final mission text returns to chat. */
export function createClassicSidetabMissionTool(
  runMission: (agent: 'codex' | 'claude', mission: string, context?: ClassicSidetabMissionDispatchContext) => Promise<ClassicSidetabMissionResult>,
): ClassicSidetabMissionTool {
  return {
    spec: {
      name: CLASSIC_SIDETAB_MISSION_TOOL_NAME,
      description: 'Run a stateless coding mission with the selected sidetab agent. Return a structured result with status, body, artifacts, and id; the parent chat uses it to continue the original task. Parent-turn cancellation does not cancel the mission; explicit mission-ID cancellation or the one-hour safety timeout can stop it.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: ['codex', 'claude'], description: 'Visible coding agent to run.' },
          mission: { type: 'string', minLength: 1, description: 'The work to perform.' },
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
      if (Object.keys(input).some(key => key !== 'agent' && key !== 'mission')) {
        return output('error', 'arguments contain unsupported fields');
      }
      const agent = input.agent;
      const mission = typeof input.mission === 'string' ? input.mission.trim() : '';
      if (agent !== 'codex' && agent !== 'claude') return output('error', 'agent must be codex or claude');
      if (!mission) return output('error', 'mission text is required');
      let result: ClassicSidetabMissionResult;
      try {
        result = await runMission(agent, mission, context);
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
): ClassicSidetabMissionIntegration {
  const tool = createClassicSidetabMissionTool(runMission);
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
    getTools: (tools) => [...tools.map(spec => spec.name === AGENT_TOOL_NAME ? withHandOption(spec) : spec), tool.spec, ...(cancelMission ? [{
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
