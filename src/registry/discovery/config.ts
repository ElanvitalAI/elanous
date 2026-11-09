// RFC #2161 Phase 6 FU · 2026-05-11 — discovery user-config resolver.
//
// The original Phase 6 follow-ups (#2206 omni-crawl bridge · #2209 cron
// scheduler) wired their behaviour to ELANOUS_* env vars directly. That
// violated the "신규 옵션은 user-config 만 노출" rule
// (`내부 문서 `MANUAL-user-config`` §2 · memory
// `feedback_user_config_over_env.md`). This module is the canonical
// resolver — call sites read here, never from process.env directly.
//
// Resolution priority (mirrors the project-wide convention):
//   user-config 의 명시된 값  >  환경변수 (legacy fallback)  >  default
//
// Schema lives at `cfg.registry.discovery.{cron, firecrawl}` (see
// `src/user-config.ts:RegistryConfig`). The omni-crawl bridge config
// branch was removed in P4 when its source was retired entirely.

import { getUserConfig } from '../../user-config.js';
import type { UserConfig } from '../../user-config/types.js';

const CRON_MIN_MS = 60_000;          // 1 minute floor (matches cron.ts clamp)
const CRON_MAX_MS = 86_400_000;      // 24 hour ceiling (matches cron.ts clamp)

export interface ResolvedDiscoveryCronConfig {
  /** Tick interval (ms). 0 = dormant (cron disabled). Clamped to
   *  [60_000, 86_400_000] when non-zero. */
  intervalMs: number;
}

export interface ResolvedFirecrawlConfig {
  /** Firecrawl API key. Empty string = unconfigured (source returns
   *  `missing-api-key`). */
  apiKey: string;
}

function readEnv(name: string): string {
  const raw = process.env[name];
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

/** Resolve Firecrawl config. user-config wins; falls back to legacy
 *  env (`FIRECRAWL_API_KEY`); else empty (source returns
 *  `missing-api-key`). The CLI binary check is separate — see
 *  `firecrawl-crawl.ts:isFirecrawlCliAvailable`. */
export function getFirecrawlConfig(cfg?: UserConfig): ResolvedFirecrawlConfig {
  const userCfg = cfg ?? getUserConfig();
  const fromConfig = (userCfg.registry.discovery.firecrawl.apiKey ?? '').trim();
  return {
    apiKey: fromConfig || readEnv('FIRECRAWL_API_KEY'),
  };
}

/** Resolve discovery cron config. user-config wins; falls back to
 *  legacy env (`ELANOUS_DISCOVERY_CRON_INTERVAL_MS`); else 0 (dormant).
 *  Non-zero values are clamped to [60s, 24h] to match the cron.ts
 *  scheduler's own clamp (defensive — the scheduler also clamps). */
export function getDiscoveryCronConfig(cfg?: UserConfig): ResolvedDiscoveryCronConfig {
  const userCfg = cfg ?? getUserConfig();
  const fromConfig = userCfg.registry.discovery.cron.intervalMs;
  let raw = typeof fromConfig === 'number' && Number.isFinite(fromConfig) && fromConfig > 0
    ? fromConfig
    : 0;
  if (raw === 0) {
    const envRaw = readEnv('ELANOUS_DISCOVERY_CRON_INTERVAL_MS');
    if (envRaw.length > 0) {
      const parsed = Number(envRaw);
      if (Number.isFinite(parsed) && parsed > 0) raw = parsed;
    }
  }
  if (raw === 0) return { intervalMs: 0 };
  const clamped = Math.max(CRON_MIN_MS, Math.min(CRON_MAX_MS, Math.round(raw)));
  return { intervalMs: clamped };
}
