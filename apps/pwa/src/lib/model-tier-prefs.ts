// M1-2 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1) —
// PWA-side persistence for STT tier slider.
//
// Storage shape (`localStorage` key `elanous.model-tier.prefs`):
//   { stt: 'balanced' }   // ModelTier or absent
//   audioMinPerDay: 0     // user's recent daily average (M3 14-day rolling)
//
// MVP scope: PWA-local. Cross-device sync (writing to
// `~/.elanous/config.json` via NEXUS) lands in M1-2b once the daemon
// gains a root-level user-config write endpoint. The slider UI today
// reads/writes localStorage so the friction-reducer ships before the
// transport ceremony.

import { DEFAULT_MODEL_TIER, isModelTier, type ModelTier } from './model-tier-spec';

const STORAGE_KEY = 'elanous.model-tier.prefs';

export interface ModelTierPrefs {
  /** STT tier the user has selected. Sparse — `undefined` means
   *  "fall through to DEFAULT_MODEL_TIER". The card surfaces this
   *  difference: an explicit selection shows "Saved", a fall-through
   *  shows "Smart default (Balanced)". */
  stt?: ModelTier;
  /** LLM tier (M2-1 · Phase 2). Same sparse semantics as `stt`. */
  llm?: ModelTier;
  /** TTS tier (M2-2 · Phase 2). Same sparse semantics. */
  tts?: ModelTier;
  /** User's recent daily-average audio minutes — used to power the
   *  slider's live monthly-cost tooltip without re-fetching the cost
   *  tracker on every drag. Updated by the cost subscriber when the
   *  user records new STT calls. Defaults to 0 (no projection). */
  audioMinPerDay: number;
}

export const DEFAULT_MODEL_TIER_PREFS: ModelTierPrefs = {
  audioMinPerDay: 0,
};

function clampMinPerDay(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  // Cap at 24h/day to defend against bad recorder state polluting the
  // projection — anything higher is a bug, not a user signal.
  return Math.min(v, 24 * 60);
}

/** Load prefs from localStorage. SSR-safe · corrupt JSON / missing
 *  keys → defaults. Never throws. */
export function loadModelTierPrefs(): ModelTierPrefs {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return { ...DEFAULT_MODEL_TIER_PREFS };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MODEL_TIER_PREFS };
    const parsed = JSON.parse(raw) as Partial<ModelTierPrefs>;
    return {
      stt: isModelTier(parsed.stt) ? parsed.stt : undefined,
      llm: isModelTier(parsed.llm) ? parsed.llm : undefined,
      tts: isModelTier(parsed.tts) ? parsed.tts : undefined,
      audioMinPerDay: clampMinPerDay(parsed.audioMinPerDay),
    };
  } catch {
    return { ...DEFAULT_MODEL_TIER_PREFS };
  }
}

/** Persist prefs (partial merge with current). SSR-safe. Storage
 *  failures swallowed — pref loss is not user-fatal. */
export function saveModelTierPrefs(patch: Partial<ModelTierPrefs>): ModelTierPrefs {
  const current = loadModelTierPrefs();
  const next: ModelTierPrefs = {
    stt: patch.stt === undefined ? current.stt : (isModelTier(patch.stt) ? patch.stt : undefined),
    llm: patch.llm === undefined ? current.llm : (isModelTier(patch.llm) ? patch.llm : undefined),
    tts: patch.tts === undefined ? current.tts : (isModelTier(patch.tts) ? patch.tts : undefined),
    audioMinPerDay: patch.audioMinPerDay === undefined
      ? current.audioMinPerDay
      : clampMinPerDay(patch.audioMinPerDay),
  };
  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* quota / private mode — ignore */
    }
  }
  return next;
}

/** Clear the user's tier override · returns to "Smart default". */
export function resetModelTierPrefs(): ModelTierPrefs {
  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
  return { ...DEFAULT_MODEL_TIER_PREFS };
}

/** Active STT tier — explicit selection if set, otherwise the zero-
 *  config default. */
export function activeSttTier(prefs: ModelTierPrefs): ModelTier {
  return prefs.stt ?? DEFAULT_MODEL_TIER;
}

/** Active LLM tier — same semantics as `activeSttTier` (M2-1). */
export function activeLlmTier(prefs: ModelTierPrefs): ModelTier {
  return prefs.llm ?? DEFAULT_MODEL_TIER;
}

/** Active TTS tier (M2-2). */
export function activeTtsTier(prefs: ModelTierPrefs): ModelTier {
  return prefs.tts ?? DEFAULT_MODEL_TIER;
}
