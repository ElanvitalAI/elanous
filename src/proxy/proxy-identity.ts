/**
 * CLAUDE-OP-PROXY-IDENTITY (CEO 11-26 18:3x · 내부 문서 `CLAUDE-OP-PROXY` §A2) — the CEO's proxy as a real principal.
 *
 * S: every identity elanous reads today is self-declared (`--from` · ELANOUS_TRACK · cwd). CLAUDE-OP (the Claude Code
 *    session in seats/OP) must act for the CEO with OP's operator authority — update-all, els acting ops, seat assign,
 *    land unhold, closing unowned tabs — and a self-declared string must never carry that authority.
 * C: no secret to steal (every seat runs as the same OS user); the CEO grants it once from a person's terminal; a
 *    Claude Code restart (new process) ends it; money, secrets, JUD veto, destructive git and pkill stay closed.
 * Q: what proves «this call comes from the Claude OP session»?
 * A: a grant bound to one Claude Code process — pid ⊕ kernel start time — issued only from a TTY whose ancestors hold no
 *    agent runtime, with a typed confirm code. A call is the proxy iff the kernel-observed ancestor chain of the calling
 *    process reaches that exact process (pid ⊕ start). The grant file holds no secret; a request field or env is never
 *    proof. Every proxy action writes an audit row and a one-line «[Claude OP 대행]» notice to OP.
 *
 * Threat model (doc §A2): another LLM seat typing `--from CLAUDE-OP` → no ancestry → refused · an agent running
 * `eln proxy grant` → not a TTY / agent ancestor / no typed code → refused · pid reuse → start time differs → refused ·
 * a same-UID process editing grants.json directly → out of scope (same-UID trust, CEO 11-24); the grant must also match
 * its audit row, and every grant/revoke notices OP.
 *
 * 세 얼굴: 관측 = debug.log('proxy', 'proxy.verify' | 'proxy.action' | 'proxy.grant') ⊕ <state>/proxy/audit.jsonl ·
 *          인지 = verifyProxyCaller · grantPreflight · proxyAuthority (pure over an injected process lookup) ·
 *          수복과 인계 = a refusal names the fix (`eln proxy grant CLAUDE-OP --runtime <pid>` from your own terminal).
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROXY_PRINCIPAL = 'CLAUDE-OP';
export const PROXY_ROLE = 'proxy';
/** A grant lives at most this long (a Claude Code restart ends it earlier: the process is gone). */
export const PROXY_GRANT_TTL_MS = 7 * 24 * 60 * 60_000;
/** The process name a proxy runtime must carry (the Claude Code CLI). */
export const PROXY_RUNTIME_NAMES: readonly string[] = ['claude'];
/**
 * Agent runtimes and terminal drivers: none may sit among the granting process's ancestors (above its own eln launcher).
 * A person's terminal is shell → login/terminal app/herdr; an agent's shell has its runtime above it.
 */
export const AGENT_ANCESTOR_NAMES: readonly string[] = ['claude', 'codex', 'grok', 'node', 'bun', 'eln', 'elanous', 'python', 'python3', 'tmux', 'screen', 'expect', 'script', 'osascript', 'gemini', 'opencode', 'aider'];
/** The runtime of `eln proxy grant` itself (only the process itself is exempt from the agent-ancestor check). */
const LAUNCHER_NAMES: ReadonlySet<string> = new Set(['bun', 'node']);

/** Operations the verified proxy may perform with OP's operator authority. */
export const PROXY_ALLOWED_OPS = ['update-all', 'update-seat', 'seat-control', 'els-act', 'els-close-unowned', 'seat-assign', 'land-unhold', 'release-graph-run', 'config-set'] as const;
export type ProxyOp = typeof PROXY_ALLOWED_OPS[number];
/** Never through the proxy, whatever the grant says. */
export const PROXY_DENIED_OPS = ['paid-vm', 'secret', 'jud-veto', 'force-push', 'merge', 'pkill', 'crown-directive'] as const;

export interface ProcInfo { readonly pid: number; readonly ppid: number; readonly uid: number; readonly start: string; readonly name: string }
export type ProcLookup = (pid: number) => ProcInfo | undefined;

export interface ProxyGrant {
  readonly principal: string;
  readonly role: typeof PROXY_ROLE;
  readonly grantId: string;
  readonly runtime: { readonly pid: number; readonly start: string; readonly name: string; readonly uid: number };
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly grantedVia: 'tty';
}

export function proxyDir(stateRoot: string): string { return join(stateRoot, 'proxy'); }
export function proxyGrantsFile(stateRoot: string): string { return join(proxyDir(stateRoot), 'grants.json'); }
export function proxyAuditFile(stateRoot: string): string { return join(proxyDir(stateRoot), 'audit.jsonl'); }

/** The live process lookup (Darwin proc_pidinfo — kernel-observed, never a request field). Undefined off Darwin. */
export function defaultProcLookup(): ProcLookup {
  return (pid) => {
    try {
      const { runtimeProcessIdentity } = require('../els/seat-runtime.js') as typeof import('../els/seat-runtime.js');
      return runtimeProcessIdentity(pid);
    } catch { return undefined; }
  };
}

const lower = (s: string): string => s.trim().toLowerCase();
const baseName = (s: string): string => lower(s).split('/').pop() ?? '';

/** The ancestor chain of `pid` (itself first), at most 128 hops, stopping at a missing or uid-changed process. */
export function ancestorChain(pid: number, lookup: ProcLookup): ProcInfo[] {
  const out: ProcInfo[] = [];
  const seen = new Set<number>();
  let cur = pid;
  let uid: number | undefined;
  for (let depth = 0; depth < 128 && cur > 1 && !seen.has(cur); depth++) {
    seen.add(cur);
    const p = lookup(cur);
    if (!p || p.pid !== cur) break;
    if (uid === undefined) uid = p.uid;
    else if (p.uid !== uid) break;
    out.push(p);
    cur = p.ppid;
  }
  return out;
}

export type ProxyVerdict =
  | { readonly ok: true; readonly principal: string; readonly grant: ProxyGrant; readonly hops: number }
  | { readonly ok: false; readonly reason: 'no-grant' | 'grant-unsafe' | 'grant-unaudited' | 'expired' | 'runtime-gone' | 'not-descendant' | 'no-lookup'; readonly line: string };

export function proxyFixLine(principal = PROXY_PRINCIPAL): string {
  return `the CEO grants it once from their own terminal: eln proxy grant ${principal} --runtime <claude pid>`;
}

function parseGrant(raw: unknown, principal: string): ProxyGrant | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = (raw as Record<string, unknown>)[principal] as ProxyGrant | undefined;
  if (!g || g.role !== PROXY_ROLE || g.principal !== principal || typeof g.grantId !== 'string' || !g.runtime
    || !Number.isSafeInteger(g.runtime.pid) || typeof g.runtime.start !== 'string' || typeof g.expiresAt !== 'string') return null;
  return g;
}

/**
 * The grant file must be a regular file owned by this user and not readable/writable by group or others (0600);
 * a symlink or a loose mode is refused (it could point anywhere or be planted by another account).
 */
export function readProxyGrant(stateRoot: string, principal = PROXY_PRINCIPAL, selfUid: number | undefined = process.getuid?.()): { grant: ProxyGrant | null; unsafe: boolean } {
  const file = proxyGrantsFile(stateRoot);
  let st: ReturnType<typeof lstatSync>;
  // lstat, not exists: a dangling symlink is a planted path (unsafe), not «no grant».
  try { st = lstatSync(file); } catch (error) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? { grant: null, unsafe: false } : { grant: null, unsafe: true }; }
  try {
    if (!st.isFile() || (selfUid !== undefined && st.uid !== selfUid) || (st.mode & 0o777) !== 0o600) return { grant: null, unsafe: true };
    return { grant: parseGrant(JSON.parse(readFileSync(file, 'utf8')), principal), unsafe: false };
  } catch { return { grant: null, unsafe: true }; }
}

/** The audit ledger holds the grant row for this grantId (tamper evidence: a hand-written grant has no row). */
function grantAudited(stateRoot: string, grantId: string): boolean {
  const file = proxyAuditFile(stateRoot);
  if (!existsSync(file)) return false;
  return readFileSync(file, 'utf8').split('\n').some((line) => {
    if (!line.includes(grantId)) return false;
    try { const r = JSON.parse(line) as { event?: string; grantId?: string }; return r.event === 'grant' && r.grantId === grantId; } catch { return false; }
  });
}

export interface VerifyInput {
  readonly stateRoot: string;
  readonly principal?: string;
  /** The calling process (default: this process). */
  readonly pid?: number;
  readonly lookup?: ProcLookup;
  readonly now?: number;
  readonly selfUid?: number;
  /** The caller's process start as observed before any lookup (a socket server's peer baseline): a reused pid fails. */
  readonly expectStart?: string;
}

/** Is `pid` (default: this process) a descendant of the granted proxy runtime — same pid ⊕ kernel start time? */
export function verifyProxyCaller(input: VerifyInput): ProxyVerdict {
  const principal = (input.principal ?? PROXY_PRINCIPAL).toUpperCase();
  const fix = proxyFixLine(principal);
  const { grant, unsafe } = readProxyGrant(input.stateRoot, principal, input.selfUid ?? process.getuid?.());
  if (unsafe) return { ok: false, reason: 'grant-unsafe', line: `proxy: the grant file is not a private regular file (0600, owned by you) — ignored · ${fix}` };
  if (!grant) return { ok: false, reason: 'no-grant', line: `proxy: no ${principal} grant · ${fix}` };
  if (!grantAudited(input.stateRoot, grant.grantId)) return { ok: false, reason: 'grant-unaudited', line: `proxy: the ${principal} grant has no audit row (not issued by eln proxy grant) — ignored · ${fix}` };
  const now = input.now ?? Date.now();
  if (!(Date.parse(grant.expiresAt) > now)) return { ok: false, reason: 'expired', line: `proxy: the ${principal} grant expired at ${grant.expiresAt} · ${fix}` };
  const lookup = input.lookup ?? defaultProcLookup();
  const live = lookup(grant.runtime.pid);
  if (live === undefined && lookup(input.pid ?? process.pid) === undefined) return { ok: false, reason: 'no-lookup', line: 'proxy: this host cannot observe process identity — proxy authority is local to the granting Mac' };
  if (!live || live.start !== grant.runtime.start || live.uid !== grant.runtime.uid) return { ok: false, reason: 'runtime-gone', line: `proxy: the granted ${principal} process (pid ${grant.runtime.pid}) is gone or was replaced · ${fix}` };
  const chain = ancestorChain(input.pid ?? process.pid, lookup);
  if (input.expectStart !== undefined && chain[0]?.start !== input.expectStart) return { ok: false, reason: 'not-descendant', line: 'proxy: the calling process changed while it was being identified' };
  const hops = chain.findIndex((p) => p.pid === grant.runtime.pid && p.start === grant.runtime.start && p.uid === grant.runtime.uid);
  if (hops < 0) return { ok: false, reason: 'not-descendant', line: `proxy: this process does not run inside the ${principal} session — a --from/ELANOUS_TRACK name is not an identity` };
  return { ok: true, principal, grant, hops };
}

export type GrantPreflight =
  | { readonly ok: true; readonly runtime: ProcInfo }
  | { readonly ok: false; readonly reason: 'not-a-terminal' | 'agent-ancestor' | 'ancestry-unknown' | 'runtime-not-found' | 'runtime-not-claude' | 'runtime-other-user' | 'self-inside-runtime'; readonly line: string };

/**
 * Who may issue a grant: a person at a terminal. stdin must be a TTY, and above the eln launcher chain no ancestor may
 * be an agent runtime or terminal driver. The runtime must be a live Claude Code process of this user.
 */
/**
 * A second kernel-observed view of a process for the grant walk: owner uid, parent and argv[0], read with `ps` (which
 * sees every account's processes). proc_pidinfo cannot read a root-owned ancestor (sshd · login), and its process name
 * for Claude Code is the version file it runs (`2.1.331`), not `claude` — argv[0] carries the command name.
 */
export interface ProcMeta { readonly uid: number; readonly ppid: number; readonly argv0: string }
export type ProcMetaLookup = (pid: number) => ProcMeta | undefined;

export function defaultProcMeta(): ProcMetaLookup {
  return (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
    try {
      const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
      const ids = spawnSync('/bin/ps', ['-o', 'uid=,ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(ids.stdout ?? '');
      if (ids.status !== 0 || !m) return undefined;
      const args = spawnSync('/bin/ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
      const argv0 = (args.stdout ?? '').trim().split(/\s+/)[0] ?? '';
      return { uid: Number(m[1]), ppid: Number(m[2]), argv0 };
    } catch { return undefined; }
  };
}

/** Account-boundary processes: an unreadable parent above one of these is the system side of a login (complete). */
const LOGIN_BOUNDARY_NAMES: readonly string[] = ['sshd-session', 'sshd', 'login'];

/** The names a process answers to: its kernel name and its argv[0] (both base names). */
function procNames(p: ProcInfo, meta: ProcMetaLookup | undefined): string[] {
  const names = [baseName(p.name)];
  const argv0 = meta?.(p.pid)?.argv0;
  if (argv0 && !names.includes(baseName(argv0))) names.push(baseName(argv0));
  return names;
}

export function grantPreflight(input: { readonly selfPid: number; readonly stdinIsTTY: boolean; readonly runtimePid: number; readonly lookup: ProcLookup; readonly meta?: ProcMetaLookup; readonly selfUid?: number }): GrantPreflight {
  if (!input.stdinIsTTY) return { ok: false, reason: 'not-a-terminal', line: 'eln proxy grant: run this yourself in a terminal (stdin is not a TTY) — an agent cannot grant itself proxy authority' };
  // Walk the whole ancestry; fail closed when any hop cannot be observed. The walk ends at launchd (ppid ≤ 1) or at the
  // first ancestor owned by another account (login · sshd run as root) — those are not agent runtimes of this user.
  // proc_pidinfo cannot read a root-owned ancestor: its owner is then read with `ps` (meta); another account = complete.
  // If even the owner cannot be read, a last observed hop that is a login boundary (sshd-session · sshd · login) still
  // completes the walk — above it is only the system's side of the login. Anything else unreadable fails closed.
  const chain: ProcInfo[] = [];
  const seen = new Set<number>();
  let cur = input.selfPid;
  let complete = false;
  for (let depth = 0; depth < 128; depth++) {
    if (cur <= 1) { complete = true; break; }
    if (seen.has(cur)) break;
    seen.add(cur);
    const p = input.lookup(cur);
    if (!p || p.pid !== cur) {
      if (chain.length === 0) break;
      const owner = input.meta?.(cur);
      if (owner && owner.uid !== chain[0]!.uid) { complete = true; break; }
      const last = chain[chain.length - 1]!;
      if (!owner && procNames(last, input.meta).some((n) => LOGIN_BOUNDARY_NAMES.includes(n))) { complete = true; break; }
      break;
    }
    if (chain.length > 0 && p.uid !== chain[0]!.uid) { complete = true; break; }
    chain.push(p);
    cur = p.ppid;
  }
  if (!complete || chain.length === 0) return { ok: false, reason: 'ancestry-unknown', line: 'eln proxy grant: refused — this terminal\'s process ancestry could not be fully observed' };
  // argv[0] is what names a version-named Claude Code: with a meta source, an ancestor whose argv[0] cannot be read
  // could hide an agent — fail closed (Terra #40304).
  if (input.meta && chain.some((p) => !input.meta!(p.pid)?.argv0)) return { ok: false, reason: 'ancestry-unknown', line: 'eln proxy grant: refused — a process above this terminal could not be identified (argv[0] unreadable)' };
  // Only this process itself (the eln runtime: bun/node) is exempt; any runtime above it — even a same-named one — refuses.
  // A process is an agent by its kernel name OR its argv[0] (Claude Code's kernel name is its version, e.g. 2.1.331).
  const self = chain[0]!;
  const selfNames = procNames(self, input.meta);
  if (!selfNames.some((n) => LAUNCHER_NAMES.has(n)) && selfNames.some((n) => AGENT_ANCESTOR_NAMES.includes(n))) return { ok: false, reason: 'agent-ancestor', line: `eln proxy grant: refused — launched by ${selfNames.join('/')}` };
  for (const p of chain.slice(1)) {
    const hit = procNames(p, input.meta).find((n) => AGENT_ANCESTOR_NAMES.includes(n));
    if (hit) return { ok: false, reason: 'agent-ancestor', line: `eln proxy grant: refused — this terminal runs inside ${hit} (pid ${p.pid}); open your own terminal` };
  }
  if (chain.some((p) => p.pid === input.runtimePid)) return { ok: false, reason: 'self-inside-runtime', line: 'eln proxy grant: refused — this command runs inside the runtime it would grant' };
  const runtime = input.lookup(input.runtimePid);
  if (!runtime || runtime.pid !== input.runtimePid) return { ok: false, reason: 'runtime-not-found', line: `eln proxy grant: no live process ${input.runtimePid}` };
  const uid = input.selfUid ?? chain[0]?.uid;
  if (uid !== undefined && runtime.uid !== uid) return { ok: false, reason: 'runtime-other-user', line: `eln proxy grant: process ${input.runtimePid} belongs to another user` };
  const runtimeNames = procNames(runtime, input.meta);
  if (!runtimeNames.some((n) => PROXY_RUNTIME_NAMES.includes(n))) return { ok: false, reason: 'runtime-not-claude', line: `eln proxy grant: process ${input.runtimePid} is ${runtimeNames.join('/')}, not a Claude Code session (claude)` };
  return { ok: true, runtime };
}

/** A short confirm code the person reads on screen and types back. */
export function grantConfirmCode(): string { return randomBytes(3).toString('hex').toUpperCase(); }

export interface AuditRow {
  readonly at: string;
  readonly event: 'grant' | 'revoke' | 'action' | 'refused';
  readonly principal: string;
  readonly op?: string;
  readonly target?: string;
  readonly result?: string;
  readonly reason?: string;
  readonly pid?: number;
  readonly grantId?: string;
  readonly runtimePid?: number;
}

/** One audit row (0600 · append). Throws on an I/O failure — a proxy action without its audit row does not run. */
export function appendProxyAudit(stateRoot: string, row: AuditRow): void {
  mkdirSync(proxyDir(stateRoot), { recursive: true, mode: 0o700 });
  appendFileSync(proxyAuditFile(stateRoot), `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

export function writeProxyGrant(stateRoot: string, runtime: ProcInfo, now: number = Date.now(), principal = PROXY_PRINCIPAL): ProxyGrant {
  const grant: ProxyGrant = {
    principal, role: PROXY_ROLE, grantId: randomBytes(12).toString('hex'),
    runtime: { pid: runtime.pid, start: runtime.start, name: runtime.name, uid: runtime.uid },
    grantedAt: new Date(now).toISOString(), expiresAt: new Date(now + PROXY_GRANT_TTL_MS).toISOString(), grantedVia: 'tty',
  };
  mkdirSync(proxyDir(stateRoot), { recursive: true, mode: 0o700 });
  // The audit row first: a grant file without its row is ignored by verifyProxyCaller.
  appendProxyAudit(stateRoot, { at: grant.grantedAt, event: 'grant', principal, grantId: grant.grantId, runtimePid: runtime.pid, pid: process.pid });
  const file = proxyGrantsFile(stateRoot);
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ [principal]: grant }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, file);
  return grant;
}

export function revokeProxyGrant(stateRoot: string, principal = PROXY_PRINCIPAL, now: number = Date.now()): boolean {
  const file = proxyGrantsFile(stateRoot);
  if (!existsSync(file)) return false;
  const { grant } = readProxyGrant(stateRoot, principal);
  // The audit row first: a revoke without its record does not happen.
  appendProxyAudit(stateRoot, { at: new Date(now).toISOString(), event: 'revoke', principal, ...(grant ? { grantId: grant.grantId } : {}), pid: process.pid });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, '{}\n', { mode: 0o600, flag: 'wx' });
  renameSync(tmp, file);
  return true;
}

export type ProxyAuthority =
  | { readonly ok: true; readonly principal: string; readonly grantId: string; readonly notice: string }
  | { readonly ok: false; readonly line: string; readonly denied?: true };

export interface AuthorizeInput extends VerifyInput {
  readonly op: string;
  readonly target?: string;
  /** Post the one-line notice to OP (default: the msg ledger · fail-open). */
  readonly notify?: (line: string) => void;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

/**
 * The one entrance every proxy-capable door calls: deny-listed ops never pass · the op must be on the allow-list · the
 * caller must verify. An allowed action is audited (the action does not run if the audit row cannot be written) and a
 * «[Claude OP 대행]» notice goes to OP. A refused attempt is audited too.
 */
export function proxyAuthority(input: AuthorizeInput): ProxyAuthority {
  const principal = (input.principal ?? PROXY_PRINCIPAL).toUpperCase();
  const at = new Date(input.now ?? Date.now()).toISOString();
  const pid = input.pid ?? process.pid;
  const log = input.log ?? defaultLog;
  const refuse = (line: string, reason: string, denied?: true): ProxyAuthority => {
    try { appendProxyAudit(input.stateRoot, { at, event: 'refused', principal, op: input.op, ...(input.target ? { target: input.target } : {}), reason, pid }); } catch { /* the refusal stands either way */ }
    log('proxy.action', { op: input.op, result: 'refused', reason });
    return { ok: false, line, ...(denied ? { denied } : {}) };
  };
  if ((PROXY_DENIED_OPS as readonly string[]).includes(input.op)) return refuse(`proxy: ${input.op} never runs through the proxy (money · secrets · JUD veto · destructive git · pkill · CEO words stay with the CEO)`, 'denied-op', true);
  if (!(PROXY_ALLOWED_OPS as readonly string[]).includes(input.op)) return refuse(`proxy: ${input.op} is not on the proxy allow-list (${PROXY_ALLOWED_OPS.join(' · ')})`, 'not-allowed', true);
  const v = verifyProxyCaller(input);
  if (!v.ok) return refuse(v.line, v.reason);
  const notice = `[Claude OP 대행] ${input.op}${input.target ? ` ${input.target}` : ''}`;
  appendProxyAudit(input.stateRoot, { at, event: 'action', principal, op: input.op, ...(input.target ? { target: input.target } : {}), result: 'allowed', pid, grantId: v.grant.grantId });
  log('proxy.action', { op: input.op, result: 'allowed', hops: v.hops });
  try { (input.notify ?? defaultNotify)(notice); } catch { /* the audit row is the record; the notice is a courtesy */ }
  return { ok: true, principal, grantId: v.grant.grantId, notice };
}

function defaultLog(event: string, data: Record<string, unknown>): void {
  try { (require('../debug/log.js') as typeof import('../debug/log.js')).debug.log('proxy', event, data); } catch { /* fail-open */ }
}

/** The notice is a passive ledger row to OP (kind notice · digest, not a turn) — written directly, outside the post gate. */
function defaultNotify(line: string): void {
  const { openMsgStore, defaultMsgStorePath } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
  const store = openMsgStore(defaultMsgStorePath());
  try { store.post({ from: PROXY_PRINCIPAL, to: 'OP', kind: 'notice', body: line }); } finally { store.close(); }
}

/** The default state root (the elanous state dir of this universe). */
export function proxyStateRoot(): string {
  return (require('../autopilot/state-paths.js') as typeof import('../autopilot/state-paths.js')).elanousStateRoot();
}

/**
 * For a seat-resolving CLI: when `claimed` names the proxy (or nothing names a seat), and the caller verifies, act as OP
 * for `op` (audited · noticed). A claimed proxy that does not verify is refused — never silently another identity.
 */
export function resolveProxyActor(input: { readonly claimed: string | null | undefined; readonly op: ProxyOp; readonly target?: string; readonly stateRoot?: string; readonly lookup?: ProcLookup; readonly notify?: (line: string) => void; readonly now?: number }):
  { readonly kind: 'not-proxy' } | { readonly kind: 'proxy'; readonly actor: 'OP'; readonly notice: string } | { readonly kind: 'refused'; readonly line: string } {
  const claimed = (input.claimed ?? '').trim().toUpperCase();
  if (claimed !== PROXY_PRINCIPAL) return { kind: 'not-proxy' };
  const auth = proxyAuthority({ stateRoot: input.stateRoot ?? proxyStateRoot(), op: input.op, ...(input.target ? { target: input.target } : {}),
    ...(input.lookup ? { lookup: input.lookup } : {}), ...(input.notify ? { notify: input.notify } : {}), ...(input.now !== undefined ? { now: input.now } : {}) });
  return auth.ok ? { kind: 'proxy', actor: 'OP', notice: auth.notice } : { kind: 'refused', line: auth.line };
}

/**
 * A memoized sender for an operator door (update-all · update-seat · seat control): a claimed CLAUDE-OP
 * (`ELANOUS_TRACK=CLAUDE-OP`) that verifies is OP for this one command (one audit row · one notice); a claimed one that
 * does not verify is no seat (the door refuses it as before) with the reason on stderr; anything else keeps `fallback`.
 */
export function proxyAwareSender(op: ProxyOp, target: string, fallback: () => string | null,
  opts: { readonly claimed?: () => string | undefined; readonly stderr?: (line: string) => void; readonly stateRoot?: string; readonly lookup?: ProcLookup; readonly notify?: (line: string) => void } = {}): () => string | null {
  let memo: { readonly v: string | null } | undefined;
  return () => {
    if (memo) return memo.v;
    const r = resolveProxyActor({ claimed: (opts.claimed ?? (() => process.env.ELANOUS_TRACK))(), op, target,
      ...(opts.stateRoot ? { stateRoot: opts.stateRoot } : {}), ...(opts.lookup ? { lookup: opts.lookup } : {}), ...(opts.notify ? { notify: opts.notify } : {}) });
    if (r.kind === 'proxy') memo = { v: r.actor };
    else if (r.kind === 'refused') { (opts.stderr ?? ((l: string) => process.stderr.write(`${l}\n`)))(r.line); memo = { v: null }; }
    else memo = { v: fallback() };
    return memo.v;
  };
}

/**
 * For the els server (a socket peer, not this process): the verified proxy session acts on the tool door as OP and may
 * close a tab no seat owns without a person's prompt. `pid`/`expectStart` are the kernel peer and its pre-lookup start.
 * One audit row ⊕ OP notice per use. Undefined = not the proxy (the existing doors decide as before).
 */
export function proxyPeerAuthority(input: { readonly pid: number | undefined; readonly expectStart: string | undefined; readonly op: 'els-act' | 'els-close-unowned'; readonly target?: string;
  readonly stateRoot?: string; readonly lookup?: ProcLookup; readonly notify?: (line: string) => void; readonly now?: number }): { readonly grantId: string; readonly live: () => boolean } | undefined {
  if (input.pid === undefined || input.expectStart === undefined) return undefined;
  const stateRoot = input.stateRoot ?? proxyStateRoot();
  // Cheap pre-check without an audit row: an ordinary caller (no grant, not a descendant) leaves no trace.
  const pre = verifyProxyCaller({ stateRoot, pid: input.pid, expectStart: input.expectStart, ...(input.lookup ? { lookup: input.lookup } : {}), ...(input.now !== undefined ? { now: input.now } : {}) });
  if (!pre.ok) return undefined;
  const auth = proxyAuthority({ stateRoot, op: input.op, pid: input.pid, expectStart: input.expectStart, ...(input.target ? { target: input.target } : {}),
    ...(input.lookup ? { lookup: input.lookup } : {}), ...(input.notify ? { notify: input.notify } : {}), ...(input.now !== undefined ? { now: input.now } : {}) });
  if (!auth.ok) return undefined;
  const lookup = input.lookup;
  return { grantId: auth.grantId, live: () => verifyProxyCaller({ stateRoot, pid: input.pid, expectStart: input.expectStart, ...(lookup ? { lookup } : {}) }).ok };
}

/** A refused proxy attempt decided outside proxyAuthority (e.g. a JUD hold): one audit row, best effort. */
export function auditProxyRefusal(op: string, target: string, reason: string, stateRoot: string = proxyStateRoot(), now: number = Date.now()): void {
  try { appendProxyAudit(stateRoot, { at: new Date(now).toISOString(), event: 'refused', principal: PROXY_PRINCIPAL, op, target, reason, pid: process.pid }); } catch { /* the refusal stands either way */ }
}

/** The els server's close-tab path: did the kernel peer verify as the proxy? No audit here — it follows the final allow. */
export function proxyPeerVerified(input: { readonly pid: number | undefined; readonly expectStart: string | undefined; readonly stateRoot?: string; readonly lookup?: ProcLookup; readonly now?: number }): string | undefined {
  if (input.pid === undefined || input.expectStart === undefined) return undefined;
  const v = verifyProxyCaller({ stateRoot: input.stateRoot ?? proxyStateRoot(), pid: input.pid, expectStart: input.expectStart, ...(input.lookup ? { lookup: input.lookup } : {}), ...(input.now !== undefined ? { now: input.now } : {}) });
  return v.ok ? v.grant.grantId : undefined;
}

/** Record a proxy action a door ALLOWED after its own final authorization: audit row ⊕ OP notice. */
export function recordProxyAction(input: { readonly op: ProxyOp; readonly target: string; readonly grantId: string; readonly pid?: number; readonly stateRoot?: string; readonly notify?: (line: string) => void; readonly now?: number }): void {
  const stateRoot = input.stateRoot ?? proxyStateRoot();
  appendProxyAudit(stateRoot, { at: new Date(input.now ?? Date.now()).toISOString(), event: 'action', principal: PROXY_PRINCIPAL, op: input.op, target: input.target, result: 'allowed', grantId: input.grantId, ...(input.pid !== undefined ? { pid: input.pid } : {}) });
  try { (input.notify ?? defaultNotify)(`[Claude OP 대행] ${input.op} ${input.target}`); } catch { /* the audit row is the record */ }
}
