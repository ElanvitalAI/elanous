// NEXUS · /v1/setup/llm-provider routes (PWA `/setup` wizard · Phase 1)
//
// 사용자가 PWA `/setup` 에서 LLM provider 를 처음 고를 때 호출하는 wire.
// 기존 TUI 의 popup-terminal setup 흐름 (`elanous setup llm`) 과 동일한 결과
// (user-config 의 `llm.provider / llm.apiKey / llm.rotation` 갱신) 를
// PWA 한 화면에서 처리.
//
// **Endpoints**:
//   GET  /v1/setup/llm-providers      → { providers: [{ provider, label, description, apiKeyLabel, flow, recommended }] }
//   POST /v1/setup/llm-provider       → body { provider, apiKey?, baseUrl? } → 200 { ok, active: { provider, model } }
//
// **flow 별 처리**:
//   - 'apiKey' (anthropic / gemini / grok / openai / kimi / qwen / glm)
//       → body.apiKey 필수. applyDashboardProviderSetup 으로 user-config 갱신
//   - 'auto'  → apiKey 없이 provider: 'auto' 만 저장 (env 에서 detect)
//   - 'codex' / 'local' → 본 endpoint 에서는 미지원 (400). PWA 가 안내 → TUI popup wizard 로 유도.
//     (Phase 1 scope: simple apiKey/auto 만. Codex OAuth + Local probe 는 후속 PR.)
//
// Auth model: http-server 의 loopback noAuth · bearer enforced when set.

import {
  applyDashboardProviderSetup,
  DASHBOARD_PROVIDER_SETUP_OPTIONS,
  findProviderSetupOption,
  type DashboardProviderSetupOption,
} from '../../setup/provider-options.js';
import {
  getUserConfig,
  reloadUserConfig,
  saveUserConfig,
} from '../../user-config.js';

interface LlmProviderWire {
  provider: string;
  label: string;
  description: string;
  apiKeyLabel: string;
  /** 'apiKey' | 'codex' | 'local' | 'auto' — Phase 1 PWA supports apiKey + auto. */
  flow: DashboardProviderSetupOption['flow'];
  /** Recommended for first-time users (the 4 mainstream providers). */
  recommended: boolean;
  /** True when the user-config already has a saved apiKey for this provider
   *  (in rotation OR as active). Lets the PWA show "already configured" hint
   *  without echoing the secret. */
  hasSavedKey: boolean;
}

interface LlmProvidersResponse {
  providers: LlmProviderWire[];
  /** Currently-active provider on disk · empty string when unset. */
  activeProvider: string;
}

interface LlmProviderSetBody {
  provider: string;
  apiKey?: string;
  /** Local provider only — base URL of OpenAI-compatible server. Reserved
   *  for Phase 1b (Codex/Local flow PWA support). */
  baseUrl?: string;
}

interface LlmProviderSetResponse {
  ok: true;
  active: {
    provider: string;
    model: string;
  };
}

const RECOMMENDED_PROVIDERS = new Set([
  'anthropic',
  'openai-codex',
  'openai',
  'gemini',
  'grok',
]);

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

function optionToWire(
  option: DashboardProviderSetupOption,
  hasSavedKey: boolean,
): LlmProviderWire {
  return {
    provider: option.provider,
    label: option.label,
    description: option.description,
    apiKeyLabel: option.apiKeyLabel,
    flow: option.flow,
    recommended: RECOMMENDED_PROVIDERS.has(option.provider),
    hasSavedKey,
  };
}

function hasSavedKeyFor(cfg: ReturnType<typeof getUserConfig>, provider: string): boolean {
  const rot = cfg.llm.rotation ?? [];
  if (rot.some((e) => e.provider === provider && typeof e.apiKey === 'string' && e.apiKey.length > 0)) {
    return true;
  }
  if (cfg.llm.provider === provider && typeof cfg.llm.apiKey === 'string' && cfg.llm.apiKey.length > 0) {
    return true;
  }
  return false;
}

/** GET /v1/setup/llm-providers */
export function handleLlmProvidersList(req: Request): Response {
  if (req.method === 'OPTIONS') return corsPreflight();
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'method-not-allowed', method: req.method }, 405);
  }
  const cfg = getUserConfig();
  const providers = DASHBOARD_PROVIDER_SETUP_OPTIONS.map((opt) =>
    optionToWire(opt, hasSavedKeyFor(cfg, opt.provider)),
  );
  const body: LlmProvidersResponse = {
    providers,
    activeProvider: cfg.llm.provider ?? '',
  };
  return jsonResponse(body, 200);
}

/** POST /v1/setup/llm-provider */
export async function handleLlmProviderSet(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return corsPreflight();
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method-not-allowed', method: req.method }, 405);
  }

  let body: LlmProviderSetBody;
  try {
    body = (await req.json()) as LlmProviderSetBody;
  } catch {
    return jsonResponse({ error: 'invalid-json' }, 400);
  }

  if (!body || typeof body.provider !== 'string' || body.provider.length === 0) {
    return jsonResponse({ error: 'provider-required' }, 400);
  }

  const option = findProviderSetupOption(body.provider);
  if (!option) {
    return jsonResponse({ error: 'unknown-provider', provider: body.provider }, 400);
  }

  // Phase 1 supports apiKey + auto flows. Codex (OAuth) + Local (probe)
  // require interactive flows — surface a clear 422 so the PWA can guide
  // the user to the TUI popup wizard.
  if (option.flow === 'codex' || option.flow === 'local') {
    return jsonResponse(
      {
        error: 'flow-not-supported-in-pwa',
        flow: option.flow,
        hint:
          option.flow === 'codex'
            ? 'Run `elanous setup llm` to complete OAuth flow.'
            : 'Run `elanous setup llm` to probe local runtimes.',
      },
      422,
    );
  }

  const cur = getUserConfig();

  if (option.flow === 'auto') {
    const next = {
      ...cur,
      llm: {
        ...cur.llm,
        provider: 'auto' as const,
        apiKey: undefined,
        baseUrl: undefined,
        model: undefined,
      },
    };
    saveUserConfig(next);
    const reloaded = reloadUserConfig();
    const okBody: LlmProviderSetResponse = {
      ok: true,
      active: {
        provider: reloaded.llm.provider,
        model: reloaded.llm.model ?? '',
      },
    };
    return jsonResponse(okBody, 200);
  }

  // apiKey flow
  let apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (apiKey.length === 0) {
    // apiKey 미제공 — 이미 저장된(rotation OR active) key 재사용 = "configured
    // provider 간 전환"(PWA 채팅 provider 스위처). 저장된 게 없으면 400.
    const rot = cur.llm.rotation ?? [];
    const saved = rot.find((e) => e.provider === option.provider && typeof e.apiKey === 'string' && e.apiKey.length > 0)?.apiKey
      ?? (cur.llm.provider === option.provider && typeof cur.llm.apiKey === 'string' && cur.llm.apiKey.length > 0 ? cur.llm.apiKey : '');
    if (!saved) {
      return jsonResponse({ error: 'apiKey-required', provider: option.provider }, 400);
    }
    apiKey = saved;
  }

  const next = applyDashboardProviderSetup(cur, option, apiKey);
  saveUserConfig(next);
  const reloaded = reloadUserConfig();
  const okBody: LlmProviderSetResponse = {
    ok: true,
    active: {
      provider: reloaded.llm.provider,
      model: reloaded.llm.model ?? '',
    },
  };
  return jsonResponse(okBody, 200);
}

// Re-export for tests.
export type {
  LlmProviderWire,
  LlmProvidersResponse,
  LlmProviderSetBody,
  LlmProviderSetResponse,
};
