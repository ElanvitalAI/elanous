/**
 * NEXUS connection config — wsUrl/baseUrl/token/provider.
 * Source of truth: localStorage (PWA-scoped) + URL ?override.
 *
 * Storage keys (NEXUS N-1.5 PR a · v6 cutover · 2026-05-06):
 *   elanous.nexus.baseUrl    → REST + WS host (e.g. https://mbp.tailnet.ts.net:31415)
 *   elanous.daemon.token     → bearer
 *   elanous.daemon.provider  → optional family default (claude/gemini/grok/codex)
 *
 * Legacy keys auto-migrated (one-shot, drop after copy):
 *   elanous.daemon.baseUrl   → elanous.nexus.baseUrl  (NEXUS = SSoT post-cutover)
 *   elanous.voice.wsUrl      → elanous.nexus.baseUrl  (re-rooted via URL transform)
 *   elanous.voice.token      → elanous.daemon.token
 *
 * Token / provider keys keep the `elanous.daemon.*` prefix until PR i
 * (NexusProvider mount + daemon-client.ts retire) which renames the
 * full surface. Storage keys are user-device-bound; bundling the
 * rename under one PR keeps the migration window short.
 */

import { migrateBaseUrl } from './migrate-base-url';

const STORAGE_KEYS = {
  baseUrl: 'elanous.nexus.baseUrl',
  token: 'elanous.daemon.token',
  provider: 'elanous.daemon.provider',
  setupScopeExpiresAt: 'elanous.daemon.setupScopeExpiresAt',
} as const;

const LEGACY_KEYS = {
  daemonBaseUrl: 'elanous.daemon.baseUrl',
  voiceWsUrl: 'elanous.voice.wsUrl',
  voiceToken: 'elanous.voice.token',
} as const;

export interface DaemonConfig {
  baseUrl: string;
  token: string;
  provider: string;
}

export function defaultBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
  return `${proto}//${window.location.host}`;
}

function deriveWsUrl(baseUrl: string, path: string): string {
  if (!baseUrl) return '';
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function loadDaemonConfig(): DaemonConfig {
  if (typeof window === 'undefined') {
    return { baseUrl: '', token: '', provider: '' };
  }
  // PR a · v6 — daemon → nexus rename. Run before voice fallback so a
  // device with both legacy keys (rare) lands on the daemon-derived
  // value (newer of the two).
  migrateBaseUrl({
    legacyKey: LEGACY_KEYS.daemonBaseUrl,
    currentKey: STORAGE_KEYS.baseUrl,
  });
  // Pre-PR-a legacy: voice page wsUrl → daemon baseUrl form. Now
  // collapsed directly to nexus baseUrl via URL transform.
  migrateBaseUrl({
    legacyKey: LEGACY_KEYS.voiceWsUrl,
    currentKey: STORAGE_KEYS.baseUrl,
    transformValue: (raw) => {
      try {
        const u = new URL(raw);
        u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
        u.pathname = '/';
        return u.toString().replace(/\/$/, '');
      } catch {
        return null;
      }
    },
  });
  const legacyVoiceToken = localStorage.getItem(LEGACY_KEYS.voiceToken);
  if (legacyVoiceToken && !localStorage.getItem(STORAGE_KEYS.token)) {
    localStorage.setItem(STORAGE_KEYS.token, legacyVoiceToken);
  }
  // Empty-string check — `??` only fires on null/undefined. Without this,
  // a previously cleared baseUrl (or first-load empty value) would never
  // recover via `defaultBaseUrl()` and the user would see "Daemon 연결이
  // 설정되지 않았습니다" even when the PWA is served from the daemon's
  // own host.
  const storedBase = localStorage.getItem(STORAGE_KEYS.baseUrl);
  return {
    baseUrl: storedBase && storedBase.length > 0 ? storedBase : defaultBaseUrl(),
    token: localStorage.getItem(STORAGE_KEYS.token) ?? '',
    provider: localStorage.getItem(STORAGE_KEYS.provider) ?? '',
  };
}

export function saveDaemonConfig(cfg: Partial<DaemonConfig>): void {
  if (typeof window === 'undefined') return;
  if (cfg.baseUrl !== undefined) localStorage.setItem(STORAGE_KEYS.baseUrl, cfg.baseUrl);
  if (cfg.token !== undefined) localStorage.setItem(STORAGE_KEYS.token, cfg.token);
  if (cfg.provider !== undefined) localStorage.setItem(STORAGE_KEYS.provider, cfg.provider);
}

export function readSetupScope(): number | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEYS.setupScopeExpiresAt);
  if (raw === null) return null;
  const expiresAt = Number(raw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    clearSetupScope();
    return null;
  }
  return expiresAt;
}

export function clearSetupScope(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEYS.setupScopeExpiresAt);
}

export function buildAcpWsUrl(cfg: DaemonConfig): string {
  return deriveWsUrl(cfg.baseUrl, '/v1/acp');
}

export function buildVoiceWsUrl(cfg: DaemonConfig): string {
  return deriveWsUrl(cfg.baseUrl, '/v1/voice/ws');
}
