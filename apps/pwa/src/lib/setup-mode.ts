import type { NexusHealth } from '@/nexus/types';

const BANNER_BASE = '셋업 모드 — 먼저 LLM 을 정하세요';

function isSetupPath(pathname: string): boolean {
  return pathname === '/setup' || pathname.startsWith('/setup/');
}

/**
 * Send the first screen to `/setup` only when the daemon is in setup mode
 * and the user is exactly on `/`. Missing or false `setupMode` (old daemons)
 * always returns null so the screen does not change.
 */
export function setupModeRedirect(
  health: NexusHealth | null | undefined,
  pathname: string,
): '/setup' | null {
  if (health?.setupMode !== true) return null;
  if (pathname !== '/') return null;
  return '/setup';
}

/**
 * Banner copy for every screen that is not already under `/setup`.
 * Missing or false `setupMode` always returns null.
 */
export function setupModeBannerText(
  health: NexusHealth | null | undefined,
  pathname: string,
): string | null {
  if (health?.setupMode !== true) return null;
  if (isSetupPath(pathname)) return null;
  const missing = health.setupMissing;
  if (missing && missing.length > 0) {
    return `${BANNER_BASE} (${missing.join(', ')})`;
  }
  return BANNER_BASE;
}
