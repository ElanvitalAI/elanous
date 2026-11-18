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

type Envelope = { session: TuiMemberSession; expiresAtMs: number; dev: number; ino: number };

/** Private envelope rules shared by the reader and the token-free inspector; expiry is the caller's. */
function readEnvelope(path: string): Envelope | undefined {
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
      || !Number.isFinite(Date.parse(row.expiresAt))) return undefined;
    const url = new URL(row.nexusUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined;
    if (url.username || url.password || url.hash) return undefined;
    if (row.appSlug !== undefined && (typeof row.appSlug !== 'string' || !/^[a-z0-9-]{1,100}$/.test(row.appSlug))) return undefined;
    return { session: { nexusUrl: url.origin, sessionToken: row.sessionToken,
      ...(typeof row.appSlug === 'string' ? { appSlug: row.appSlug } : {}) },
    expiresAtMs: Date.parse(row.expiresAt), dev: stat.dev, ino: stat.ino };
  } catch { return undefined; }
}

/** Read only a Nexus-issued app session from a private file. */
export function readTuiMemberSession(path: string | undefined, now = Date.now()): TuiMemberSession | undefined {
  if (!path || !isAbsolute(path)) return undefined;
  const envelope = readEnvelope(path);
  return envelope && envelope.expiresAtMs > now ? envelope.session : undefined;
}

/** Token-free classification: what a new connect may replace and how long a build may rely on it. */
export type TuiMemberSessionFileState =
  | { readonly state: 'missing' }
  | { readonly state: 'unsafe' }
  | { readonly state: 'expired' | 'valid'; readonly appSlug?: string; readonly expiresAtMs: number;
    readonly remainingMs: number; readonly dev: number; readonly ino: number };

export function inspectTuiMemberSessionFile(path: string | undefined, now = Date.now()): TuiMemberSessionFileState {
  if (!path || !isAbsolute(path)) return { state: 'unsafe' };
  try { lstatSync(path); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'unsafe' }; }
  const envelope = readEnvelope(path);
  if (!envelope) return { state: 'unsafe' };
  return { state: envelope.expiresAtMs > now ? 'valid' : 'expired',
    ...(envelope.session.appSlug ? { appSlug: envelope.session.appSlug } : {}),
    expiresAtMs: envelope.expiresAtMs, remainingMs: envelope.expiresAtMs - now, dev: envelope.dev, ino: envelope.ino };
}
