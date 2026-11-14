import { linkSync, lstatSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readTuiMemberSession, tuiMemberSessionPath } from '../tui/member-session-contract.js';

const TOKEN = /^aps_[A-Za-z0-9_-]+$/;
const APP_SLUG = /^[a-z0-9-]{1,100}$/;
const OFFICIAL_MEMBER_ORIGIN = 'https://api.elanous.ai';

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
export async function connectApprovedMemberSession(input: ApprovedMemberHandoff): Promise<{ expiresAt: string }> {
  let endpoint: URL;
  try {
    endpoint = new URL(input.nexusUrl);
    if (endpoint.origin !== OFFICIAL_MEMBER_ORIGIN || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
      throw new Error('invalid origin');
    }
  } catch { throw new Error('회원 서비스 주소가 올바르지 않습니다.'); }
  if (!isAbsolute(input.configDir)) throw new Error('회원 연결 저장 경로가 올바르지 않습니다.');
  let directory: ReturnType<typeof lstatSync>;
  try { directory = lstatSync(input.configDir); }
  catch { throw new Error('회원 연결 저장 경로가 없습니다.'); }
  if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid())
    || (directory.mode & 0o022) !== 0) throw new Error('회원 연결 저장 경로가 안전하지 않습니다.');
  if ([input.code, input.state, input.codeVerifier].some(value => typeof value !== 'string'
    || !value || value.length > 128)) throw new Error('승인된 회원 연결 정보가 올바르지 않습니다.');

  const destination = tuiMemberSessionPath(input.configDir);
  try {
    lstatSync(destination);
    throw new Error('이미 회원 연결이 있습니다. 기존 연결을 먼저 확인해 주세요.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const origin = endpoint.origin;
  const fetchImpl = input.fetchImpl ?? fetch;
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
  try {
    // A hard link publishes complete bytes atomically and refuses an existing session.
    writeFileSync(temporary, JSON.stringify({ nexusUrl: origin, sessionToken, expiresAt, appSlug }),
      { flag: 'wx', mode: 0o600 });
    const publishNow = input.now?.() ?? Date.now();
    if (Date.parse(expiresAt) <= publishNow || !readTuiMemberSession(temporary, publishNow)) {
      throw new Error('invalid private envelope');
    }
    linkSync(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('이미 회원 연결이 있습니다. 기존 연결을 먼저 확인해 주세요.');
    throw new Error('회원 연결을 안전하게 저장하지 못했습니다.');
  } finally {
    try { unlinkSync(temporary); } catch { /* temporary file may not have been created */ }
  }
  return { expiresAt };
}
