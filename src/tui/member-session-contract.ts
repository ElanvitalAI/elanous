import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** The app-auth handoff stores its private session beside the local config. */
export function tuiMemberSessionPath(configDir: string, explicitPath?: string): string {
  return explicitPath?.trim() || join(configDir, 'member-session.json');
}

export interface TuiMemberSession {
  readonly nexusUrl: string;
  readonly sessionToken: string;
  readonly appSlug?: string;
}

/** Read only a Nexus-issued app session from a private file. */
export function readTuiMemberSession(path: string | undefined, now = Date.now()): TuiMemberSession | undefined {
  if (!path || !isAbsolute(path)) return undefined;
  try {
    const stat = lstatSync(path);
    // 출처: #5257 — 작은 단일 세션 봉투만 읽고 임의의 큰 파일은 거부한다.
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4_096
      || (process.getuid && stat.uid !== process.getuid())) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const row = parsed as Record<string, unknown>;
    if (Object.keys(row).some(key => !['nexusUrl', 'sessionToken', 'expiresAt', 'appSlug'].includes(key))) return undefined;
    if (typeof row.nexusUrl !== 'string' || typeof row.sessionToken !== 'string'
      || typeof row.expiresAt !== 'string' || !/^aps_[A-Za-z0-9_-]+$/.test(row.sessionToken)
      || !Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) <= now) return undefined;
    const url = new URL(row.nexusUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined;
    if (url.username || url.password || url.hash) return undefined;
    if (row.appSlug !== undefined && (typeof row.appSlug !== 'string' || !/^[a-z0-9-]{1,100}$/.test(row.appSlug))) return undefined;
    return { nexusUrl: url.origin, sessionToken: row.sessionToken,
      ...(typeof row.appSlug === 'string' ? { appSlug: row.appSlug } : {}) };
  } catch { return undefined; }
}
