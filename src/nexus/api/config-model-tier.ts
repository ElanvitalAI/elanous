// M1-2b (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1) —
// /v1/config/model-tier endpoint handlers.
//
// Round-trips the `modelTier`, `budget`, and `smartDefaults` sub-trees
// of UserConfig (Path A root-level) so the PWA slider can sync across
// devices instead of staying per-device in localStorage. The switches
// API only handles `global.*` / `tabs.*`; this endpoint is the Path-A
// counterpart for root-level typed sub-trees.
//
// Routes:
//   GET  /v1/config/model-tier
//       → 200 { modelTier?, budget?, smartDefaults? }
//   PUT  /v1/config/model-tier
//       Body: { modelTier?, budget?, smartDefaults? }
//       → 200 { modelTier?, budget?, smartDefaults? } (post-merge)
//       → 400 { error: 'invalid-json' | 'invalid-shape' | 'invalid-tier' }
//
// Mutation semantics: PUT merges the supplied sub-trees into the
// existing UserConfig (each provided key replaces the whole sub-tree).
// Omitting a key preserves the existing value · supplying `null`
// clears the sub-tree (sparse default).

import {
  buildUserConfig,
  saveUserConfig,
  userConfigPath,
  type UserConfig,
} from '../../user-config.js';

// Tiny local `jsonResponse` so this module doesn't transitively pull
// `http-server.ts` (which imports `web-push` — irrelevant here and
// causes test ImportError when the optional binary is missing).
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

import {
  isModelTier,
  isModelTierProfile,
  type BudgetUserConfig,
  type ModelTier,
  type ModelTierUserConfig,
  type SmartDefaultsUserConfig,
} from '../../model-tier/types.js';

// ── GET ────────────────────────────────────────────────────────────

export function handleModelTierGet(): Response {
  const cfg = buildUserConfig(userConfigPath());
  const body: {
    modelTier?: ModelTierUserConfig;
    budget?: BudgetUserConfig;
    smartDefaults?: SmartDefaultsUserConfig;
  } = {};
  if (cfg.modelTier) body.modelTier = cfg.modelTier;
  if (cfg.budget) body.budget = cfg.budget;
  if (cfg.smartDefaults) body.smartDefaults = cfg.smartDefaults;
  return jsonResponse(body, 200);
}

// ── PUT ────────────────────────────────────────────────────────────

interface ModelTierPutBody {
  modelTier?: ModelTierUserConfig | null;
  budget?: BudgetUserConfig | null;
  smartDefaults?: SmartDefaultsUserConfig | null;
}

function normalizeModelTier(v: unknown): ModelTierUserConfig | undefined | 'invalid' {
  if (v === null) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'invalid';
  const r = v as Record<string, unknown>;
  const out: ModelTierUserConfig = {};
  const profile = r.profile === undefined ? r.persona : r.profile;
  if (profile !== undefined) {
    if (!isModelTierProfile(profile)) return 'invalid';
    out.profile = profile;
  }
  if (r.preset !== undefined) {
    if (typeof r.preset !== 'string' || r.preset.trim().length === 0) return 'invalid';
    out.preset = r.preset.trim();
  }
  if (r.voice !== undefined) {
    if (!r.voice || typeof r.voice !== 'object' || Array.isArray(r.voice)) return 'invalid';
    const vr = r.voice as Record<string, unknown>;
    const voice: { stt?: ModelTier; tts?: ModelTier; ttsVoice?: Record<string, string> } = {};
    if (vr.stt !== undefined) {
      if (!isModelTier(vr.stt)) return 'invalid';
      voice.stt = vr.stt;
    }
    if (vr.tts !== undefined) {
      if (!isModelTier(vr.tts)) return 'invalid';
      voice.tts = vr.tts;
    }
    // M2-2b — per-context TTS voice id. Each context (default/chat/
    // digest/alert/discord) is an optional non-empty string. Invalid
    // contexts or non-string values reject the whole PUT.
    if (vr.ttsVoice !== undefined) {
      if (!vr.ttsVoice || typeof vr.ttsVoice !== 'object' || Array.isArray(vr.ttsVoice)) return 'invalid';
      const tv = vr.ttsVoice as Record<string, unknown>;
      const ttsVoice: Record<string, string> = {};
      const ALLOWED_CONTEXTS = ['default', 'chat', 'digest', 'alert', 'discord'];
      for (const ctx of Object.keys(tv)) {
        if (!ALLOWED_CONTEXTS.includes(ctx)) return 'invalid';
        const v = tv[ctx];
        if (typeof v !== 'string' || v.trim().length === 0) return 'invalid';
        ttsVoice[ctx] = v.trim();
      }
      if (Object.keys(ttsVoice).length > 0) voice.ttsVoice = ttsVoice;
    }
    if (Object.keys(voice).length > 0) out.voice = voice;
  }
  for (const key of ['llm', 'embedding', 'vision'] as const) {
    if (r[key] !== undefined) {
      if (!isModelTier(r[key])) return 'invalid';
      out[key] = r[key] as ModelTier;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeBudget(v: unknown): BudgetUserConfig | undefined | 'invalid' {
  if (v === null) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'invalid';
  const r = v as Record<string, unknown>;
  const out: BudgetUserConfig = {};
  if (r.monthlyUsdCap !== undefined) {
    if (typeof r.monthlyUsdCap !== 'number' || !Number.isFinite(r.monthlyUsdCap) || r.monthlyUsdCap < 0) return 'invalid';
    out.monthlyUsdCap = r.monthlyUsdCap;
  }
  if (r.dailyUsdCap !== undefined) {
    if (typeof r.dailyUsdCap !== 'number' || !Number.isFinite(r.dailyUsdCap) || r.dailyUsdCap < 0) return 'invalid';
    out.dailyUsdCap = r.dailyUsdCap;
  }
  if (r.fallbackTier !== undefined) {
    if (!isModelTier(r.fallbackTier)) return 'invalid';
    out.fallbackTier = r.fallbackTier;
  }
  if (r.notifyAtPct !== undefined) {
    if (typeof r.notifyAtPct !== 'number' || !Number.isFinite(r.notifyAtPct) || r.notifyAtPct < 0 || r.notifyAtPct > 100) return 'invalid';
    out.notifyAtPct = r.notifyAtPct;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeSmartDefaults(v: unknown): SmartDefaultsUserConfig | undefined | 'invalid' {
  if (v === null) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'invalid';
  const r = v as Record<string, unknown>;
  const out: SmartDefaultsUserConfig = {};
  if (r.autoSuggest !== undefined) {
    if (typeof r.autoSuggest !== 'boolean') return 'invalid';
    out.autoSuggest = r.autoSuggest;
  }
  if (r.suppressPatternHints !== undefined) {
    if (typeof r.suppressPatternHints !== 'boolean') return 'invalid';
    out.suppressPatternHints = r.suppressPatternHints;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function handleModelTierPut(req: Request): Promise<Response> {
  let body: ModelTierPutBody;
  try { body = (await req.json()) as ModelTierPutBody; }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }

  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'invalid-shape' }, 400);
  }

  // Validate each sub-tree the client supplied before touching disk.
  const touchedKeys: Array<'modelTier' | 'budget' | 'smartDefaults'> = [];
  const validated: {
    modelTier?: ModelTierUserConfig | undefined;
    budget?: BudgetUserConfig | undefined;
    smartDefaults?: SmartDefaultsUserConfig | undefined;
  } = {};

  if ('modelTier' in body) {
    const r = normalizeModelTier(body.modelTier);
    if (r === 'invalid') return jsonResponse({ error: 'invalid-tier' }, 400);
    validated.modelTier = r;
    touchedKeys.push('modelTier');
  }
  if ('budget' in body) {
    const r = normalizeBudget(body.budget);
    if (r === 'invalid') return jsonResponse({ error: 'invalid-budget' }, 400);
    validated.budget = r;
    touchedKeys.push('budget');
  }
  if ('smartDefaults' in body) {
    const r = normalizeSmartDefaults(body.smartDefaults);
    if (r === 'invalid') return jsonResponse({ error: 'invalid-smart-defaults' }, 400);
    validated.smartDefaults = r;
    touchedKeys.push('smartDefaults');
  }

  if (touchedKeys.length === 0) {
    return jsonResponse({ error: 'no-fields-supplied', hint: 'PUT one of modelTier/budget/smartDefaults' }, 400);
  }

  // Load current config, merge in the validated sub-trees, persist.
  const cfgPath = userConfigPath();
  const cfg = buildUserConfig(cfgPath);
  const next: UserConfig = { ...cfg };
  for (const key of touchedKeys) {
    const value = validated[key];
    if (value === undefined) {
      delete next[key];
    } else if (key === 'modelTier') {
      next.modelTier = value as ModelTierUserConfig;
    } else if (key === 'budget') {
      next.budget = value as BudgetUserConfig;
    } else if (key === 'smartDefaults') {
      next.smartDefaults = value as SmartDefaultsUserConfig;
    }
  }
  saveUserConfig(next, cfgPath);

  // Echo back the resolved state from disk so the PWA client doesn't
  // have to assume the merge worked exactly as planned.
  const post = buildUserConfig(cfgPath);
  return jsonResponse({
    ...(post.modelTier ? { modelTier: post.modelTier } : {}),
    ...(post.budget ? { budget: post.budget } : {}),
    ...(post.smartDefaults ? { smartDefaults: post.smartDefaults } : {}),
  }, 200);
}
