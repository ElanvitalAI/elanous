import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { issueTempToken, matchTempToken, revokeTempTokens } from '../auth/temp-tokens.js';

const COOKIE_NAME = '__Host-app-session';
const DEFAULT_INVITATION_TTL_MS = 15 * 60_000;
const DEFAULT_SESSION_TTL_MS = 60 * 60_000;

export interface FakeAppAuthOptions { readonly dir: string; readonly key?: string; readonly now?: () => number; readonly sessionTtlMs?: number }
export interface IssueInvitationInput { readonly appSlug: string; readonly invitedBy: string; readonly ttlMs?: number; readonly role?: string }
export interface IssuedInvitation { readonly token: string; readonly expiresAt: string; readonly appSlug: string; readonly invitedBy: string; readonly role: string }
export interface AppAuthResponse { readonly status: 200 | 401; readonly cookie?: string; readonly sessionToken?: string; readonly role?: string }
export interface AppSessionRecord { readonly appSlug: string; readonly invitedBy: string; readonly expiresAt: string; readonly role: string }
export type AppAuthAction = 'accept' | 'tamper' | 'cross-app' | 'session-cross-app' | 'expired' | 'session-expired' | 'revoke' | 'uninvited';
export interface AppAuthCaseInput { readonly action: AppAuthAction; readonly appSlug: string; readonly invitedBy: string; readonly ttlMs: number }
export interface AppAuthCookieExpectation { readonly hostPrefix: boolean; readonly secure: boolean; readonly pathRoot: boolean; readonly domain: boolean }
export interface AppAuthCaseExpectation {
  readonly status: 200 | 401;
  readonly invitedBy?: string;
  readonly sessionStatus?: 200 | 401;
  readonly sessionStatusAfterExpiry?: 200 | 401;
  readonly sessionStatusAfterRevoke?: 200 | 401;
  readonly crossAppSessionStatus?: 200 | 401;
  /** Session status when the issued `Set-Cookie` value itself is presented (not the side-channel token). */
  readonly cookieSessionStatus?: 200 | 401;
  readonly tamperedCookieSessionStatus?: 200 | 401;
  readonly crossAppCookieSessionStatus?: 200 | 401;
  readonly cookie?: AppAuthCookieExpectation;
}
export interface AppAuthContractCase { readonly name: string; readonly input: AppAuthCaseInput; readonly expected: AppAuthCaseExpectation }
export interface AppAuthContractSubject {
  issueInvitation(input: IssueInvitationInput): IssuedInvitation;
  acceptInvitation(input: { appSlug: string; token: string }): AppAuthResponse;
  verifySession(input: { appSlug: string; token: string }): AppAuthResponse;
  revokeSession(token: string): boolean;
  signUp(input: { appSlug: string }): AppAuthResponse;
  getSessionRecord(token: string): AppSessionRecord | null;
  advanceTime(ms: number): void;
}
export interface AppAuthContractPort { createCase(input: AppAuthCaseInput): AppAuthContractSubject }
export interface AppAuthContractResult { readonly name: string; readonly input: AppAuthCaseInput; readonly expected: AppAuthCaseExpectation; readonly actual: AppAuthCaseExpectation; readonly passed: boolean }

export const APP_AUTH_CONTRACT_CASES: readonly AppAuthContractCase[] = [
  { name: 'invitation acceptance creates a host-only session and records inviter', input: { action: 'accept', appSlug: 'notes', invitedBy: 'owner-17', ttlMs: 60_000 }, expected: { status: 200, invitedBy: 'owner-17', sessionStatus: 200, cookieSessionStatus: 200, tamperedCookieSessionStatus: 401, crossAppCookieSessionStatus: 401, cookie: { hostPrefix: true, secure: true, pathRoot: true, domain: false } } },
  { name: 'tampered invitation is rejected', input: { action: 'tamper', appSlug: 'notes', invitedBy: 'owner-17', ttlMs: 60_000 }, expected: { status: 401 } },
  { name: 'invitation is isolated to its app slug', input: { action: 'cross-app', appSlug: 'notes', invitedBy: 'owner-17', ttlMs: 60_000 }, expected: { status: 401 } },
  { name: 'session is isolated to its app slug', input: { action: 'session-cross-app', appSlug: 'notes', invitedBy: 'owner-17', ttlMs: 60_000 }, expected: { status: 200, sessionStatus: 200, crossAppSessionStatus: 401 } },
  { name: 'expired invitation is rejected before acceptance', input: { action: 'expired', appSlug: 'notes', invitedBy: 'owner-17', ttlMs: 1_000 }, expected: { status: 401 } },
  { name: 'session is valid before and rejected after expiry', input: { action: 'session-expired', appSlug: 'notes', invitedBy: 'owner-17', ttlMs: 60_000 }, expected: { status: 200, sessionStatus: 200, sessionStatusAfterExpiry: 401 } },
  { name: 'revoked session is rejected immediately', input: { action: 'revoke', appSlug: 'notes', invitedBy: 'owner-17', ttlMs: 60_000 }, expected: { status: 200, sessionStatus: 200, sessionStatusAfterRevoke: 401 } },
  { name: 'signup without an invitation is rejected', input: { action: 'uninvited', appSlug: 'notes', invitedBy: 'owner-17', ttlMs: 60_000 }, expected: { status: 401 } },
];

/** Replace one character with a different one of the same alphabet, keeping the length (defeats length-only checks). */
function swapCharAt(value: string, index: number): string {
  const current = value[index] ?? '';
  const replacement = current === 'A' ? 'B' : 'A';
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}
/** Same-length forgery of a signed `<payload>.<signature>` token: one signature character changes. */
export function tamperSignedToken(token: string): string {
  const dot = token.lastIndexOf('.');
  // First signature character: all of its bits are significant in base64url (the last one carries padding bits).
  return dot >= 0 && dot + 1 < token.length ? swapCharAt(token, dot + 1) : swapCharAt(token, Math.floor(token.length / 2));
}
function cookieValue(cookie: string): string { return cookie.split(';', 1)[0]!.split('=').slice(1).join('='); }
function tamperCookie(cookie: string): string {
  const name = cookie.split('=', 1)[0]!;
  const value = cookieValue(cookie);
  return `${name}=${swapCharAt(value, Math.floor(value.length / 2))}${cookie.slice(name.length + 1 + value.length)}`;
}

export async function runAppAuthContractMatrix(port: AppAuthContractPort): Promise<AppAuthContractResult[]> {
  const results: AppAuthContractResult[] = [];
  for (const contract of APP_AUTH_CONTRACT_CASES) {
    const subject = port.createCase(contract.input);
    let actual: AppAuthCaseExpectation;
    if (contract.input.action === 'uninvited') {
      actual = { status: subject.signUp({ appSlug: contract.input.appSlug }).status };
    } else {
      const invitation = subject.issueInvitation({ appSlug: contract.input.appSlug, invitedBy: contract.input.invitedBy, ttlMs: contract.input.ttlMs });
      if (contract.input.action === 'tamper') {
        actual = { status: subject.acceptInvitation({ appSlug: contract.input.appSlug, token: tamperSignedToken(invitation.token) }).status };
      } else if (contract.input.action === 'cross-app') {
        actual = { status: subject.acceptInvitation({ appSlug: 'other-app', token: invitation.token }).status };
      } else if (contract.input.action === 'expired') {
        subject.advanceTime(contract.input.ttlMs);
        actual = { status: subject.acceptInvitation({ appSlug: contract.input.appSlug, token: invitation.token }).status };
      } else {
        const accepted = subject.acceptInvitation({ appSlug: contract.input.appSlug, token: invitation.token });
        if (contract.input.action === 'session-expired') {
          const before = accepted.sessionToken ? subject.verifySession({ appSlug: contract.input.appSlug, token: accepted.sessionToken }).status : 401;
          subject.advanceTime(contract.input.ttlMs);
          const after = accepted.sessionToken ? subject.verifySession({ appSlug: contract.input.appSlug, token: accepted.sessionToken }).status : 401;
          actual = { status: accepted.status, sessionStatus: before, sessionStatusAfterExpiry: after };
        } else if (contract.input.action === 'session-cross-app') {
          const sameApp = accepted.sessionToken ? subject.verifySession({ appSlug: contract.input.appSlug, token: accepted.sessionToken }).status : 401;
          const otherApp = accepted.sessionToken ? subject.verifySession({ appSlug: 'other-app', token: accepted.sessionToken }).status : 401;
          actual = { status: accepted.status, sessionStatus: sameApp, crossAppSessionStatus: otherApp };
        } else if (contract.input.action === 'revoke') {
          const before = accepted.sessionToken ? subject.verifySession({ appSlug: contract.input.appSlug, token: accepted.sessionToken }).status : 401;
          if (accepted.sessionToken) subject.revokeSession(accepted.sessionToken);
          const after = accepted.sessionToken ? subject.verifySession({ appSlug: contract.input.appSlug, token: accepted.sessionToken }).status : 401;
          actual = { status: accepted.status, sessionStatus: before, sessionStatusAfterRevoke: after };
        } else {
          const record = accepted.sessionToken ? subject.getSessionRecord(accepted.sessionToken) : null;
          const sessionStatus = accepted.sessionToken ? subject.verifySession({ appSlug: contract.input.appSlug, token: accepted.sessionToken }).status : 401;
          const cookie = accepted.cookie ?? '';
          const cookieSessionStatus = cookie ? subject.verifySession({ appSlug: contract.input.appSlug, token: cookie }).status : 401;
          const tamperedCookieSessionStatus = cookie ? subject.verifySession({ appSlug: contract.input.appSlug, token: tamperCookie(cookie) }).status : 401;
          const crossAppCookieSessionStatus = cookie ? subject.verifySession({ appSlug: 'other-app', token: cookie }).status : 401;
          actual = {
            status: accepted.status,
            ...(record ? { invitedBy: record.invitedBy } : {}),
            sessionStatus,
            cookieSessionStatus,
            tamperedCookieSessionStatus,
            crossAppCookieSessionStatus,
            cookie: {
              hostPrefix: cookie.startsWith('__Host-'),
              secure: /(?:^|;\s*)Secure(?:;|$)/.test(cookie),
              pathRoot: /(?:^|;\s*)Path=\/(?:;|$)/.test(cookie),
              domain: /(?:^|;\s*)Domain=/i.test(cookie),
            },
          };
        }
      }
    }
    const passed = actual.status === contract.expected.status
      && actual.invitedBy === contract.expected.invitedBy
      && actual.sessionStatus === contract.expected.sessionStatus
      && actual.sessionStatusAfterExpiry === contract.expected.sessionStatusAfterExpiry
      && actual.sessionStatusAfterRevoke === contract.expected.sessionStatusAfterRevoke
      && actual.crossAppSessionStatus === contract.expected.crossAppSessionStatus
      && actual.cookieSessionStatus === contract.expected.cookieSessionStatus
      && actual.tamperedCookieSessionStatus === contract.expected.tamperedCookieSessionStatus
      && actual.crossAppCookieSessionStatus === contract.expected.crossAppCookieSessionStatus
      && JSON.stringify(actual.cookie) === JSON.stringify(contract.expected.cookie);
    results.push({ ...contract, actual, passed });
    if (!passed) throw new Error(`app auth contract failed: ${contract.name}; expected=${JSON.stringify(contract.expected)} actual=${JSON.stringify(actual)}`);
  }
  return results;
}

function isValidSlug(slug: string): boolean { return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug); }
function appLabel(slug: string): string { return `app-${createHash('sha256').update(slug).digest('hex').slice(0, 32)}`; }
function signature(payload: string, key: string): string { return createHmac('sha256', key).update(payload).digest('base64url'); }

function readInvitation(token: string, key: string, now: number): { appSlug: string; invitedBy: string; role: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = Buffer.from(signature(parts[0], key));
  const supplied = Buffer.from(parts[1]);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
    if (claims.v !== 1 || typeof claims.appSlug !== 'string' || !isValidSlug(claims.appSlug)
      || typeof claims.invitedBy !== 'string' || !claims.invitedBy.trim() || typeof claims.exp !== 'number'
      || !Number.isFinite(claims.exp) || now >= claims.exp) return null;
    return { appSlug: claims.appSlug, invitedBy: claims.invitedBy, role: typeof claims.role === 'string' ? claims.role : 'viewer' };
  } catch { return null; }
}

export function createFakeAppAuth(options: FakeAppAuthOptions) {
  let timeOffset = 0;
  const now = () => (options.now?.() ?? Date.now()) + timeOffset;
  const key = options.key ?? randomBytes(32).toString('base64url');
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const records = new Map<string, AppSessionRecord>();

  function issueInvitation(input: IssueInvitationInput): IssuedInvitation {
    if (!isValidSlug(input.appSlug)) throw new Error('appSlug must be a lowercase URL slug');
    if (!input.invitedBy.trim()) throw new Error('invitedBy is required');
    const ttlMs = input.ttlMs ?? DEFAULT_INVITATION_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('invitation ttlMs must be positive and finite');
    const exp = now() + ttlMs;
    const role = input.role ?? 'viewer';
    const payload = Buffer.from(JSON.stringify({ v: 1, appSlug: input.appSlug, invitedBy: input.invitedBy, role, exp })).toString('base64url');
    return { token: `${payload}.${signature(payload, key)}`, expiresAt: new Date(exp).toISOString(), appSlug: input.appSlug, invitedBy: input.invitedBy, role };
  }

  function acceptInvitation(input: { appSlug: string; token: string }): AppAuthResponse {
    if (!isValidSlug(input.appSlug)) return { status: 401 };
    const invite = readInvitation(input.token, key, now());
    if (!invite || invite.appSlug !== input.appSlug) return { status: 401 };
    const issued = issueTempToken({ ttlMs: sessionTtlMs, label: appLabel(invite.appSlug), dir: options.dir, now: now() });
    records.set(issued.token, { appSlug: invite.appSlug, invitedBy: invite.invitedBy, expiresAt: issued.expiresAt, role: invite.role });
    return { status: 200, cookie: `${COOKIE_NAME}=${issued.token}; Path=/; Secure; HttpOnly; SameSite=Lax`, sessionToken: issued.token, role: invite.role };
  }

  function tokenOf(value: string): string {
    return value.startsWith(`${COOKIE_NAME}=`) ? value.slice(COOKIE_NAME.length + 1).split(';', 1)[0]!.trim() : value;
  }

  function verifySession(input: { appSlug: string; token: string }): AppAuthResponse {
    if (!isValidSlug(input.appSlug)) return { status: 401 };
    const token = tokenOf(input.token);
    const matched = matchTempToken(token, { dir: options.dir, now: now() });
    const record = records.get(token);
    return matched && matched.label === appLabel(input.appSlug) && record?.appSlug === input.appSlug ? { status: 200, role: record.role } : { status: 401 };
  }

  function revokeSession(value: string): boolean {
    const token = tokenOf(value);
    // Only revoke sessions this instance issued: a shared temp-token dir may hold other callers' tokens.
    const record = records.get(token);
    if (!record) return false;
    const matched = matchTempToken(token, { dir: options.dir, now: now() });
    if (!matched || matched.label !== appLabel(record.appSlug)) return false;
    const removed = revokeTempTokens({ id: matched.id }, { dir: options.dir });
    records.delete(token);
    return removed > 0;
  }

  function getSessionRecord(value: string): AppSessionRecord | null {
    const token = tokenOf(value);
    const record = records.get(token);
    return record && matchTempToken(token, { dir: options.dir, now: now() }) ? record : null;
  }

  function createCase(): AppAuthContractSubject {
    return {
      issueInvitation,
      acceptInvitation,
      verifySession,
      revokeSession,
      signUp: () => ({ status: 401 }),
      getSessionRecord,
      advanceTime(ms) { timeOffset += ms; },
    };
  }

  async function runContractMatrix(): Promise<AppAuthContractResult[]> {
    return runAppAuthContractMatrix({ createCase: (input) => createFakeAppAuth({ dir: options.dir, key, now: () => now(), sessionTtlMs: input.action === 'session-expired' ? input.ttlMs : sessionTtlMs }).createCase() });
  }

  return { issueInvitation, acceptInvitation, verifySession, revokeSession, signUp: (_input: { appSlug: string }) => ({ status: 401 as const }), getSessionRecord, createCase, runContractMatrix };
}
