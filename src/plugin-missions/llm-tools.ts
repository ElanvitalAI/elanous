import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── PX-4 P5: MissionStatus LLM tool ──
//
// Read-only observation into globalMissionRegistry. The parent LLM
// uses this to check on autonomous mission progress without waiting
// for the Turn hook banner.


import { globalMissionRegistry, type MissionRegistry } from './registry.js';
import type { MissionState, MissionDefinition } from './types.js';

export interface MissionStatusArgs {
  id?: string;
}

export interface MissionStatusResult extends Record<string, unknown> {
  output: string;
  missions: Array<{
    id: string;
    name: string;
    state: MissionState | null;
  }>;
}

export function buildMissionStatusTool(): LLMToolSpec {
  return {
    name: 'MissionStatus',
    description:
      'Report status of registered missions (autonomous goals with shell evaluators). ' +
      'Pass an id to inspect one mission; omit id for a summary of all registered missions. ' +
      'Read-only — safe to call at any time; does not trigger evaluator runs.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Optional mission id. When provided, returns state for that mission only. ' +
            'Omit to list every registered mission + current status.',
        },
      },
      additionalProperties: false,
    },
  };
}

export interface MissionStatusDispatchOpts {
  registry?: MissionRegistry;
}

export function dispatchMissionStatus(
  args: Record<string, unknown>,
  opts: MissionStatusDispatchOpts = {},
): MissionStatusResult {
  const reg = opts.registry ?? globalMissionRegistry;
  const defs: MissionDefinition[] = typeof args.id === 'string' && args.id.trim()
    ? reg.list().filter(d => d.id === args.id)
    : reg.list();
  const missions = defs.map(d => ({
    id: d.id,
    name: d.name,
    state: reg.state(d.id),
  }));
  const output = missions.length === 0
    ? 'No missions match this query.'
    : missions.map(m => {
        const s = m.state;
        if (!s) return `- ${m.id}: (not registered)`;
        const iter = `${s.iteration}/${reg.list().find(d => d.id === m.id)?.maxIterations ?? '?'}`;
        const lastErr = s.lastResult?.error ? ` [last error: ${s.lastResult.error}]` : '';
        return `- ${m.id} [${s.status}] iteration ${iter}${lastErr}`;
      }).join('\n');
  return { output, missions };
}
