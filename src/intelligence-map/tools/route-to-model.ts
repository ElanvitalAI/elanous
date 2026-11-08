import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S5 P4: RouteToModel LLM tool ──
//
// Wraps recommendModel with the standard catalog/system/cost context
// load + LLM spec. Recommendation only — actual call happens via
// RunWithModel (deferred to pfc-intelligence-runners).


import {
  recommendModel,
  type ModelRecommendation,
  type RecommendHints,
  type TaskType,
} from '../recommend-model.js';
import { discoverModels } from '../model-catalog.js';
import { snapshotCost, loadCostConfig } from '../cost-meter.js';
import { getSystemSnapshot } from '../system-monitor.js';
import { debug } from '../../debug/log.js';

export interface RouteToModelInput {
  task_type: TaskType;
  context_size?: number;
  latency_target?: 'fast' | 'normal' | 'slow';
  max_usd_per_call?: number;
  force_local?: boolean;
  estimated_input_tokens?: number;
  estimated_output_tokens?: number;
}

export interface RouteToModelDispatchOpts {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export async function dispatchRouteToModel(
  input: RouteToModelInput,
  opts: RouteToModelDispatchOpts = {},
): Promise<ModelRecommendation> {
  if (!input.task_type) {
    throw new Error('RouteToModel: task_type is required');
  }

  const catalog = await discoverModels({ home: opts.home, env: opts.env });
  const system = getSystemSnapshot();
  const cost = snapshotCost({ home: opts.home, env: opts.env });
  const costConfig = loadCostConfig({ home: opts.home, env: opts.env });

  const hints: RecommendHints = {};
  if (input.context_size !== undefined) hints.contextSize = input.context_size;
  if (input.latency_target !== undefined) hints.latencyTarget = input.latency_target;
  if (input.max_usd_per_call !== undefined) hints.maxUsdPerCall = input.max_usd_per_call;
  if (input.force_local !== undefined) hints.forceLocal = input.force_local;
  if (input.estimated_input_tokens !== undefined) hints.estimatedInputTokens = input.estimated_input_tokens;
  if (input.estimated_output_tokens !== undefined) hints.estimatedOutputTokens = input.estimated_output_tokens;

  const rec = recommendModel(input.task_type, hints, {
    catalog,
    system,
    cost,
    costConfig,
    ...(opts.env ? { env: opts.env } : {}),
  });
  // 제1원칙 관측 — recommender 결정을 logs.db 로 남긴다(종전엔 순수 반환만·조회 불가). 지속 LLM
  // 관리 루프가 라우팅 추천 패턴을 `elanous logs --category llm.router` 로 관측·자기인지할 수 있게.
  debug.log('llm.router', 'route-to-model', {
    taskType: input.task_type,
    recommended: rec.recommended ?? '(none)',
    alternatives: rec.alternatives,
    capStatus: rec.capStatus,
    forceLocal: input.force_local ?? false,
  }, { level: 'info' });
  return rec;
}

// ── LLM tool spec ──────────────────────────────────────────────────────

export function buildRouteToModelTool(): LLMToolSpec {
  return {
    name: 'RouteToModel',
    description:
      'Recommend which model to use for a task based on the live model catalog, system load, weekly/monthly '
      + 'cost caps, and the requested task type. Returns the top recommendation + alternatives + a deterministic '
      + 'reasoning string. Pure recommendation — actual dispatch happens via RunWithModel (use this to decide, '
      + 'then invoke the chosen model via the normal LLM provider path).',
    parameters: {
      type: 'object',
      properties: {
        task_type: {
          type: 'string',
          enum: ['reasoning', 'coding', 'classification', 'summarization', 'embedding', 'cheap', 'local_preferred', 'long_context'],
        },
        context_size: { type: 'integer', description: 'Minimum context window required (tokens).' },
        latency_target: { type: 'string', enum: ['fast', 'normal', 'slow'] },
        max_usd_per_call: { type: 'number', description: 'Upper bound for estimated call cost.' },
        force_local: { type: 'boolean' },
        estimated_input_tokens: { type: 'integer' },
        estimated_output_tokens: { type: 'integer' },
      },
      required: ['task_type'],
      additionalProperties: false,
    },
  };
}
