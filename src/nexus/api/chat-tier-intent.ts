// M3-3 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 3) —
// `POST /v1/chat/tier-intent` endpoint.
//
// Detects whether a user chat message is asking elanous to change voice
// / LLM tier settings ("이번 회의는 의료 용어 많아"), plans the switch,
// and (when `apply: true` is set) installs a session-scoped override
// that the tier-resolver consults before user-config.
//
// Request body:
//   {
//     "text": "this meeting is full of medical jargon",
//     "sessionId": "sess-A",         // optional · required when apply=true
//     "apply": false,                // default false · "preview only"
//     "runner": {                    // optional · default LM Studio
//       "model": "google/gemma-4-e4b",
//       "endpoint": "http://localhost:1234/v1",
//       "token": "..."
//     }
//   }
//
// Response (200):
//   { detection, plan, applied: boolean, overrideExpiresAt? }
//
// Read-only when `apply=false`; mutation goes through
// `setSessionTierOverride` (in-process · transient · auto-reverts on TTL
// expiry or session end).

import {
  createLocalLlmPresetRunner,
  detectTierIntentFromChat,
  planNlTierSwitch,
  resolveLlmTier,
  resolveSttTier,
  resolveTtsTier,
  setSessionTierOverride,
  type CurrentTierSlots,
  type LlmRunner,
  type NlTierApplyPlan,
  type NlTierDetection,
} from '../../model-tier/index.js';
import { buildUserConfig, userConfigPath } from '../../user-config.js';
import type { UserConfig } from '../../user-config/types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface ChatTierIntentBody {
  text?: unknown;
  sessionId?: unknown;
  apply?: unknown;
  runner?: { model?: unknown; endpoint?: unknown; token?: unknown };
  /** Test seam — caller may inject a runner; the daemon path
   *  always uses `createLocalLlmPresetRunner` because the request is
   *  serialized JSON, so this field is internal-only when handlers
   *  are driven from unit tests directly. */
  _runner?: LlmRunner;
  /** Hard wall-clock cap forwarded to the detector. */
  timeoutMs?: unknown;
}

export interface ChatTierIntentResponse {
  detection: NlTierDetection;
  plan: NlTierApplyPlan;
  applied: boolean;
  /** Set when `applied=true`. */
  overrideExpiresAt?: number;
  /** Set when `applied=true`. */
  sessionId?: string;
}

function resolveCurrentSlots(cfg: UserConfig): CurrentTierSlots {
  const stt = resolveSttTier(cfg.modelTier).tier;
  const tts = resolveTtsTier(cfg.modelTier).tier;
  const provider = cfg.llm?.provider ?? 'claude';
  const llm = resolveLlmTier(cfg.modelTier, provider).tier;
  return { stt, llm, tts };
}

export async function handleChatTierIntentPost(req: Request): Promise<Response> {
  let body: ChatTierIntentBody;
  try { body = (await req.json()) as ChatTierIntentBody; }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'invalid-shape' }, 400);
  }
  if (typeof body.text !== 'string' || body.text.trim().length === 0) {
    return jsonResponse({ error: 'missing-text' }, 400);
  }
  const apply = body.apply === true;
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0
    ? body.sessionId
    : undefined;
  if (apply && !sessionId) {
    return jsonResponse({ error: 'apply-requires-session-id' }, 400);
  }
  const timeoutMs = typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)
    ? body.timeoutMs
    : undefined;
  let runner: LlmRunner;
  if (body._runner) {
    runner = body._runner;
  } else {
    const model = typeof body.runner?.model === 'string' ? body.runner.model : undefined;
    if (!model) {
      return jsonResponse({ error: 'missing-runner-model', hint: 'body.runner.model required (LM Studio model id)' }, 400);
    }
    runner = createLocalLlmPresetRunner({
      model,
      ...(typeof body.runner?.endpoint === 'string' ? { endpoint: body.runner.endpoint } : {}),
      ...(typeof body.runner?.token === 'string' ? { token: body.runner.token } : {}),
    });
  }

  const cfg = buildUserConfig(userConfigPath());
  const detection = await detectTierIntentFromChat(body.text, runner, {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  const plan = planNlTierSwitch(detection, resolveCurrentSlots(cfg));

  const out: ChatTierIntentResponse = { detection, plan, applied: false };
  if (apply && sessionId && !plan.isNoop) {
    const installed = setSessionTierOverride(sessionId, {
      ...plan.apply,
      ...(plan.monthlyUsdCap !== undefined ? { monthlyUsdCap: plan.monthlyUsdCap } : {}),
      rationale: detection.rationale || 'NL tier switch',
    });
    out.applied = true;
    out.sessionId = sessionId;
    if (installed.expiresAt !== undefined) out.overrideExpiresAt = installed.expiresAt;
  }
  return jsonResponse(out, 200);
}
