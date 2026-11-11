// Owner-side snapshots for subscription CLIs. Only access credentials cross hosts.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ProviderAccessMirror = { provider: 'grok' | 'claude'; access: string; expiresAt: number; userId?: string; scopes?: string[] };
const MIN_LIFETIME_MS = 2 * 60 * 60_000;

function json(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function expiry(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return NaN;
}

/** Unknown/near expiry is skipped. The owner remains the only refresh authority. */
export function collectProviderAccessMirrors(opts: { home?: string; now?: number } = {}): ProviderAccessMirror[] {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const mirrors: ProviderAccessMirror[] = [];
  const grok = json(join(home, '.grok', 'auth.json'));
  if (grok) {
    const scopes = Object.values(grok).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
    const best = scopes.filter((s) => typeof s.key === 'string' && s.key.length > 0 && expiry(s.expires_at) > now + MIN_LIFETIME_MS)
      .sort((a, b) => expiry(b.expires_at) - expiry(a.expires_at))[0];
    if (best) mirrors.push({ provider: 'grok', access: best.key as string, expiresAt: expiry(best.expires_at),
      ...(typeof best.user_id === 'string' ? { userId: best.user_id } : {}) });
  }
  const claude = json(join(home, '.claude', '.credentials.json'));
  const oauth = claude?.claudeAiOauth;
  if (oauth && typeof oauth === 'object' && !Array.isArray(oauth)) {
    const record = oauth as Record<string, unknown>;
    const expiresAt = expiry(record.expiresAt);
    if (typeof record.accessToken === 'string' && record.accessToken && expiresAt > now + MIN_LIFETIME_MS) {
      mirrors.push({ provider: 'claude', access: record.accessToken, expiresAt,
        ...(Array.isArray(record.scopes) ? { scopes: record.scopes.filter((s): s is string => typeof s === 'string') } : {}) });
    }
  }
  return mirrors;
}
