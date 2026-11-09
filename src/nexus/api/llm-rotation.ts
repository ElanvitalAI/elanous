// NEXUS · /v1/llm/rotation routes
//
// 사용자 인풋바 하단 model chip (iOS Phase 1.5 · PWA Showroom · dashboard
// status pill) 의 공통 wire. user-config 의 `llm.rotation` (RotationEntry[])
// 를 list 로 surface + tap-to-cycle 시 다음 entry 를 active 로 mutate.
//
// **Active state**: ~/.elanous/config.json 의 top-level `llm.provider/model`
// 이 SoT (rotateNextProvider 가 이 두 field 를 다음 entry 로 갱신).
// in-memory 추가 state 없음 — daemon restart 후에도 사용자가 마지막에
// 선택한 model 유지. feedback_user_config_over_env 정합.
//
// **Endpoints**:
//   GET  /v1/llm/rotation      → { entries, activeIndex, activeProvider, activeModel }
//   POST /v1/llm/rotation/next → advance index by 1 (wrap) · same response shape
//
// Empty rotation list = 200 OK with entries:[], activeIndex:-1. POST /next
// on empty list = 409 'no-rotation-configured'.

import { getUserConfig, saveUserConfig, reloadUserConfig, rotateNextProvider, currentRotationIndex, modelDisplayForRotationEntry, rotationEntryLabel } from '../../user-config.js';
import type { RotationEntry, UserConfig } from '../../user-config/types.js';

interface RotationEntryWire {
  /** Stable index (position in the user's rotation array). */
  index: number;
  provider: string;
  /** Resolved model — falls back to PROVIDER_DEFAULT_MODEL when entry omits. */
  model: string;
  /** Display label (user-supplied OR `provider:model` fallback). */
  label: string;
  /** Whether this entry has an explicit API key field on disk (NOT the
   *  value — never leak secrets). UI may show a key icon. */
  hasApiKey: boolean;
}

interface RotationResponse {
  entries: RotationEntryWire[];
  /** -1 when the active top-level provider/model doesn't match any entry
   *  (typical when user set provider manually outside the rotation). */
  activeIndex: number;
  /** Current top-level — surfaces even when activeIndex === -1 so the chip
   *  can still display "what's running right now". */
  activeProvider: string;
  activeModel: string;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '600',
    },
  });
}

function entryToWire(entry: RotationEntry, index: number): RotationEntryWire {
  return {
    index,
    provider: entry.provider,
    model: modelDisplayForRotationEntry(entry),
    label: rotationEntryLabel(entry),
    hasApiKey: typeof entry.apiKey === 'string' && entry.apiKey.length > 0,
  };
}

function buildResponse(cfg: UserConfig): RotationResponse {
  const rot = cfg.llm.rotation ?? [];
  return {
    entries: rot.map((e, i) => entryToWire(e, i)),
    activeIndex: rot.length === 0 ? -1 : currentRotationIndex(cfg),
    activeProvider: cfg.llm.provider,
    activeModel: cfg.llm.model ?? '',
  };
}

export function handleLlmRotationGet(req: Request): Response {
  if (req.method === 'OPTIONS') return corsPreflight();
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'method-not-allowed', method: req.method }, 405);
  }
  const cfg = getUserConfig();
  return jsonResponse(buildResponse(cfg), 200);
}

export function handleLlmRotationNext(req: Request): Response {
  if (req.method === 'OPTIONS') return corsPreflight();
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method-not-allowed', method: req.method }, 405);
  }
  const cur = getUserConfig();
  if (!cur.llm.rotation || cur.llm.rotation.length === 0) {
    return jsonResponse({ error: 'no-rotation-configured' }, 409);
  }
  const { cfg: nextCfg, entry } = rotateNextProvider(cur);
  if (!entry) {
    return jsonResponse({ error: 'no-rotation-configured' }, 409);
  }
  saveUserConfig(nextCfg);
  const reloaded = reloadUserConfig();
  return jsonResponse(buildResponse(reloaded), 200);
}
