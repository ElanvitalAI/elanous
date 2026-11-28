// RELEASE-HUMAN-PROOF-TRUST-ROOT (대표 11-28 13:3x YES · seat-state/OP/evidence/20261128/DESIGN-TRUST-ROOT.md).
// S: critpath verifies an ed25519 proof over the approval binding, but nobody signed — every TG approval stayed «unverified».
// C: a `decided human` row is writable by any same-UID seat, so the row alone must never open an irreversible publish.
// Q: who signs, where is the key, who turns it?
// A: the process that owns the owner's taps (TG bot · PWA route on the HQ host) signs right after the owner check and the
//    irreversible two-step confirm. One private key on one host (credential owner slot `release-approval-signer`, no mirror);
//    only the public trust root (<state>/release/trust-root.json) may be copied. First generation is TOFU at boot; an
//    existing root without its private key is never regenerated (alert · rotate from a person's terminal).
//    Out of scope (same as proxy-identity): a same-UID process deliberately reading the key file.
//
// 세 얼굴: 관측 = debug.log('release.proof', …) ⊕ <state>/release/signer/audit.jsonl ⊕ `eln decisions signer status` ·
//          인지 = signerStatus (ready · signer-missing · orphan-key · unsafe-perms · foreign-owner) ·
//          수복과 인계 = signer-missing → OP mail «eln decisions signer rotate (person's terminal)» · unverified → OP delegation.
// ⛔ Key material never leaves this module: no log, no mail, no return value carries the private key.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config/reader.js';
import { acquireLockSync } from '../storage/file-lock.js';
import { credentialOwnerLedgerPath, normalizeCredentialHost, readCredentialOwner, registerCredentialOwner, RELEASE_APPROVAL_SIGNER_SLOT } from '../nexus/config/secrets/cred-owner.js';
import { approvalProofPayload, readDecisionTrustRoots, type ApprovalProofBinding, type DecisionTrustRoot, type HumanProof } from './decision-ledger.js';

export { RELEASE_APPROVAL_SIGNER_SLOT };
/** Only these refs carry a release approval proof (critpath card · `release-critpath/<v>/<cut>/<notesSha256>`). */
export const SIGNED_REF_PREFIX = 'release-critpath/';
/** RELEASE-PRESIGNED-AUTO — the CEO's pre-authorization card (`release-preauth/<v>/<mode>/<fromZ>/<toZ>/<condSha12>`, kit/release-preauth). */
export const PREAUTH_SIGNED_REF_PREFIX = 'release-preauth/';
export const SIGNED_CHOICE = 'a';

export interface SignerOptions {
  stateDir?: string;
  /** Credential owner ledger (default ~/.elanous/credential-owner-ledger.json). */
  ownerLedgerPath?: string;
  /** This host's name (default: hq host file → OS hostname). */
  host?: string;
  now?: () => Date;
  /** OP alert (one line · no key material). Default: OP mail from RELEASE-PROOF, once per key. */
  notify?: (line: string, key: string) => void;
}
export type SignerState = 'ready' | 'generated' | 'signer-missing' | 'orphan-key' | 'unsafe-perms' | 'foreign-owner' | 'no-signer' | 'error';
export interface SignerStatus { state: SignerState; keyId?: string; roots: number; ownerHost?: string; detail?: string }

interface TrustRootFile { keys: Array<DecisionTrustRoot & { addedAt?: string; host?: string }>; revoked?: Array<{ keyId: string; revokedAt: string }> }

export function signerPaths(stateDir = elanousStateRoot()) {
  const dir = join(stateDir, 'release', 'signer');
  return { dir, key: join(dir, 'approval-signer.key'), lock: join(dir, '.lock'), audit: join(dir, 'audit.jsonl'), trustRoot: join(stateDir, 'release', 'trust-root.json') };
}

/** Same order as `hqLocalHostName` (src/hq/hq.ts): host-local identity file → hq.hostName → OS hostname. */
function localHost(opts: SignerOptions): string {
  if (opts.host) return normalizeCredentialHost(opts.host);
  try {
    const file = join(homedir(), '.elanous-hq', 'host');
    if (existsSync(file)) { const name = readFileSync(file, 'utf8').trim(); if (name) return normalizeCredentialHost(name); }
  } catch { /* fall back */ }
  const configured = getUserConfig().hq?.hostName;
  return normalizeCredentialHost(typeof configured === 'string' && configured.trim() ? configured : hostname());
}

function audit(stateDir: string, row: Record<string, unknown>, now: () => Date): void {
  const { dir, audit: path } = signerPaths(stateDir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify({ at: now().toISOString(), ...row })}\n`, { mode: 0o600 });
  } catch (error) { debug.log('release.proof', 'audit-failed', { reason: error instanceof Error ? error.message.slice(0, 80) : 'unknown' }, { level: 'warn' }); }
}

function defaultNotify(stateDir: string): (line: string, key: string) => void {
  return (line, key) => {
    void import('../msg/msg-store.js').then(({ openMsgStore }) => {
      const store = openMsgStore(join(stateDir, 'msg', 'messages.db'));
      try { store.appendWithProvenance({ from: 'RELEASE-PROOF', to: 'OP', kind: 'info', body: line }, key); }
      finally { store.close(); }
    }).catch((error: unknown) => debug.log('release.proof', 'notify-failed', { reason: error instanceof Error ? error.message.slice(0, 80) : 'unknown' }, { level: 'warn' }));
  };
}

function readTrustRootFile(path: string): TrustRootFile {
  if (!existsSync(path)) return { keys: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TrustRootFile>;
  return { keys: Array.isArray(parsed.keys) ? parsed.keys : [], ...(Array.isArray(parsed.revoked) ? { revoked: parsed.revoked } : {}) };
}
function writeTrustRootFile(path: string, file: TrustRootFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    renameSync(tmp, path);
  } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}

const publicPem = (key: KeyObject): string => createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
const samePem = (a: string, b: string): boolean => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');

/** Group/other bits on the key or its folder = do not sign (a lax key file is treated as leaked). */
function permsProblem(paths: ReturnType<typeof signerPaths>): string | null {
  const dir = lstatSync(paths.dir);
  if (!dir.isDirectory() || (dir.mode & 0o077) !== 0) return `signer folder mode ${(dir.mode & 0o777).toString(8)} (want 700)`;
  const key = lstatSync(paths.key);
  if (!key.isFile() || (key.mode & 0o077) !== 0) return `key file mode ${(key.mode & 0o777).toString(8)} (want 600)`;
  return null;
}

function loadKey(paths: ReturnType<typeof signerPaths>): KeyObject { return createPrivateKey(readFileSync(paths.key, 'utf8')); }

/** Read-only: which state the signer is in on this host. Never generates, never prints the key. */
export function signerStatus(opts: SignerOptions = {}): SignerStatus {
  const stateDir = opts.stateDir ?? elanousStateRoot();
  const paths = signerPaths(stateDir);
  const roots = readDecisionTrustRoots(stateDir);
  let owner: string | undefined;
  try { owner = readCredentialOwner(RELEASE_APPROVAL_SIGNER_SLOT, opts.ownerLedgerPath ?? credentialOwnerLedgerPath())?.ownerHost; } catch { owner = undefined; }
  const base = { roots: roots.length, ...(owner ? { ownerHost: owner } : {}) };
  if (!existsSync(paths.key)) {
    // A trust root that ever held a key (active or revoked) is never «first boot» again — no TOFU over a used root.
    let used = roots.length > 0;
    if (!used) { try { used = (readTrustRootFile(paths.trustRoot).revoked?.length ?? 0) > 0; } catch { used = existsSync(paths.trustRoot); } }
    return used ? { state: 'signer-missing', ...base } : { state: 'no-signer', ...base };
  }
  try {
    const problem = permsProblem(paths);
    if (problem) return { state: 'unsafe-perms', ...base, detail: problem };
    const pem = publicPem(loadKey(paths));
    const root = roots.find(r => samePem(r.publicKey, pem));
    return root ? { state: 'ready', keyId: root.keyId, ...base } : { state: 'orphan-key', ...base, detail: 'private key matches no trust-root key (revoked or replaced)' };
  } catch (error) { return { state: 'error', ...base, detail: error instanceof Error ? error.message.slice(0, 120) : 'unreadable' }; }
}

function nextKeyId(host: string, now: Date, taken: readonly string[]): string {
  const stem = `nexus-${host}-${now.toISOString().slice(0, 10).replaceAll('-', '')}`;
  if (!taken.includes(stem)) return stem;
  for (let i = 2; ; i++) if (!taken.includes(`${stem}-${i}`)) return `${stem}-${i}`;
}

/** Write a fresh private key (exclusive create · 0600) and append its public key to the trust root. Caller holds the lock. */
function generateLocked(paths: ReturnType<typeof signerPaths>, host: string, now: Date): string {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  const { privateKey } = generateKeyPairSync('ed25519');
  const fd = openSync(paths.key, 'wx', 0o600);
  // From here every failure removes the new private key: no private key without its public root (else the next boot
  // would see an orphan key and never sign).
  try {
    try {
      writeSync(fd, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
      fsyncSync(fd);
    } finally { closeSync(fd); }
    chmodSync(paths.key, 0o600);
    const file = readTrustRootFile(paths.trustRoot);
    const keyId = nextKeyId(host, now, [...file.keys.map(k => k.keyId), ...(file.revoked ?? []).map(k => k.keyId)]);
    file.keys.push({ keyId, publicKey: publicPem(privateKey), addedAt: now.toISOString(), host });
    writeTrustRootFile(paths.trustRoot, file);
    return keyId;
  } catch (error) {
    try { unlinkSync(paths.key); } catch { /* keep the original failure */ }
    throw error;
  }
}

/**
 * Boot hook (TG bot owner · nexus on the HQ host). TOFU: no key ⊕ empty trust root → generate once. A trust root that
 * already has keys while the private key is gone is NEVER regenerated (that would silently re-key the release gate).
 */
export function ensureApprovalSigner(opts: SignerOptions = {}): SignerStatus {
  const stateDir = opts.stateDir ?? elanousStateRoot();
  const now = opts.now ?? (() => new Date());
  const notify = opts.notify ?? defaultNotify(stateDir);
  const paths = signerPaths(stateDir);
  const ledgerPath = opts.ownerLedgerPath ?? credentialOwnerLedgerPath();
  try {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const release = acquireLockSync(paths.lock);
    let status: SignerStatus;
    try {
      status = signerStatus({ ...opts, stateDir, ownerLedgerPath: ledgerPath });
      const host = localHost(opts);
      if (status.state === 'no-signer') {
        if (status.ownerHost && status.ownerHost !== host) {
          status = { ...status, state: 'foreign-owner', detail: `signer slot owned by ${status.ownerHost}` };
        } else {
          const keyId = generateLocked(paths, host, now());
          registerCredentialOwner({ slot: RELEASE_APPROVAL_SIGNER_SLOT, ownerHost: host }, ledgerPath);
          audit(stateDir, { event: 'generated', keyId, host, via: 'tofu-boot' }, now);
          debug.log('release.proof', 'generated', { keyId, host });
          notify(`[release.proof] 발행 승인 서명 키 첫 생성(TOFU) · ${keyId} · ${host} · 공개 뿌리 ${paths.trustRoot} · 개인 키는 이 호스트에만(미러 0)`, `release-proof:generated:${keyId}`);
          status = { state: 'generated', keyId, roots: status.roots + 1, ownerHost: host };
        }
      } else if (status.state === 'ready' && !status.ownerHost) {
        registerCredentialOwner({ slot: RELEASE_APPROVAL_SIGNER_SLOT, ownerHost: host }, ledgerPath);
        status = { ...status, ownerHost: host };
      }
    } finally { release(); }
    if (status.state === 'signer-missing' || status.state === 'orphan-key' || status.state === 'unsafe-perms' || status.state === 'foreign-owner' || status.state === 'error') {
      debug.log('release.proof', status.state, { roots: status.roots, detail: status.detail ?? null }, { level: 'warn' });
      audit(stateDir, { event: status.state, detail: status.detail ?? null }, now);
      notify(`[release.proof] ⚠ 발행 승인 서명 불가(${status.state}${status.detail ? ` · ${status.detail}` : ''}) — 재생성하지 않는다 · 👑 승인은 unverified 로 남고 발행은 OP 위임(human-proof-unavailable:${status.state}) · 수복: 사람 터미널에서 eln decisions signer rotate`,
        `release-proof:${status.state}:${now().toISOString().slice(0, 10)}`);
    } else debug.log('release.proof', 'signer-ready', { keyId: status.keyId ?? null, state: status.state });
    return status;
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 120) : 'unknown';
    debug.log('release.proof', 'ensure-failed', { detail }, { level: 'warn' });
    return { state: 'error', roots: readDecisionTrustRoots(stateDir).length, detail };
  }
}

/** Does this decision get a proof? A critpath card or a pre-authorization card, the approve choice — nothing else is signed. */
export function proofWanted(entry: { refs?: readonly string[] }, choice: string): string | null {
  if (choice !== SIGNED_CHOICE) return null;
  return entry.refs?.find(ref => ref.startsWith(SIGNED_REF_PREFIX)) ?? entry.refs?.find(ref => ref.startsWith(PREAUTH_SIGNED_REF_PREFIX)) ?? null;
}

export type SignOutcome = { ok: true; proof: HumanProof } | { ok: false; reason: SignerState | 'bad-binding' };
/** Sign one approval binding (elanous-approval/v2). The caller has already done the owner check and the two-step confirm. */
export function signApprovalProof(binding: ApprovalProofBinding, opts: SignerOptions = {}): SignOutcome {
  const stateDir = opts.stateDir ?? elanousStateRoot();
  const now = opts.now ?? (() => new Date());
  let payload: string;
  try { payload = approvalProofPayload(binding); } catch { return { ok: false, reason: 'bad-binding' }; }
  const refuse = (reason: SignerState): SignOutcome => {
    debug.log('release.proof', 'sign-skipped', { card: binding.cardId, reason }, { level: 'warn' });
    audit(stateDir, { event: 'sign-refused', cardId: binding.cardId, ref: binding.ref, reason }, now);
    return { ok: false, reason };
  };
  const paths = signerPaths(stateDir);
  if (!existsSync(paths.key)) return refuse(signerStatus({ ...opts, stateDir }).state);
  // Same lock as rotate/revoke: the key read, the keyId match and the signature see one signer state (Terra r2).
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const release = acquireLockSync(paths.lock);
  try {
    // A key on a host that does not own the signer slot is a mirror — never sign with it (Terra r2).
    let owner: string | undefined;
    try { owner = readCredentialOwner(RELEASE_APPROVAL_SIGNER_SLOT, opts.ownerLedgerPath ?? credentialOwnerLedgerPath())?.ownerHost; }
    catch { return refuse('error'); }
    if (owner && owner !== localHost(opts)) return refuse('foreign-owner');
    const problem = permsProblem(paths);
    if (problem) return refuse('unsafe-perms');
    // One key object for both the keyId and the signature: a rotate in between can never pair a new key with an old id.
    const key = loadKey(paths);
    const pem = publicPem(key);
    const keyId = readDecisionTrustRoots(stateDir).find(r => samePem(r.publicKey, pem))?.keyId;
    if (!keyId) return refuse('orphan-key');
    const sig = cryptoSign(null, Buffer.from(payload, 'utf8'), key).toString('hex');
    audit(stateDir, { event: 'signed', keyId, cardId: binding.cardId, ref: binding.ref, via: binding.via }, now);
    debug.log('release.proof', 'signed', { keyId, card: binding.cardId, via: binding.via });
    return { ok: true, proof: { keyId, sig } };
  } catch (error) {
    debug.log('release.proof', 'sign-failed', { card: binding.cardId, reason: error instanceof Error ? error.name : 'unknown' }, { level: 'warn' });
    return { ok: false, reason: 'error' };
  } finally { release(); }
}

/** Rotate: a new key replaces the private key; the old public key STAYS in the trust root so past proofs keep verifying. */
export function rotateApprovalSigner(opts: SignerOptions = {}): { keyId: string; previous: string | null } {
  const stateDir = opts.stateDir ?? elanousStateRoot();
  const now = opts.now ?? (() => new Date());
  const paths = signerPaths(stateDir);
  const ledgerPath = opts.ownerLedgerPath ?? credentialOwnerLedgerPath();
  const host = localHost(opts);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const release = acquireLockSync(paths.lock);
  try {
    const owner = readCredentialOwner(RELEASE_APPROVAL_SIGNER_SLOT, ledgerPath)?.ownerHost;
    if (owner && owner !== host) throw new Error(`signer slot owned by ${owner} — rotate there`);
    const before = signerStatus({ ...opts, stateDir, ownerLedgerPath: ledgerPath });
    // The old private key steps aside until the new one and its public root are on disk (a failed rotate keeps signing).
    const aside = `${paths.key}.rotating`;
    if (existsSync(paths.key)) renameSync(paths.key, aside);
    let keyId: string;
    try { keyId = generateLocked(paths, host, now()); }
    catch (error) { if (existsSync(aside)) renameSync(aside, paths.key); throw error; }
    if (existsSync(aside)) unlinkSync(aside);
    registerCredentialOwner({ slot: RELEASE_APPROVAL_SIGNER_SLOT, ownerHost: host }, ledgerPath);
    audit(stateDir, { event: 'rotated', keyId, previous: before.keyId ?? null, host }, now);
    debug.log('release.proof', 'rotated', { keyId, previous: before.keyId ?? null });
    return { keyId, previous: before.keyId ?? null };
  } finally { release(); }
}

/** Revoke: the keyId leaves the trust root (its proofs stop verifying); a matching private key is deleted. */
export function revokeApprovalSigner(keyId: string, opts: SignerOptions = {}): { revoked: boolean; deletedPrivateKey: boolean } {
  const stateDir = opts.stateDir ?? elanousStateRoot();
  const now = opts.now ?? (() => new Date());
  const paths = signerPaths(stateDir);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const release = acquireLockSync(paths.lock);
  try {
    const file = readTrustRootFile(paths.trustRoot);
    const hit = file.keys.find(k => k.keyId === keyId);
    if (!hit) return { revoked: false, deletedPrivateKey: false };
    let deletedPrivateKey = false;
    if (existsSync(paths.key)) {
      try { if (samePem(publicPem(loadKey(paths)), hit.publicKey)) { unlinkSync(paths.key); deletedPrivateKey = true; } }
      catch { /* an unreadable key is not this key's proof of identity — leave it */ }
    }
    writeTrustRootFile(paths.trustRoot, { keys: file.keys.filter(k => k.keyId !== keyId), revoked: [...(file.revoked ?? []), { keyId, revokedAt: now().toISOString() }] });
    audit(stateDir, { event: 'revoked', keyId, deletedPrivateKey }, now);
    debug.log('release.proof', 'revoked', { keyId, deletedPrivateKey });
    return { revoked: true, deletedPrivateKey };
  } finally { release(); }
}

/** For tests and `signer status`: the key file's mode bits (never its bytes). */
export function signerKeyMode(stateDir = elanousStateRoot()): { dir: number; key: number } | null {
  const paths = signerPaths(stateDir);
  if (!existsSync(paths.key)) return null;
  return { dir: statSync(paths.dir).mode & 0o777, key: statSync(paths.key).mode & 0o777 };
}
