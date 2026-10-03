import { debug } from '../debug/log.js';
import type { ResolveRoleProviderFn, StreamLlmFn } from './runtime-callables.js';
import { judge } from '../llm/judge-layer.js';
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
    const decision = await judge({
      site: 'intake.front-route',
      prompt: text,
      messages: [
        { role: 'system', content: [
          'Classify the intake text into exactly one track:',
          'absorb: read, save, or summarize external material.',
          'tasks: a list of independent to-dos.',
          'graph: an implementation or multi-step workflow request.',
          'ask-human: ambiguous intent requiring human choice.',
          'Return only one JSON object: {"track":"...","confidence":0.0,"reason":"..."}. Confidence must be between 0 and 1.',
        ].join('\n') },
        { role: 'user', content: text },
      ],
      streamLLM: deps.streamLLM,
      resolveRoleProvider: deps.resolveRoleProvider,
      schema: (parsed) => {
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const candidate = parsed as Record<string, unknown>;
        if (typeof candidate.track !== 'string' ||
          !(INTAKE_FRONT_ROUTE_TRACKS as readonly string[]).includes(candidate.track)) return null;
        if (typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence) ||
          candidate.confidence < 0 || candidate.confidence > 1) return null;
        if (typeof candidate.reason !== 'string') return null;
        return { track: candidate.track as IntakeFrontRouteTrack, confidence: candidate.confidence, reason: candidate.reason };
      },
    });
    provider = decision.ok ? decision.provider : provider;
    if (!decision.ok) return failed(decision.reason === 'schema' ? 'invalid-json' : 'llm-error');
    const candidate = decision.value;

    const track = candidate.track;
    const confidence = candidate.confidence;
    if (confidence < (deps.minConfidence ?? 0.6)) {
      return finish('ask-human', confidence, `classifier-low-confidence:${track}`, 'low-confidence');
    }
    return finish(track, confidence, candidate.reason, 'ok');
  } catch {
    return failed('llm-error');
  }
}
