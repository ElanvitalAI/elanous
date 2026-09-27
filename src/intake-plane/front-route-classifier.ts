import { debug } from '../debug/log.js';
import type { ModelRole } from '../user-config.js';
import type { ResolveRoleProviderFn, StreamLlmFn, ProviderRegistry } from './runtime-callables.js';
import { extractJsonBlock } from './decompose.js';
import {
  INTAKE_FRONT_ROUTE_TRACKS,
  type IntakeFrontRouteDecision,
  type IntakeFrontRouteTrack,
} from './front-route-rules.js';

interface ClassifierDeps {
  streamLLM?: StreamLlmFn;
  resolveRoleProvider?: ResolveRoleProviderFn;
  minConfidence?: number;
}

function loadRoleProvider(): ResolveRoleProviderFn {
  const { resolveRoleLlm } = require('../user-config.js') as {
    resolveRoleLlm: (role: ModelRole) => { provider: string; model: string };
  };
  const { PROVIDERS } = require('../llm.js') as { PROVIDERS: ProviderRegistry };
  return (role) => {
    const resolved = resolveRoleLlm(role);
    return { provider: PROVIDERS[resolved.provider] ?? { name: resolved.provider }, model: resolved.model };
  };
}

/** Classify only after the deterministic front-route rules return rule-unknown. */
export async function classifyIntakeFrontRoute(
  text: string,
  deps: ClassifierDeps = {},
): Promise<IntakeFrontRouteDecision> {
  let provider = '';
  const finish = (
    track: IntakeFrontRouteTrack,
    confidence: number,
    reason: string,
    outcome: 'ok' | 'low-confidence' | 'failed',
  ): IntakeFrontRouteDecision => {
    debug.log('intake.front-route', 'classified', { track, confidence, outcome, provider });
    return { track, confidence, reason, decidedBy: 'classifier' };
  };
  const failed = (cause: string) => finish('ask-human', 0, `classifier-failed:${cause}`, 'failed');

  try {
    const rolePick = (deps.resolveRoleProvider ?? loadRoleProvider())('classify');
    provider = rolePick.provider.name;
    const streamLLM = deps.streamLLM ?? (require('../llm.js') as { streamLLM: StreamLlmFn }).streamLLM;
    const response = await streamLLM([
      { role: 'system', content: [
        'Classify the intake text into exactly one track:',
        'absorb: read, save, or summarize external material.',
        'tasks: a list of independent to-dos.',
        'graph: an implementation or multi-step workflow request.',
        'ask-human: ambiguous intent requiring human choice.',
        'Return only one JSON object: {"track":"...","confidence":0.0,"reason":"..."}. Confidence must be between 0 and 1.',
      ].join('\n') },
      { role: 'user', content: text },
    ], () => {}, { provider: rolePick.provider, ...(rolePick.model ? { model: rolePick.model } : {}), usageRole: 'classify' });

    // 실제 모델은 JSON 을 ```json 펜스로 감싸거나 앞뒤에 말을 붙이곤 한다 — 같은 디렉토리의 다른 호출자와 같은 관대한 추출을 쓴다.
    const parsed: unknown = extractJsonBlock(response);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return failed('invalid-json');
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.track !== 'string' ||
      !(INTAKE_FRONT_ROUTE_TRACKS as readonly string[]).includes(candidate.track)) return failed('invalid-track');
    if (typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence) ||
      candidate.confidence < 0 || candidate.confidence > 1) return failed('invalid-confidence');
    if (typeof candidate.reason !== 'string') return failed('invalid-reason');

    const track = candidate.track as IntakeFrontRouteTrack;
    const confidence = candidate.confidence;
    if (confidence < (deps.minConfidence ?? 0.6)) {
      return finish('ask-human', confidence, `classifier-low-confidence:${track}`, 'low-confidence');
    }
    return finish(track, confidence, candidate.reason, 'ok');
  } catch {
    return failed('llm-error');
  }
}
