/**
 * HQ-VAULT V2 — Codex OAuth «mirror lease» (owner side): `eln secret lease codex --to <host|config-dir>`.
 *
 * 🔗 내부 문서 `HQ-CREDENTIAL-VAULT` §3.3 (주인 한 곳 · 호스트는 접근 토큰만 임대) · §7 C4 · §2 위협 모델.
 *
 * The refresh token stays in the owner's store. The owner (refresh authority, HQ fence holder) reads its access
 * token — refreshing a named account first through the existing `refreshCodexAccountHome` path when it is close to
 * expiry — and writes a short-lived, refresh-free lease into the target:
 *   - config dir → `<dir>/auth.json`, the elanous store shape the Codex provider already reads, 0600;
 *   - host       → the same entry over ssh stdin into the host's access-mirror store (no argv / shell text value).
 * The consumer (`codex-lease-guard.ts`) refuses the entry loudly at/after `lease.expiresAt` and never refreshes.
 *
 * ⛔ No value leaves this module except into the target file. Results, errors and events carry ids and times only.
 */
import { closeSync, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { homeTestInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { withFileLockSync } from '../storage/file-lock.js';
import { decodeJWTPayload } from '../oauth/jwt.js';
import { emitSecretEvent, readCodexLeaseMarker, type CodexLeaseMarker } from './codex-lease-guard.js';
import {
  findActiveLease, leaseTargetKey, readLeaseRecords, secretLeaseStorePath, updateLeaseRecords,
  type LeaseRecord, type LeaseTarget,
} from './lease-store.js';

// ── Lifetimes (NUMGUARD: every number names its source) ──────────────────────────────────────────

// 출처: 내부 문서 `HQ-CREDENTIAL-VAULT` §8 D1 (정적 임대 제안 24시간 · OAuth 는 토큰 자체 만료 ⊕ 이 상한)
/** Upper bound on one lease (design D1: proposed static lease 24 h). An OAuth lease uses
 *  the access token's own expiry and is additionally capped here, so a long-lived Codex access token is never handed
 *  out for longer than a static key would be. */
export const CODEX_LEASE_MAX_TTL_MS = 24 * 60 * 60_000;
// 출처: 내부 문서 `HQ-CREDENTIAL-VAULT` §3.7 (만료 전 여유) · src/oauth/codex.ts CODEX_REFRESH_BUFFER_MS = 2분의 5배
/** The lease ends this long before the access token itself (clock skew between hosts); the consumer's own
 *  refresh floor is CODEX_REFRESH_BUFFER_MS = 2 min (src/oauth/codex.ts:56), this keeps 5× that as slack. */
export const CODEX_LEASE_TOKEN_MARGIN_MS = 10 * 60_000;
// 출처: 내부 문서 `HQ-CREDENTIAL-VAULT` §3.3 «min(만료 − 여유, 30분)» 재임대 주기
/** A lease shorter than this is refused instead of issued (§3.3 re-lease cycle) — a lease
 *  that cannot outlive one cycle would expire between two renewals. */
export const CODEX_LEASE_MIN_TTL_MS = 30 * 60_000;
// 출처: 내부 문서 `HQ-CREDENTIAL-VAULT` §3.3 «3시간 안에 만료되는 Codex 계정은 보내지 않고» (REMOTE-MIRROR-SKIP-UNUSABLE)
/** Below this remaining access lifetime the owner refreshes a named account first (REMOTE-MIRROR-SKIP-UNUSABLE
 *  3 h window (src/oauth/codex-owner-mirror.ts:207 · hostCredentials `hoursLeft < 3`). */
export const CODEX_LEASE_OWNER_REFRESH_BELOW_MS = 3 * 60 * 60_000;
// 출처: 내부 문서 `HQ-CREDENTIAL-VAULT` §7 C4 완료선 «임대 만료 뒤 호출 실패가 expired 로» — 실측용 짧은 임대의 하한
/** `--ttl` may shorten a lease (RES expiry verification) but never below this. */
export const CODEX_LEASE_TTL_FLOOR_MS = 5 * 60_000;
// 출처: 내부 문서 `HQ-CREDENTIAL-VAULT` §8 D1 «50% 갱신»
/** `--renew` re-issues once this fraction of the lease life has passed. */
export const CODEX_LEASE_RENEW_AT_FRACTION = 0.5;
// 출처: 내부 문서 `HQ-CREDENTIAL-VAULT` §1 (OP codex-mirror-loop.sh:6-22 하드코딩 호스트 목록)
/** Host allow-list = today's mirror target list (seat-state/OP/tools/codex-mirror-loop.sh:6 · OP 11-12 · 11-16). */
export const CODEX_LEASE_HOSTS: readonly string[] = ['node-b', 'gcp1', 'gcp2', 'aws1', 'aws2', 'node-c', 'minim5'];
/** Remote store the non-owner Codex provider reads (`codexOwnerMirrorAuthPath`), relative to the remote $HOME.
 *  Source: REMOTE_CODEX_CLI_MIRROR_DIR in src/task-agent/parent-host.ts. */
export const CODEX_LEASE_REMOTE_DIR = '.elanous/remote-parent-credentials/cli-mirror';
// 출처: 내부 문서 `HQ-CREDENTIAL-VAULT` §0 «새 상주 프로세스는 만들지 않는다» — 잊힌 전경 루프의 상한
/** Watch mode never runs longer than this: a lease watch replaces one 30-min cron tick chain for a single run;
 *  7 days bounds a forgotten foreground loop (no resident daemon — §0 «새 상주 프로세스 0»). */
export const CODEX_LEASE_WATCH_MAX_MS = 7 * 24 * 60 * 60_000;

/** Default config-dir roots (beside `ELANOUS_SECRET_LEASE_ROOTS`, ':'-separated absolute paths). */
export function defaultCodexLeaseRoots(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.ELANOUS_SECRET_LEASE_ROOTS ?? '').split(':').map((p) => p.trim()).filter((p) => p && isAbsolute(p));
  return [join(home, 'elanous-hq'), homeTestInstanceRoot(home), join(home, '.elanous-universes'), ...extra].map((p) => resolve(p));
}

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────

export type CodexLeaseRefusal =
  | 'not-owner-host' | 'target-not-allowed' | 'target-is-owner-store' | 'target-symlink' | 'target-holds-refresh'
  | 'no-source' | 'no-refresh-token' | 'not-chatgpt' | 'access-expiring' | 'owner-refresh-failed' | 'bad-account'
  | 'no-lease' | 'transport-failed' | 'lease-mismatch' | 'bad-ttl';

export class CodexLeaseRefusedError extends Error {
  readonly code = 'SECRET_LEASE_REFUSED';
  constructor(readonly reason: CodexLeaseRefusal, detail = '') {
    super(`secret lease refused (reason=${reason}${detail ? `; ${detail}` : ''})`);
    this.name = 'CodexLeaseRefusedError';
  }
}

// ── Deps (all side effects injectable; tests use fakes only) ─────────────────────────────────────

export type LeaseSshRunner = (host: string, script: string, timeoutMs: number, stdin?: string) => { status: number | null; stdout: string; stderr: string };

export interface CodexLeaseDeps {
  readonly now: () => number;
  /** Normalized local host name, written as the lease owner. */
  readonly ownerHost: () => string;
  /** Configured Codex refresh owner ⊕ HQ fence held (same gate as `codex mirror push`). */
  readonly isOwnerHost: () => boolean;
  /** The owner's own elanous auth store (never a lease target). */
  readonly ownerStorePath: () => string;
  /** Where `secret-leases.json` lives. */
  readonly stateRoot: () => string;
  readonly allowedRoots: () => readonly string[];
  readonly allowedHosts: () => readonly string[];
  /** Existing owner refresh path for a named account. Must throw on failure; never returns token values. */
  readonly refreshOwnerAccount: (account: string) => Promise<void>;
  readonly ssh: LeaseSshRunner;
  readonly newLeaseId: () => string;
}

// ── Target parsing / allow-list ──────────────────────────────────────────────────────────────────

const HOST_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** `--to` value → target. A value with a path separator or leading `~` is a config dir; otherwise a host name. */
export function parseLeaseTarget(raw: string, deps: Pick<CodexLeaseDeps, 'allowedRoots' | 'allowedHosts' | 'ownerStorePath' | 'ownerHost'>, home: string = homedir()): LeaseTarget {
  const value = raw.trim();
  if (!value) throw new CodexLeaseRefusedError('target-not-allowed', 'empty');
  if (value.includes('/') || value.startsWith('~')) {
    const path = resolve(value.startsWith('~') ? join(home, value.slice(1)) : value);
    if (!isAbsolute(value) && !value.startsWith('~')) throw new CodexLeaseRefusedError('target-not-allowed', 'config dir must be absolute');
    const ownerDir = resolve(dirname(deps.ownerStorePath()));
    const forbidden = [ownerDir, prodInstanceRoot(home), resolve(join(home, '.codex'))];
    if (forbidden.some((f) => path === f || within(f, path)) || /(^|\/)\.codex[^/]*(\/|$)/.test(path))
      throw new CodexLeaseRefusedError('target-is-owner-store');
    if (!deps.allowedRoots().some((root) => within(resolve(root), path))) throw new CodexLeaseRefusedError('target-not-allowed', 'config dir outside known roots');
    return { kind: 'config-dir', path };
  }
  const host = value.toLowerCase();
  if (!HOST_RE.test(host) || !deps.allowedHosts().includes(host)) throw new CodexLeaseRefusedError('target-not-allowed', 'host not in mirror target list');
  if (host === deps.ownerHost()) throw new CodexLeaseRefusedError('target-is-owner-store', 'owner host');
  return { kind: 'host', host, remoteDir: CODEX_LEASE_REMOTE_DIR };
}

function describeTarget(target: LeaseTarget): string {
  return target.kind === 'config-dir' ? target.path : `${target.host}:~/${target.remoteDir}`;
}

// ── Source (owner store) ─────────────────────────────────────────────────────────────────────────

interface OwnerAccess {
  readonly accessToken: string;
  readonly accessExpiresAt: number;
  readonly lastRefresh: string;
  readonly accountUuid?: string;
  readonly chatGPT?: Record<string, unknown>;
}

function storeKeyFor(account: string): string { return account === 'default' ? 'openai-codex' : `openai-codex:${account}`; }

function readOwnerAccess(storePath: string, account: string): OwnerAccess {
  let store: { providers?: Record<string, unknown> };
  try { store = JSON.parse(readFileSync(storePath, 'utf8')) as typeof store; }
  catch { throw new CodexLeaseRefusedError('no-source'); }
  const entry = store.providers?.[storeKeyFor(account)] as {
    tokens?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown };
    source?: unknown; authMode?: unknown; lastRefresh?: unknown; accountUuid?: unknown; chatGPT?: unknown; lease?: unknown;
  } | undefined;
  if (!entry?.tokens) throw new CodexLeaseRefusedError('no-source', `account=${account}`);
  // The owner of a lease must hold refresh authority; a mirror or a lease cannot re-lend.
  if (entry.source === 'mirror' || readCodexLeaseMarker(entry) !== null
    || typeof entry.tokens.refreshToken !== 'string' || !entry.tokens.refreshToken)
    throw new CodexLeaseRefusedError('no-refresh-token', `account=${account}`);
  if (entry.authMode !== undefined && entry.authMode !== 'chatgpt') throw new CodexLeaseRefusedError('not-chatgpt', `account=${account}`);
  const accessToken = entry.tokens.accessToken;
  if (typeof accessToken !== 'string' || !accessToken) throw new CodexLeaseRefusedError('no-source', `account=${account}; no access`);
  const jwtExp = decodeJWTPayload(accessToken)?.exp;
  const accessExpiresAt = typeof entry.tokens.expiresAt === 'number' && Number.isFinite(entry.tokens.expiresAt)
    ? entry.tokens.expiresAt : typeof jwtExp === 'number' ? jwtExp * 1000 : NaN;
  if (!Number.isFinite(accessExpiresAt)) throw new CodexLeaseRefusedError('access-expiring', `account=${account}; expiry unknown`);
  return {
    accessToken, accessExpiresAt,
    lastRefresh: typeof entry.lastRefresh === 'string' ? entry.lastRefresh : '',
    ...(typeof entry.accountUuid === 'string' ? { accountUuid: entry.accountUuid } : {}),
    ...(entry.chatGPT && typeof entry.chatGPT === 'object' ? { chatGPT: entry.chatGPT as Record<string, unknown> } : {}),
  };
}

/** Lease end = min(token expiry − margin, issue + cap). */
export function codexLeaseExpiry(now: number, accessExpiresAt: number): number {
  return Math.min(accessExpiresAt - CODEX_LEASE_TOKEN_MARGIN_MS, now + CODEX_LEASE_MAX_TTL_MS);
}

/** The single entry the target receives. Refresh fields are present and EMPTY (existing mirror invariant). */
export function buildCodexLeaseEntry(access: OwnerAccess, marker: CodexLeaseMarker): Record<string, unknown> {
  return {
    tokens: { accessToken: access.accessToken, refreshToken: '', refresh_token: '', expiresAt: marker.expiresAt, tokenType: 'Bearer' },
    source: 'mirror',
    authMode: 'chatgpt',
    lastRefresh: access.lastRefresh,
    ...(access.accountUuid ? { accountUuid: access.accountUuid } : {}),
    ...(access.chatGPT ? { chatGPT: access.chatGPT } : {}),
    lease: { ...marker },
  };
}

// ── Target writers ───────────────────────────────────────────────────────────────────────────────

function writeAtomic0600(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, body, 'utf8');
    closeSync(fd);
    renameSync(tmp, path);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* already renamed */ }
    throw error;
  }
}

type EntryUpdate = (current: Record<string, unknown> | undefined) => Record<string, unknown> | 'refuse-refresh' | 'mismatch';

function updateConfigDirEntry(dir: string, update: EntryUpdate): void {
  for (const p of [dir, join(dir, 'auth.json')]) {
    try { if (lstatSync(p).isSymbolicLink()) throw new CodexLeaseRefusedError('target-symlink'); }
    catch (error) { if (error instanceof CodexLeaseRefusedError) throw error; }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'auth.json');
  // Same lock name as src/oauth/store.ts withStoreLock — a running consumer never reads a half-written store.
  withFileLockSync(`${file}.lock`, () => {
    let store: { version?: unknown; providers?: Record<string, unknown> } = {};
    if (existsSync(file)) {
      try { store = JSON.parse(readFileSync(file, 'utf8')) as typeof store; }
      catch { throw new CodexLeaseRefusedError('target-not-allowed', 'existing auth store unreadable'); }
    }
    const providers = { ...(store.providers && typeof store.providers === 'object' ? store.providers : {}) };
    const next = update(providers['openai-codex'] as Record<string, unknown> | undefined);
    if (next === 'refuse-refresh') throw new CodexLeaseRefusedError('target-holds-refresh');
    if (next === 'mismatch') throw new CodexLeaseRefusedError('lease-mismatch');
    providers['openai-codex'] = next;
    writeAtomic0600(file, `${JSON.stringify({ version: typeof store.version === 'number' ? store.version : 1, providers }, null, 2)}\n`);
  }, { breakDeadHolder: true });
}

/** An existing non-lease entry with refresh authority is a real login — never overwrite it with a lease. */
function holdsRealRefresh(current: Record<string, unknown> | undefined): boolean {
  if (!current || readCodexLeaseMarker(current) !== null) return false;
  const tokens = current.tokens as { refreshToken?: unknown; refresh_token?: unknown } | undefined;
  return (typeof tokens?.refreshToken === 'string' && tokens.refreshToken !== '')
    || (typeof tokens?.refresh_token === 'string' && tokens.refresh_token !== '');
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Remote seam — the SAME ssh-stdin transport as `installRemoteCodexAccessBatch` (src/task-agent/parent-host.ts):
 * the payload (lease entry) goes through stdin only; argv/shell text carry no value. `mode`:
 *   install → replace `providers["openai-codex"]` unless it is a real refresh-holding login;
 *   revoke  → tombstone the entry only if its leaseId matches (CAS — a late revoke cannot erase a newer lease).
 */
export const REMOTE_LEASE_SCRIPT = [
  'const fs=require("node:fs"),path=require("node:path"),os=require("node:os");',
  'const p=JSON.parse(fs.readFileSync(0,"utf8"));if(!/^[A-Za-z0-9._/-]+$/.test(p.dir)||p.dir.includes(".."))process.exit(3);',
  'const dir=path.join(os.homedir(),p.dir),file=path.join(dir,"auth.json");fs.mkdirSync(dir,{recursive:true,mode:0o700});',
  'for(const q of [dir,file]){try{if(fs.lstatSync(q).isSymbolicLink())process.exit(4)}catch{}}',
  'let s={};try{s=JSON.parse(fs.readFileSync(file,"utf8"))}catch(e){if(e.code!=="ENOENT")process.exit(5)}',
  's.version=typeof s.version==="number"?s.version:1;s.providers={...(s.providers||{})};const cur=s.providers["openai-codex"];',
  'const isLease=!!(cur&&cur.lease),t=(cur&&cur.tokens)||{},real=!!cur&&!isLease&&((typeof t.refreshToken==="string"&&t.refreshToken)||(typeof t.refresh_token==="string"&&t.refresh_token));',
  'if(p.mode==="install"){if(real)process.exit(6);s.providers["openai-codex"]=p.entry}',
  'else if(p.mode==="revoke"){if(!isLease||cur.lease.leaseId!==p.leaseId)process.exit(7);s.providers["openai-codex"]={...cur,tokens:{accessToken:"",refreshToken:"",refresh_token:"",expiresAt:0},lease:{...cur.lease,revokedAt:p.revokedAt}}}',
  'else process.exit(8);const tmp=file+"."+process.pid+".tmp";fs.writeFileSync(tmp,JSON.stringify(s),{mode:0o600});fs.chmodSync(tmp,0o600);fs.renameSync(tmp,file);',
].join('');

function runRemote(deps: CodexLeaseDeps, target: Extract<LeaseTarget, { kind: 'host' }>, payload: Record<string, unknown>): void {
  const result = deps.ssh(target.host, `umask 077; bun -e ${shellQuote(REMOTE_LEASE_SCRIPT)}`, 20_000, JSON.stringify({ dir: target.remoteDir, ...payload }));
  if (result.status === 6) throw new CodexLeaseRefusedError('target-holds-refresh', `host=${target.host}`);
  if (result.status === 7) throw new CodexLeaseRefusedError('lease-mismatch', `host=${target.host}`);
  if (result.status === 4) throw new CodexLeaseRefusedError('target-symlink', `host=${target.host}`);
  // Never echo remote stderr — it is not ours to vet for values.
  if (result.status !== 0) throw new CodexLeaseRefusedError('transport-failed', `host=${target.host}; rc=${result.status ?? 'unknown'}`);
}

function installLease(deps: CodexLeaseDeps, target: LeaseTarget, entry: Record<string, unknown>): void {
  if (target.kind === 'config-dir') {
    updateConfigDirEntry(target.path, (current) => holdsRealRefresh(current) ? 'refuse-refresh' : entry);
    return;
  }
  runRemote(deps, target, { mode: 'install', entry });
}

function tombstoneLease(deps: CodexLeaseDeps, target: LeaseTarget, leaseId: string, revokedAt: number): void {
  if (target.kind === 'config-dir') {
    updateConfigDirEntry(target.path, (current) => {
      const marker = readCodexLeaseMarker(current);
      if (!current || marker === null || marker === 'malformed' || marker.leaseId !== leaseId) return 'mismatch';
      return { ...current, tokens: { accessToken: '', refreshToken: '', refresh_token: '', expiresAt: 0 }, lease: { ...marker, revokedAt } };
    });
    return;
  }
  runRemote(deps, target, { mode: 'revoke', leaseId, revokedAt });
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────

export interface CodexLeaseResult {
  readonly action: 'issued' | 'renewed' | 'fresh';
  readonly leaseId: string;
  readonly target: string;
  readonly account: string;
  readonly owner: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly renewAfter: number;
}

function refuse(target: string, reason: CodexLeaseRefusal, error: unknown): never {
  emitSecretEvent('secret.lease.refused', { kind: 'oauth', provider: 'codex', side: 'owner', reason, target }, 'warn');
  throw error;
}

function renewPoint(row: Pick<LeaseRecord, 'issuedAt' | 'renewedAt' | 'expiresAt'>): number {
  const start = row.renewedAt ?? row.issuedAt;
  return start + Math.floor((row.expiresAt - start) * CODEX_LEASE_RENEW_AT_FRACTION);
}

/** Issue (or with `renew`, re-issue when due) one Codex lease to one target. */
export async function issueCodexLease(
  input: { readonly to: string; readonly account?: string; readonly renew?: boolean; readonly ttlMs?: number; readonly podCard?: string },
  deps: CodexLeaseDeps,
): Promise<CodexLeaseResult> {
  const account = input.account ?? 'default';
  const rawTarget = input.to;
  if (!ACCOUNT_RE.test(account)) refuse(rawTarget, 'bad-account', new CodexLeaseRefusedError('bad-account'));
  if (input.ttlMs !== undefined && (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < CODEX_LEASE_TTL_FLOOR_MS || input.ttlMs > CODEX_LEASE_MAX_TTL_MS))
    refuse(rawTarget, 'bad-ttl', new CodexLeaseRefusedError('bad-ttl', 'ttl must be 5m..24h'));
  if (!deps.isOwnerHost()) refuse(rawTarget, 'not-owner-host', new CodexLeaseRefusedError('not-owner-host'));
  let target: LeaseTarget;
  try { target = parseLeaseTarget(rawTarget, deps); }
  catch (error) { refuse(rawTarget, error instanceof CodexLeaseRefusedError ? error.reason : 'target-not-allowed', error); }
  const targetKey = leaseTargetKey(target);
  const ledger = secretLeaseStorePath(deps.stateRoot());
  const owner = deps.ownerHost();
  const now = deps.now();

  const active = findActiveLease(readLeaseRecords(ledger), target);
  if (input.renew && active && active.account === account && now < active.expiresAt && now < renewPoint(active)) {
    return { action: 'fresh', leaseId: active.leaseId, target: describeTarget(target), account, owner: active.owner,
      issuedAt: active.issuedAt, expiresAt: active.expiresAt, renewAfter: renewPoint(active) };
  }

  let access: OwnerAccess;
  try {
    access = readOwnerAccess(deps.ownerStorePath(), account);
    if (access.accessExpiresAt - now < CODEX_LEASE_OWNER_REFRESH_BELOW_MS && account !== 'default') {
      // Existing owner refresh path for named accounts; the default account (~/.codex, shared with the official CLI)
      // is never force-refreshed here — same policy as refreshCodexAccountHome.
      try { await deps.refreshOwnerAccount(account); }
      catch { throw new CodexLeaseRefusedError('owner-refresh-failed', `account=${account}`); }
      access = readOwnerAccess(deps.ownerStorePath(), account);
    }
  } catch (error) { refuse(targetKey, error instanceof CodexLeaseRefusedError ? error.reason : 'no-source', error); }

  const expiresAt = Math.min(codexLeaseExpiry(now, access.accessExpiresAt), now + (input.ttlMs ?? CODEX_LEASE_MAX_TTL_MS));
  if (expiresAt - now < Math.min(input.ttlMs ?? CODEX_LEASE_MIN_TTL_MS, CODEX_LEASE_MIN_TTL_MS))
    refuse(targetKey, 'access-expiring', new CodexLeaseRefusedError('access-expiring', `account=${account}`));

  const renewing = Boolean(input.renew && active && active.account === account);
  const leaseId = renewing ? active!.leaseId : deps.newLeaseId();
  const issuedAt = renewing ? active!.issuedAt : now;
  const marker: CodexLeaseMarker = { leaseId, kind: 'oauth', provider: 'codex', owner, issuedAt, expiresAt };
  try { installLease(deps, target, buildCodexLeaseEntry(access, marker)); }
  catch (error) { refuse(targetKey, error instanceof CodexLeaseRefusedError ? error.reason : 'transport-failed', error instanceof CodexLeaseRefusedError ? error : new CodexLeaseRefusedError('transport-failed')); }

  updateLeaseRecords(ledger, (rows) => {
    const next = rows.map((row) => {
      if (row.leaseId === leaseId) return { ...row, expiresAt, renewedAt: now, renewCount: (row.renewCount ?? 0) + 1 };
      // A fresh issue supersedes any older live lease on the same target (its file entry was just replaced).
      if (row.revokedAt === undefined && leaseTargetKey(row.target) === targetKey) return { ...row, revokedAt: now };
      return row;
    });
    // #38815 ② — Pod 카드 id 를 원장 행에 남긴다(어느 Pod 발사에 주입됐는지 · 값/토큰 칸은 아니다).
    if (!renewing) next.push({ leaseId, kind: 'oauth', provider: 'codex', account, target, owner, issuedAt, expiresAt, ...(input.podCard !== undefined ? { podCard: input.podCard } : {}) });
    return { rows: next, result: undefined };
  });

  const wasExpired = Boolean(renewing && active && now >= active.expiresAt);
  emitSecretEvent(renewing ? 'secret.lease.renewed' : 'secret.lease.issued', {
    provider: 'codex', side: 'owner', kind: 'oauth', leaseId, account, owner, target: targetKey,
    issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(), refresh: 'excluded',
    ...(renewing ? { wasExpired } : {}),
  });
  const renewAfter = renewPoint({ issuedAt, renewedAt: renewing ? now : undefined, expiresAt });
  return { action: renewing ? 'renewed' : 'issued', leaseId, target: describeTarget(target), account, owner, issuedAt, expiresAt, renewAfter };
}

export interface CodexLeaseRevokeResult { readonly revoked: ReadonlyArray<{ leaseId: string; target: string }> }

/** Revoke by leaseId or by target: tombstone the target entry (leaseId CAS), then mark the ledger row. */
export function revokeCodexLease(input: { readonly leaseId?: string; readonly to?: string }, deps: CodexLeaseDeps): CodexLeaseRevokeResult {
  const label = input.leaseId ?? input.to ?? '';
  if (!deps.isOwnerHost()) refuse(label, 'not-owner-host', new CodexLeaseRefusedError('not-owner-host'));
  const ledger = secretLeaseStorePath(deps.stateRoot());
  const rows = readLeaseRecords(ledger);
  let picked: LeaseRecord[];
  if (input.leaseId) picked = rows.filter((row) => row.leaseId === input.leaseId && row.revokedAt === undefined);
  else {
    let target: LeaseTarget;
    try { target = parseLeaseTarget(input.to ?? '', deps); }
    catch (error) { refuse(label, error instanceof CodexLeaseRefusedError ? error.reason : 'target-not-allowed', error); }
    const key = leaseTargetKey(target);
    picked = rows.filter((row) => row.revokedAt === undefined && leaseTargetKey(row.target) === key);
  }
  if (!picked.length) refuse(label, 'no-lease', new CodexLeaseRefusedError('no-lease'));
  const now = deps.now();
  const done: Array<{ leaseId: string; target: string }> = [];
  for (const row of picked) {
    try { tombstoneLease(deps, row.target, row.leaseId, now); }
    catch (error) {
      // A superseded entry (lease-mismatch) is already gone from the target; only the ledger needs closing.
      if (!(error instanceof CodexLeaseRefusedError && error.reason === 'lease-mismatch'))
        refuse(leaseTargetKey(row.target), error instanceof CodexLeaseRefusedError ? error.reason : 'transport-failed', error);
    }
    updateLeaseRecords(ledger, (all) => ({ rows: all.map((r) => r.leaseId === row.leaseId ? { ...r, revokedAt: now } : r), result: undefined }));
    emitSecretEvent('secret.lease.revoked', { kind: 'oauth', provider: 'codex', side: 'owner', leaseId: row.leaseId, owner: row.owner,
      target: leaseTargetKey(row.target), revokedAt: new Date(now).toISOString() });
    done.push({ leaseId: row.leaseId, target: describeTarget(row.target) });
  }
  return { revoked: done };
}

/**
 * Bounded foreground renew loop (`--renew --until <time>`): renew when due, sleep until the next renew point,
 * exit at `untilMs`. No daemon, no schedule registration.
 */
export async function watchCodexLease(
  input: { readonly to: string; readonly account?: string; readonly untilMs: number; readonly ttlMs?: number },
  deps: CodexLeaseDeps & { readonly sleep: (ms: number) => Promise<void>; readonly onTick?: (result: CodexLeaseResult) => void },
): Promise<CodexLeaseResult[]> {
  const start = deps.now();
  if (!(input.untilMs > start) || input.untilMs - start > CODEX_LEASE_WATCH_MAX_MS)
    throw new CodexLeaseRefusedError('target-not-allowed', 'watch window must be in the future and at most 7 days');
  const ticks: CodexLeaseResult[] = [];
  for (;;) {
    const result = await issueCodexLease({ to: input.to, account: input.account, renew: true, ttlMs: input.ttlMs }, deps);
    ticks.push(result);
    deps.onTick?.(result);
    const now = deps.now();
    if (now >= input.untilMs) return ticks;
    const wait = Math.max(1_000, Math.min(result.renewAfter, input.untilMs) - now);
    await deps.sleep(wait);
    if (deps.now() >= input.untilMs) return ticks;
  }
}

/** Production deps — resolved lazily so importing this module stays light. */
export async function defaultCodexLeaseDeps(): Promise<CodexLeaseDeps> {
  const [{ hostname }, { getUserConfig }, { hqFenceDecision }, ownerMirror, credOwner, store, configDir, codex] = await Promise.all([
    import('node:os'), import('../user-config.js'), import('../hq/hq.js'), import('../oauth/codex-owner-mirror.js'),
    import('../nexus/config/secrets/cred-owner.js'), import('../oauth/store.js'), import('../elanous-config-dir.js'), import('../oauth/codex.js'),
  ]);
  const { defaultSshRunner } = await import('../task-agent/parent-host.js');
  return {
    now: () => Date.now(),
    ownerHost: () => credOwner.normalizeCredentialHost(getUserConfig().hq?.hostName || hostname()),
    isOwnerHost: () => ownerMirror.isCodexTokenOwnerHost(getUserConfig()) && hqFenceDecision('ledger-cli').run,
    ownerStorePath: () => store.authStorePath(),
    stateRoot: () => configDir.getElanousConfigDir(),
    allowedRoots: () => defaultCodexLeaseRoots(),
    allowedHosts: () => CODEX_LEASE_HOSTS,
    refreshOwnerAccount: async (account) => {
      const result = await codex.refreshCodexAccountHome(account);
      if (!result.ok) throw new Error(result.kind);
    },
    ssh: defaultSshRunner,
    newLeaseId: () => `lease-${randomUUID()}`,
  };
}
