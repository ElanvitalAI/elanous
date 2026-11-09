import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, join } from 'node:path';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import { issueTempToken, matchTempToken, revokeTempTokens, TEMP_TOKEN_MAX_TTL_MS } from '../../auth/temp-tokens.js';
import { emitNexusFunnelEvent, type NexusFunnelRuntime } from './funnel-observe.js';

const COOKIE_NAME = '__Host-app-session';
const DEFAULT_INVITATION_TTL_MS = 15 * 60_000;
const DEFAULT_SESSION_TTL_MS = 60 * 60_000;

export interface AppAuthOptions {
  /** Dedicated app-session token store; defaults below the config directory, never the owner-token store. */
  readonly dir?: string;
  /** Stable, private secret generated from at least 32 random bytes and stored outside app source/config. */
  readonly key: string;
  readonly now?: () => number;
  readonly invitationTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly funnel?: NexusFunnelRuntime;
}

export interface IssueAppInvitationInput { readonly appSlug: string; readonly invitedBy: string; readonly ttlMs?: number; readonly role?: string }
export interface IssuedAppInvitation { readonly token: string; readonly expiresAt: string; readonly appSlug: string; readonly invitedBy: string; readonly role: string }
export interface AppAuthResponse { readonly status: 200 | 401; readonly cookie?: string; readonly sessionToken?: string; readonly role?: string }
export interface AppSessionRecord { readonly appSlug: string; readonly invitedBy: string; readonly expiresAt: string; readonly role: string; readonly source: 'share-link' | 'google-member' }

interface SignedClaims {
  readonly v: 1;
  readonly purpose: 'invite' | 'session';
  readonly appSlug: string;
  readonly invitedBy: string;
  readonly role: string;
  readonly sessionSource?: 'share-link' | 'google-member';
  readonly exp: number;
  readonly tempToken?: string;
}

function isValidSlug(slug: string): boolean {
  return slug.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) && !slug.includes('--');
}

function appLabel(slug: string): string {
  return `app-${createHash('sha256').update(slug).digest('hex').slice(0, 32)}`;
}

function signature(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function signedToken(claims: SignedClaims, key: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${signature(payload, key)}`;
}

function encryptSession(claims: SignedClaims, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), iv);
  cipher.setAAD(Buffer.from('elanous-nexus-app-session-v1'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()]);
  return `aps_${Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url')}`;
}

function readSessionToken(token: string, key: string, now: number): SignedClaims | null {
  if (typeof token !== 'string' || !token.startsWith('aps_') || token.length > 4096) return null;
  try {
    const packed = Buffer.from(token.slice(4), 'base64url');
    if (packed.length < 28) return null;
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), packed.subarray(0, 12));
    decipher.setAAD(Buffer.from('elanous-nexus-app-session-v1'));
    decipher.setAuthTag(packed.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(packed.subarray(12, -16)), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plaintext) as Partial<SignedClaims>;
    if (parsed.v !== 1 || parsed.purpose !== 'session' || typeof parsed.appSlug !== 'string' || !isValidSlug(parsed.appSlug)
      || typeof parsed.invitedBy !== 'string' || !parsed.invitedBy.trim() || parsed.invitedBy.length > 256
      || (parsed.role !== undefined && (typeof parsed.role !== 'string' || !parsed.role))
      || (parsed.sessionSource !== undefined && parsed.sessionSource !== 'share-link' && parsed.sessionSource !== 'google-member')
      || typeof parsed.exp !== 'number' || !Number.isSafeInteger(parsed.exp) || now >= parsed.exp
      || typeof parsed.tempToken !== 'string' || !parsed.tempToken.startsWith('elt_')) return null;
    return { ...parsed, role: parsed.role ?? 'owner' } as SignedClaims;
  } catch {
    return null;
  }
}

function readSignedToken(token: string, key: string, now: number, purpose: SignedClaims['purpose']): SignedClaims | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const expected = Buffer.from(signature(payload, key));
  const supplied = Buffer.from(token.slice(dot + 1));
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<SignedClaims>;
    if (parsed.v !== 1 || parsed.purpose !== purpose || typeof parsed.appSlug !== 'string' || !isValidSlug(parsed.appSlug)
      || typeof parsed.invitedBy !== 'string' || !parsed.invitedBy.trim() || parsed.invitedBy.length > 256
      || (parsed.role !== undefined && (typeof parsed.role !== 'string' || !parsed.role))
      || typeof parsed.exp !== 'number' || !Number.isSafeInteger(parsed.exp) || now >= parsed.exp) return null;
    if (purpose === 'session' && (typeof parsed.tempToken !== 'string' || !parsed.tempToken.startsWith('elt_'))) return null;
    return { ...parsed, role: parsed.role ?? 'owner' } as SignedClaims;
  } catch {
    return null;
  }
}

function tokenOf(value: string): string {
  const pairs = value.split(';').map(part => part.trim()).filter(Boolean);
  const found = pairs.filter(part => part.slice(0, part.indexOf('=')).trim() === COOKIE_NAME);
  if (found.length === 0) return value;
  if (found.length !== 1) return '';
  return found[0]!.slice(found[0]!.indexOf('=') + 1).trim();
}

function positiveTtl(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > TEMP_TOKEN_MAX_TTL_MS) {
    throw new Error(`${label} must be > 0 and at most 24h`);
  }
  return value;
}

/** App invitation and host-scoped session authentication backed by the existing revocable temp-token store. */
export function createAppAuth(options: AppAuthOptions) {
  if (typeof options.key !== 'string' || Buffer.byteLength(options.key) < 32) throw new Error('key must contain at least 256 bits');
  const ownerTokenDir = resolve(getElanousConfigDir());
  const dir = resolve(options.dir ?? join(ownerTokenDir, 'app-session-tokens'));
  if (dir === ownerTokenDir) throw new Error('app sessions must use a dedicated token directory');
  const invitationTtlMs = positiveTtl(options.invitationTtlMs ?? DEFAULT_INVITATION_TTL_MS, 'invitationTtlMs');
  const sessionTtlMs = positiveTtl(options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS, 'sessionTtlMs');
  const now = options.now ?? Date.now;

  function issueInvitation(input: IssueAppInvitationInput): IssuedAppInvitation {
    if (!isValidSlug(input.appSlug)) throw new Error('appSlug must be a lowercase URL slug');
    if (typeof input.invitedBy !== 'string' || !input.invitedBy.trim() || input.invitedBy.length > 256) {
      throw new Error('invitedBy must be a non-empty string of at most 256 characters');
    }
    const ttlMs = positiveTtl(input.ttlMs ?? invitationTtlMs, 'invitation ttlMs');
    const exp = now() + ttlMs;
    const role = input.role ?? 'owner';
    if (typeof role !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(role)) throw new Error('role must be a declared app role');
    const token = signedToken({ v: 1, purpose: 'invite', appSlug: input.appSlug, invitedBy: input.invitedBy, role, exp }, options.key);
    if (options.funnel) emitNexusFunnelEvent(options.funnel, { type: 'invite-sent', accountHash: options.funnel.accountHash });
    return { token, expiresAt: new Date(exp).toISOString(), appSlug: input.appSlug, invitedBy: input.invitedBy, role };
  }

  function acceptInvitation(input: { appSlug: string; token: string }): AppAuthResponse {
    if (!isValidSlug(input.appSlug)) return { status: 401 };
    const invite = readSignedToken(input.token, options.key, now(), 'invite');
    if (!invite || invite.appSlug !== input.appSlug) return { status: 401 };
    const issued = issueTempToken({ ttlMs: sessionTtlMs, label: appLabel(invite.appSlug), dir, now: now() });
    const sessionToken = encryptSession({ v: 1, purpose: 'session', appSlug: invite.appSlug, invitedBy: invite.invitedBy, role: invite.role, sessionSource: 'share-link',
      exp: Date.parse(issued.expiresAt), tempToken: issued.token }, options.key);
    const cookie = `${COOKIE_NAME}=${sessionToken}; Path=/; Secure; HttpOnly; SameSite=Lax`;
    return { status: 200, cookie, sessionToken, role: invite.role };
  }

  function issueTrustedSession(input: { appSlug: string; memberId: string; role: 'owner'; ttlMs?: number }): { sessionToken: string; expiresAt: string } {
    if (!isValidSlug(input.appSlug)) throw new Error('appSlug must be a lowercase URL slug');
    if (typeof input.memberId !== 'string' || !input.memberId.trim() || input.memberId.length > 256) throw new Error('memberId must be non-empty');
    const ttlMs = positiveTtl(input.ttlMs ?? sessionTtlMs, 'session ttlMs');
    const issued = issueTempToken({ ttlMs, label: appLabel(input.appSlug), dir, now: now() });
    const sessionToken = encryptSession({ v: 1, purpose: 'session', appSlug: input.appSlug, invitedBy: input.memberId,
      role: input.role, sessionSource: 'google-member', exp: Date.parse(issued.expiresAt), tempToken: issued.token }, options.key);
    return { sessionToken, expiresAt: issued.expiresAt };
  }

  function sessionClaims(value: string): SignedClaims | null {
    return readSessionToken(tokenOf(value), options.key, now());
  }

  function verifySession(input: { appSlug: string; token: string }): AppAuthResponse {
    if (!isValidSlug(input.appSlug)) return { status: 401 };
    const claims = sessionClaims(input.token);
    if (!claims || claims.appSlug !== input.appSlug || !claims.tempToken) return { status: 401 };
    const matched = matchTempToken(claims.tempToken, { dir, now: now() });
    return matched && matched.label === appLabel(input.appSlug) ? { status: 200, role: claims.role } : { status: 401 };
  }

  function getSessionRecord(value: string): AppSessionRecord | null {
    const claims = sessionClaims(value);
    if (!claims || !claims.tempToken) return null;
    const matched = matchTempToken(claims.tempToken, { dir, now: now() });
    if (!matched || matched.label !== appLabel(claims.appSlug)) return null;
    return { appSlug: claims.appSlug, invitedBy: claims.invitedBy, expiresAt: matched.expiresAt, role: claims.role,
      source: claims.sessionSource ?? 'share-link' };
  }

  function revokeSession(value: string): boolean {
    const claims = sessionClaims(value);
    if (!claims || !claims.tempToken) return false;
    const matched = matchTempToken(claims.tempToken, { dir, now: now() });
    if (!matched || matched.label !== appLabel(claims.appSlug)) return false;
    return revokeTempTokens({ id: matched.id }, { dir }) > 0;
  }

  return {
    issueInvitation,
    acceptInvitation,
    issueTrustedSession,
    verifySession,
    revokeSession,
    getSessionRecord,
    signUp: (_input: { appSlug: string }): AppAuthResponse => ({ status: 401 }),
  };
}
