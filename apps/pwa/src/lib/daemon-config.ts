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
import { BARE_CAPABILITIES_META_NAME, BARE_WEBCHAT_FORWARDED_API_PATHS, BARE_WEBCHAT_SESSION_ITEM_CAPABILITY, parseBareCapabilities } from '../../../../src/relay/bare-surface';

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

/**
 * MK #109711 — relay bare webchat origin (`<handle>.elanous.app/app/chat/`).
 * The relay tunnels only the chat REST/SSE pair there (no WS upgrade for
 * `/v1/acp`), so chat must use SSE (`POST /v1/prompt/stream`) instead of ACP.
 * Signal is SERVER-DELIVERED, not a hostname guess: Nexus
 * `routeBareWebChatHostRequest` injects `<meta name="elanous-bare-webchat"
 * content="1">` into the /app/chat HTML it serves on a pinned bare origin.
 * Daemon-direct origins never carry the tag.
 */
export const BARE_WEBCHAT_META_NAME = 'elanous-bare-webchat';
export function isBareWebChatOrigin(
  doc: Pick<Document, 'querySelector'> | undefined =
    typeof document === 'undefined' ? undefined : document,
): boolean {
  if (!doc || typeof doc.querySelector !== 'function') return false;
  try {
    return doc.querySelector(`meta[name="${BARE_WEBCHAT_META_NAME}"]`)?.getAttribute('content') === '1';
  } catch {
    return false;
  }
}

/**
 * OP #113435 — what the bare surface forwards, SERVER-DELIVERED (the same
 * channel as the bare meta). Not bare (no bare meta) => everything is
 * forwarded (daemon-direct, unchanged). Bare => only the paths in the
 * `elanous-bare-capabilities` meta (a bare meta WITHOUT it fails closed).
 * Single source of the set: src/relay/bare-surface.ts. Gated centrally in
 * DaemonClient and the debug forwarder — pollers carry no bare check.
 */
export function surfaceForwards(
  path: string,
  doc: Pick<Document, 'querySelector'> | undefined =
    typeof document === 'undefined' ? undefined : document,
): boolean {
  if (!isBareWebChatOrigin(doc)) return true;
  let content: string | null | undefined;
  try {
    content = doc?.querySelector(`meta[name="${BARE_CAPABILITIES_META_NAME}"]`)?.getAttribute('content');
  } catch {
    content = undefined;
  }
  const pathname = path.split('?')[0]!.split('#')[0]!;
  // A bare host whose HTML carries the bare meta but no capabilities meta (an older Nexus) falls back to the shared
  // default set: pollers stay gated and the chat pair keeps working — never a dead chat.
  const forwarded: readonly string[] = content == null ? BARE_WEBCHAT_FORWARDED_API_PATHS : parseBareCapabilities(content);
  return forwarded.includes(pathname)
    || (forwarded.includes(BARE_WEBCHAT_SESSION_ITEM_CAPABILITY) && /^\/v1\/sessions\/store\/[^/]+$/.test(pathname));
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
  // 출처: #39459 — 명시적 빈 `elanous.daemon.token`(«다시 연결»이 저장)은
  // «토큰 없음»의 확정 상태다. 이주 폴백은 키 부재(null)에만 달리붙게
  // 해서, 남은 레거시 elanous.voice.token 이 거부된 옛 토큰을 되살리는
  // 일을 막는다(JUD-B #124629 기능 HOLD — 복원 차단).
  const legacyVoiceToken = localStorage.getItem(LEGACY_KEYS.voiceToken);
  if (legacyVoiceToken && localStorage.getItem(STORAGE_KEYS.token) === null) {
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

/**
 * 출처: #39459 — «다시 연결»(reconnectRejectedDevice) 전용: 원샷 이주가 남긴
 * 레거시 elanous.voice.token 까지 지운다. 남겨두면 재로드 때 loadDaemonConfig
 * 의 이주 경로가 거부된 옛 토큰을 되살린다(JUD-B #124629 기능 HOLD).
 */
export function clearLegacyVoiceToken(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(LEGACY_KEYS.voiceToken);
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
