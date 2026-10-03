// M1-2b (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1) —
// PWA ↔ daemon round-trip for the friction-free model selection
// sub-tree. Layers on top of `model-tier-prefs.ts` (localStorage) so
// the UI stays interactive even when the daemon is offline.
//
// Sync semantics:
//   - On mount: fetch daemon state · merge into localStorage (daemon
//     wins for explicit fields, localStorage keeps `audioMinPerDay`
//     which the daemon doesn't store).
//   - On change: write localStorage first (optimistic), then PUT to
//     daemon. If the PUT fails (offline / 5xx), the local state still
//     reflects the user's intent — next online sync will reconcile.
//   - On boot of an offline PWA: localStorage is the source of truth
//     until the daemon becomes reachable, at which point the sync hook
//     can push the local changes up.
//
// The functions return a small status discriminator so the card can
// show a "Saved" or "Syncing…" badge without leaking exception text.

import {
  isModelTier,
  type ModelTier,
} from './model-tier-spec';
import {
  loadModelTierPrefs,
  resetModelTierPrefs,
  saveModelTierPrefs,
  type ModelTierPrefs,
} from './model-tier-prefs';

// Daemon config the helpers need: baseUrl + optional bearer. Matches
// the shape of `DaemonProvider`'s `config` prop so callers can pass
// the daemon context directly.
export interface DaemonHttpConfig {
  baseUrl: string;
  token?: string;
}

type ModelTierWire = ModelTier;

interface TtsVoiceMappingWire {
  default?: string;
  chat?: string;
  digest?: string;
  alert?: string;
  discord?: string;
}

interface ModelTierUserConfigWire {
  voice?: {
    stt?: ModelTierWire;
    tts?: ModelTierWire;
    /** M2-2b — per-context voice identity (raw voice ids today). */
    ttsVoice?: TtsVoiceMappingWire;
  };
  llm?: ModelTierWire;
  embedding?: ModelTierWire;
  vision?: ModelTierWire;
  profile?: 'casual' | 'power' | 'custom';
  /** M2-3 — preset id ("meeting" · "medical_dictation" · ...). The
   *  preset's tier values get expanded into the sibling slots at
   *  apply time, but the id stays for the "Active preset" banner. */
  preset?: string;
}

/** Patch applied per-row in the Voice ID picker — `null` for a key
 *  clears that context · string sets it · omitted preserves. */
export interface TtsVoiceMappingPatch {
  default?: string | null;
  chat?: string | null;
  digest?: string | null;
  alert?: string | null;
  discord?: string | null;
}

interface BudgetUserConfigWire {
  monthlyUsdCap?: number;
  dailyUsdCap?: number;
  fallbackTier?: ModelTierWire;
  notifyAtPct?: number;
}

interface SmartDefaultsUserConfigWire {
  autoSuggest?: boolean;
  suppressPatternHints?: boolean;
}

interface ModelTierGetWire {
  modelTier?: ModelTierUserConfigWire;
  budget?: BudgetUserConfigWire;
  smartDefaults?: SmartDefaultsUserConfigWire;
}

interface ModelTierPutWire {
  modelTier?: ModelTierUserConfigWire | null;
  budget?: BudgetUserConfigWire | null;
  smartDefaults?: SmartDefaultsUserConfigWire | null;
}

function buildHeaders(cfg: DaemonHttpConfig): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  return headers;
}

function buildUrl(cfg: DaemonHttpConfig, path: string): string {
  const root = cfg.baseUrl.replace(/\/$/, '');
  return root + path;
}

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'offline' | 'error';

export interface DaemonModelTierState {
  stt?: ModelTier;
  llm?: ModelTier;
  tts?: ModelTier;
  monthlyUsdCap?: number;
}

/** Fetch the daemon's modelTier state · returns null when the call
 *  fails (offline · 5xx · auth missing). Callers should fall back to
 *  the localStorage prefs in that case. */
export async function fetchDaemonModelTier(
  cfg: DaemonHttpConfig,
): Promise<DaemonModelTierState | null> {
  if (!cfg.baseUrl) return null;
  try {
    const res = await fetch(buildUrl(cfg, '/v1/config/model-tier'), {
      headers: buildHeaders(cfg),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ModelTierGetWire;
    const stt = body.modelTier?.voice?.stt;
    const tts = body.modelTier?.voice?.tts;
    const llm = body.modelTier?.llm;
    return {
      ...(isModelTier(stt) ? { stt } : {}),
      ...(isModelTier(llm) ? { llm } : {}),
      ...(isModelTier(tts) ? { tts } : {}),
      ...(typeof body.budget?.monthlyUsdCap === 'number'
        ? { monthlyUsdCap: body.budget.monthlyUsdCap }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Pull the daemon state into localStorage so subsequent reads (and
 *  SSR-safe `loadModelTierPrefs()` calls) see the cross-device value.
 *  Returns the merged prefs · null on failure. */
export async function hydrateFromDaemon(
  cfg: DaemonHttpConfig,
): Promise<ModelTierPrefs | null> {
  const remote = await fetchDaemonModelTier(cfg);
  if (!remote) return null;
  const local = loadModelTierPrefs();
  const next = saveModelTierPrefs({
    stt: remote.stt ?? local.stt,
    llm: remote.llm ?? local.llm,
    tts: remote.tts ?? local.tts,
    // audioMinPerDay is locally measured (cost-tracker subscriber);
    // daemon doesn't currently track it.
    audioMinPerDay: local.audioMinPerDay,
  });
  return next;
}

async function putModelTier(
  cfg: DaemonHttpConfig,
  body: ModelTierPutWire,
): Promise<SyncStatus> {
  if (!cfg.baseUrl) return 'offline';
  try {
    const res = await fetch(buildUrl(cfg, '/v1/config/model-tier'), {
      method: 'PUT',
      headers: buildHeaders(cfg),
      body: JSON.stringify(body),
    });
    if (!res.ok) return 'error';
    return 'synced';
  } catch (err) {
    if (err instanceof TypeError) return 'offline';
    return 'error';
  }
}

/** Push the user's chosen STT tier to the daemon. Writes localStorage
 *  optimistically first so the UI never blocks on the network. Returns
 *  a status the card can show as a small badge. */
export async function pushSttTierToDaemon(
  cfg: DaemonHttpConfig,
  tier: ModelTier | null,
): Promise<SyncStatus> {
  // Optimistic local write first. null = reset to "Smart default"
  // (clear the override + reset audioMinPerDay so we don't carry a
  // stale usage figure across a deliberate clear).
  if (tier === null) {
    resetModelTierPrefs();
  } else {
    saveModelTierPrefs({ stt: tier });
  }
  const body: ModelTierPutWire = tier === null
    ? { modelTier: null }
    : { modelTier: { voice: { stt: tier } } };
  return putModelTier(cfg, body);
}

/** Compose a full modelTier sub-tree from current prefs so partial
 *  updates don't clobber sibling surfaces. The daemon endpoint merges
 *  sub-trees whole-cloth — to keep STT/TTS/LLM/embedding/vision
 *  independent the PWA has to re-send everything currently known on
 *  each PUT. */
function composeModelTierBody(): NonNullable<ModelTierPutWire['modelTier']> | null {
  const local = loadModelTierPrefs();
  const body: NonNullable<ModelTierPutWire['modelTier']> = {};
  const voice: { stt?: ModelTier; tts?: ModelTier } = {};
  if (local.stt) voice.stt = local.stt;
  if (local.tts) voice.tts = local.tts;
  if (Object.keys(voice).length > 0) body.voice = voice;
  if (local.llm) body.llm = local.llm;
  if (local.embedding) body.embedding = local.embedding;
  if (local.vision) body.vision = local.vision;
  return Object.keys(body).length === 0 ? null : body;
}

/** Push the user's chosen LLM tier (M2-1). null = reset to Smart default
 *  for the LLM surface only · STT/TTS untouched. */
export async function pushLlmTierToDaemon(
  cfg: DaemonHttpConfig,
  tier: ModelTier | null,
): Promise<SyncStatus> {
  if (tier === null) {
    saveModelTierPrefs({ llm: undefined as unknown as ModelTier });
  } else {
    saveModelTierPrefs({ llm: tier });
  }
  return putModelTier(cfg, { modelTier: composeModelTierBody() });
}

/** Push the user's chosen TTS tier (M2-2). null = reset to Smart
 *  default for the TTS surface only · STT/LLM untouched. */
export async function pushTtsTierToDaemon(
  cfg: DaemonHttpConfig,
  tier: ModelTier | null,
): Promise<SyncStatus> {
  if (tier === null) {
    saveModelTierPrefs({ tts: undefined as unknown as ModelTier });
  } else {
    saveModelTierPrefs({ tts: tier });
  }
  return putModelTier(cfg, { modelTier: composeModelTierBody() });
}

/** Push the user's chosen embedding tier (M3-2). Same semantics as
 *  pushLlmTier — sparse sub-tree merge so siblings are preserved. */
export async function pushEmbeddingTierToDaemon(
  cfg: DaemonHttpConfig,
  tier: ModelTier | null,
): Promise<SyncStatus> {
  if (tier === null) {
    saveModelTierPrefs({ embedding: undefined as unknown as ModelTier });
  } else {
    saveModelTierPrefs({ embedding: tier });
  }
  return putModelTier(cfg, { modelTier: composeModelTierBody() });
}

/** Push the user's chosen vision tier (M3-2). */
export async function pushVisionTierToDaemon(
  cfg: DaemonHttpConfig,
  tier: ModelTier | null,
): Promise<SyncStatus> {
  if (tier === null) {
    saveModelTierPrefs({ vision: undefined as unknown as ModelTier });
  } else {
    saveModelTierPrefs({ vision: tier });
  }
  return putModelTier(cfg, { modelTier: composeModelTierBody() });
}

/** Push a per-context TTS voice id patch (M2-2b). Reads the current
 *  ttsVoice mapping from localStorage, applies the patch (null clears
 *  · string sets · omitted preserves), then PUTs the full mapping
 *  along with all other modelTier sub-trees so the daemon's whole-
 *  cloth merge doesn't clobber siblings. */
export async function pushTtsVoiceMappingToDaemon(
  cfg: DaemonHttpConfig,
  patch: TtsVoiceMappingPatch,
): Promise<SyncStatus> {
  if (!cfg.baseUrl) return 'offline';

  const STORAGE_KEY = 'elanous.tts-voice-map';
  let current: TtsVoiceMappingWire = {};
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) current = JSON.parse(raw) as TtsVoiceMappingWire;
    } catch { /* corrupt · treat as empty */ }
  }
  const next: TtsVoiceMappingWire = { ...current };
  for (const ctx of ['default', 'chat', 'digest', 'alert', 'discord'] as const) {
    if (ctx in patch) {
      const v = patch[ctx];
      if (v === null || v === undefined || v.trim() === '') delete next[ctx];
      else next[ctx] = v.trim();
    }
  }

  // Re-send STT/LLM/TTS so the whole-cloth merge keeps them.
  const local = loadModelTierPrefs();
  const voice: NonNullable<NonNullable<ModelTierPutWire['modelTier']>['voice']> = {};
  if (local.stt) voice.stt = local.stt;
  if (local.tts) voice.tts = local.tts;
  if (Object.keys(next).length > 0) voice.ttsVoice = next;
  const modelTierBody: NonNullable<ModelTierPutWire['modelTier']> = {};
  if (Object.keys(voice).length > 0) modelTierBody.voice = voice;
  if (local.llm) modelTierBody.llm = local.llm;

  return putModelTier(cfg, {
    modelTier: Object.keys(modelTierBody).length === 0 ? null : modelTierBody,
  });
}

/** Apply a preset (M2-3). Writes preset.tiers · preset.ttsVoice ·
 *  preset.monthlyUsdCap in one PUT · marks `modelTier.preset = <id>`
 *  so subsequent visits can show "Active preset: …".
 *
 *  Null preset = clear preset + leave individual tiers as-is. To fully
 *  reset to Smart defaults, call this with `null` then `resetAll()`
 *  on each card. */
export async function pushPresetToDaemon(
  cfg: DaemonHttpConfig,
  preset: {
    id: string;
    tiers: { stt?: ModelTier; tts?: ModelTier; llm?: ModelTier };
    ttsVoice?: TtsVoiceMappingWire;
    monthlyUsdCap?: number;
  } | null,
): Promise<SyncStatus> {
  if (!cfg.baseUrl) return 'offline';

  if (preset === null) {
    // Clear preset only · preserve other sub-trees.
    const local = loadModelTierPrefs();
    const body: NonNullable<ModelTierPutWire['modelTier']> = {};
    const voice: NonNullable<NonNullable<ModelTierPutWire['modelTier']>['voice']> = {};
    if (local.stt) voice.stt = local.stt;
    if (local.tts) voice.tts = local.tts;
    if (Object.keys(voice).length > 0) body.voice = voice;
    if (local.llm) body.llm = local.llm;
    // Important: preset field cleared via undefined (the daemon
    // validator drops absent keys). To force a clear we'd PUT
    // modelTier:null but that wipes everything; preserving siblings
    // means we just don't include preset here.
    return putModelTier(cfg, {
      modelTier: Object.keys(body).length === 0 ? null : body,
    });
  }

  // Apply: write tier slots from preset · also persist preset.id for
  // the "Active preset: …" banner.
  saveModelTierPrefs({
    stt: preset.tiers.stt,
    tts: preset.tiers.tts,
    llm: preset.tiers.llm,
  });

  // Voice id storage is in a separate localStorage key.
  if (preset.ttsVoice && typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem('elanous.tts-voice-map', JSON.stringify(preset.ttsVoice));
    } catch { /* quota */ }
  }

  const local = loadModelTierPrefs();
  const voice: NonNullable<NonNullable<ModelTierPutWire['modelTier']>['voice']> = {};
  if (local.stt) voice.stt = local.stt;
  if (local.tts) voice.tts = local.tts;
  if (preset.ttsVoice && Object.keys(preset.ttsVoice).length > 0) {
    voice.ttsVoice = preset.ttsVoice;
  }
  const modelTierBody: NonNullable<ModelTierPutWire['modelTier']> = {
    preset: preset.id,
  };
  if (Object.keys(voice).length > 0) modelTierBody.voice = voice;
  if (local.llm) modelTierBody.llm = local.llm;

  const body: ModelTierPutWire = { modelTier: modelTierBody };
  if (preset.monthlyUsdCap !== undefined) {
    body.budget = { monthlyUsdCap: preset.monthlyUsdCap };
  }
  return putModelTier(cfg, body);
}

/** Push the monthly USD cap (or clear it). Same optimistic semantics. */
export async function pushMonthlyCapToDaemon(
  cfg: DaemonHttpConfig,
  capUsd: number | null,
): Promise<SyncStatus> {
  const body: ModelTierPutWire = capUsd === null
    ? { budget: null }
    : { budget: { monthlyUsdCap: capUsd } };
  return putModelTier(cfg, body);
}
