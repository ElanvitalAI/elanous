import { linkSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectTuiMemberSessionFile, readTuiMemberSession, tuiMemberSessionPath } from '../tui/member-session-contract.js';
import { connectMemberRelay } from './member-connect-relay.js';
import { debug } from '../debug/log.js';
import { withFileLockSync } from '../storage/file-lock.js';

const TOKEN = /^aps_[A-Za-z0-9_-]+$/;
const APP_SLUG = /^[a-z0-9-]{1,100}$/;
const OFFICIAL_MEMBER_ORIGIN = 'https://api.elanous.ai';

const OCCUPIED = '이미 회원 연결이 있습니다. 기존 연결을 먼저 확인해 주세요.';

/** A session the server still accepts is never replaced; the message names only its app slug and minutes, never the token. */
export class MemberSessionOccupiedError extends Error {
  constructor(readonly appSlug: string | undefined, readonly remainingMinutes: number) {
    super(`이미 회원 연결이 유효합니다 (${appSlug ? `앱 ${appSlug} · ` : ''}잔여 ${remainingMinutes}분). `
      + '기존 연결은 그대로 둡니다. 바꾸려면 elanous member disconnect 뒤 다시 연결해 주세요.');
    this.name = 'MemberSessionOccupiedError';
  }
}

export interface ApprovedMemberHandoff {
  readonly nexusUrl: string;
  readonly configDir: string;
  /** Values delivered by the allowlisted app-login callback, never CLI arguments or logs. */
  readonly code: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/** Consume a server-issued PKCE handoff and persist only its verified app session. */
export async function connectApprovedMemberSession(input: ApprovedMemberHandoff): Promise<{ expiresAt: string; relayKeyUnavailable?: true }> {
  let endpoint: URL;
  try {
    endpoint = new URL(input.nexusUrl);
    if (endpoint.origin !== OFFICIAL_MEMBER_ORIGIN || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
      throw new Error('invalid origin');
    }
  } catch { throw new Error('회원 서비스 주소가 올바르지 않습니다.'); }
  if (!isAbsolute(input.configDir)) throw new Error('회원 연결 저장 경로가 올바르지 않습니다.');
  let directory: Stats;
  try { directory = lstatSync(input.configDir); }
  catch { throw new Error('회원 연결 저장 경로가 없습니다.'); }
  if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid())
    || (directory.mode & 0o022) !== 0) throw new Error('회원 연결 저장 경로가 안전하지 않습니다.');
  if ([input.code, input.state, input.codeVerifier].some(value => typeof value !== 'string'
    || !value || value.length > 128)) throw new Error('승인된 회원 연결 정보가 올바르지 않습니다.');

  const destination = tuiMemberSessionPath(input.configDir);
  const origin = endpoint.origin;
  const fetchImpl = input.fetchImpl ?? fetch;
  // A stale session (expired, unreadable, or rejected by the server, e.g. after an app rename)
  // may be replaced; a session the server still accepts, or one we cannot check, is kept.
  let replaceStale = false;
  let existing: Stats | undefined;
  try { existing = lstatSync(destination); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (existing) {
    if (!(await existingSessionIsStale(destination, existing, origin, fetchImpl, input.now?.() ?? Date.now()))) {
      // APP-BUILD-SESSION-REFRESH: name the still-valid session (slug + minutes, never the token) and the way out.
      const kept = inspectTuiMemberSessionFile(destination, input.now?.() ?? Date.now());
      if (kept.state === 'valid') throw new MemberSessionOccupiedError(kept.appSlug, Math.floor(kept.remainingMs / 60_000));
      throw new Error(OCCUPIED);
    }
    replaceStale = true;
  }

  let exchanged: Response;
  try {
    exchanged = await fetchImpl(`${origin}/v1/members/app-slot/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code: input.code, state: input.state, codeVerifier: input.codeVerifier }),
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new Error('회원 연결을 확인하지 못했습니다. 다시 로그인해 주세요.'); }
  if (!exchanged.ok) {
    if (exchanged.status === 503) {
      let error: unknown;
      try { error = (await exchanged.json() as { error?: unknown }).error; } catch { /* generic outage */ }
      throw new Error(error === 'members-not-configured'
        ? '회원 서비스가 설정되지 않았습니다. 설치 관리자에게 설정을 요청해 주세요.'
        : '회원 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    }
    throw new Error('회원 연결이 만료되었거나 거부되었습니다. 다시 로그인해 주세요.');
  }
  let reply: unknown;
  try { reply = await exchanged.json(); } catch { throw new Error('회원 연결 응답이 올바르지 않습니다.'); }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('회원 연결 응답이 올바르지 않습니다.');
  const record = reply as Record<string, unknown>;
  const appSlot = record.appSlot && typeof record.appSlot === 'object' && !Array.isArray(record.appSlot)
    ? record.appSlot as Record<string, unknown> : null;
  const sessionToken = record.sessionToken;
  const expiresAt = record.expiresAt;
  const appSlug = appSlot?.appSlug;
  const now = input.now?.() ?? Date.now();
  if (typeof sessionToken !== 'string' || !TOKEN.test(sessionToken)
    || typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now
    || typeof appSlug !== 'string' || !APP_SLUG.test(appSlug)) {
    throw new Error('회원 연결 응답이 올바르지 않습니다.');
  }

  let verified: Response;
  try {
    verified = await fetchImpl(`${origin}/v1/members/owner?appSlug=${encodeURIComponent(appSlug)}`, {
      method: 'GET', headers: { authorization: `Bearer ${sessionToken}`, accept: 'application/json' },
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new Error('회원 소유자를 확인하지 못했습니다. 다시 로그인해 주세요.'); }
  if (!verified.ok) throw new Error('회원 소유자를 확인하지 못했습니다. 다시 로그인해 주세요.');
  let owner: unknown;
  try { owner = await verified.json(); } catch { throw new Error('회원 소유자 응답이 올바르지 않습니다.'); }
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)
    || typeof (owner as Record<string, unknown>).memberId !== 'string'
    || !(owner as { memberId: string }).memberId.trim()) throw new Error('회원 소유자 응답이 올바르지 않습니다.');

  const temporary = join(input.configDir, `.member-session-${randomUUID()}.json`);
  let relayKeyUnavailable = false;
  try {
    // A hard link publishes complete bytes atomically and refuses an existing session.
    writeFileSync(temporary, JSON.stringify({ nexusUrl: origin, sessionToken, expiresAt, appSlug }),
      { flag: 'wx', mode: 0o600 });
    const publishNow = input.now?.() ?? Date.now();
    if (Date.parse(expiresAt) <= publishNow || !readTuiMemberSession(temporary, publishNow)) {
      throw new Error('invalid private envelope');
    }
    // APP-BUILD-SESSION-REFRESH: one advisory lock spans the recheck and publication, so two connects
    // (or a disconnect) cannot both pass the recheck and let the later rename overwrite a fresh session.
    withFileLockSync(sessionLockPath(destination), () => {
      if (!replaceStale) { linkSync(temporary, destination); return; }
      // The stale file must still be the regular file we judged stale; never rename over a link.
      const current = lstatSync(destination);
      if (!current.isFile() || current.ino !== existing!.ino) throw Object.assign(new Error('changed'), { code: 'EEXIST' });
      renameSync(temporary, destination);
      // member-session.refreshed: reason and app slug only — never the token.
      debug.log('member-session', 'refreshed', { reason: 'stale-replaced', appSlug }, { level: 'info' });
    }, { breakDeadHolder: true });
    try { await connectMemberRelay({ configDir: input.configDir, sessionToken, fetchImpl }); }
    catch {
      // Relay enrollment is optional. Its failure must not undo an already
      // exchanged, owner-verified and privately published member session.
      relayKeyUnavailable = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(OCCUPIED);
    throw new Error('회원 연결을 안전하게 저장하지 못했습니다.');
  } finally {
    try { unlinkSync(temporary); } catch { /* temporary file may not have been created */ }
  }
  return { expiresAt, ...(relayKeyUnavailable ? { relayKeyUnavailable: true as const } : {}) };
}

/** True only when the stored session is provably unusable; any doubt keeps the existing session. */
async function existingSessionIsStale(
  destination: string, stat: Stats, origin: string, fetchImpl: typeof fetch, now: number,
): Promise<boolean> {
  if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) return false;
  const stored = readTuiMemberSession(destination, now);
  if (!stored) return isExpiredEnvelope(destination, stat, now); // only a well-formed, expired envelope; anything else is kept
  if (stored.nexusUrl !== origin) return false;
  try {
    const query = stored.appSlug ? `?appSlug=${encodeURIComponent(stored.appSlug)}` : '';
    const reply = await fetchImpl(`${origin}/v1/members/owner${query}`, {
      method: 'GET', headers: { authorization: `Bearer ${stored.sessionToken}`, accept: 'application/json' },
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
    return reply.status === 401;
  } catch { return false; }
}

function isExpiredEnvelope(path: string, stat: Stats, now: number): boolean {
  if (stat.size > 4_096 || (stat.mode & 0o077) !== 0) return false;
  try {
    const row = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return !!row && typeof row === 'object' && !Array.isArray(row)
      && Object.keys(row).every(key => ['nexusUrl', 'sessionToken', 'expiresAt', 'appSlug'].includes(key))
      && typeof row.nexusUrl === 'string' && new URL(row.nexusUrl).origin.length > 0
      && (row.appSlug === undefined || (typeof row.appSlug === 'string' && APP_SLUG.test(row.appSlug)))
      && typeof row.sessionToken === 'string' && TOKEN.test(row.sessionToken)
      && typeof row.expiresAt === 'string' && Date.parse(row.expiresAt) <= now;
  } catch { return false; }
}

const sessionLockPath = (destination: string) => destination + '.lock';

/** Explicit owner action: remove this machine's private member session (valid or expired) so a new
 * connect can follow. Unsafe/linked/malformed files are refused untouched; the token is never read out. */
export function disconnectMemberSession(configDir: string, now = Date.now()): { removed: boolean; appSlug?: string } {
  if (!isAbsolute(configDir)) throw new Error('회원 연결 저장 경로가 올바르지 않습니다.');
  const destination = tuiMemberSessionPath(configDir);
  return withFileLockSync(sessionLockPath(destination), () => {
    const current = inspectTuiMemberSessionFile(destination, now);
    if (current.state === 'missing') return { removed: false };
    if (current.state === 'unsafe') throw new Error('회원 연결 파일을 안전하게 확인하지 못했습니다. 파일 권한과 링크를 확인해 주세요.');
    unlinkSync(destination);
    debug.log('member-session', 'disconnected', { appSlug: current.appSlug ?? null, expired: current.state === 'expired' }, { level: 'info' });
    return { removed: true, ...(current.appSlug ? { appSlug: current.appSlug } : {}) };
  }, { breakDeadHolder: true });
}
