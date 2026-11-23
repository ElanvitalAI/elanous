import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { planCatchUp, shaMatches, type CatchUpPlan } from '../nexus/host-registry/catch-up.js';
import { desiredSha as readDesiredSha } from '../nexus/host-registry/desired-sha.js';
import { spawnElanousSync } from '../instance/spawn-elanous.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { defaultInstallRoot, defaultVerifyRestart, readInstallRecord, restartEdgeRail, runUpdateForInstallation, type SelfUpdateDeps, type SelfUpdateOptions, type SelfUpdateResult } from './self-update.js';

export interface CatchUpDeps extends SelfUpdateDeps {
  host?: string;
  desired?: () => string | undefined;
  railAllowed?: () => boolean | Promise<boolean>;
  recordHandoff?: (text: string, now: Date) => void | Promise<void>;
  /** Background hold notice: a seat-decision row plus OP seat mail. Never a CEO decision card. */
  raiseHitl?: (text: string, seat: string) => boolean | void | Promise<boolean | void>;
  /** Interactive OP approval for this run only; background catch-up leaves this absent. */
  approveOp?: (text: string) => boolean | Promise<boolean>;
  /** Trace of an approved interactive OP update (seat-decision row decided by the seat). Best effort; never a gate. */
  recordOpDecision?: (text: string, seat: string) => boolean | void | Promise<boolean | void>;
}

export function parseRailAllowed(stdout: string): boolean {
  try { return (JSON.parse(stdout) as { rules?: { rail?: unknown } }).rules?.rail === true; } catch { return false; }
}
export function defaultRailAllowed(script = join(homedir(), 'elanous-hq/seat-state/RES/tools/phase.py')): boolean {
  try {
    const r = Bun.spawnSync(['python3', script, '--json'], { timeout: 15_000 });
    return r.exitCode === 0 && parseRailAllowed(String(r.stdout));
  } catch { return false; }
}

function defaultHandoff(text: string, now: Date): void {
  const dir = join(homedir(), 'elanous-hq/seat-state/OP');
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  writeFileSync(join(dir, `HANDOFF-op-${stamp}.md`), `# HANDOFF (auto, catch-up)\n\n${text}\n`, { flag: 'wx' });
}
/** A held OP-seat update is a seat-level matter: it is recorded as a seat decision (`decisions record-seat`, not a CEO card) keyed by host+desired so a retry is idempotent. */
export function holdRecordArgs(seat: string, text: string, host: string, desired: string): string[] {
  return ['decisions', 'record-seat', '--seat', seat, '--title', 'OP seat self-update held', '--decision', `hold: ${text}`,
    '--delegation', 'self-update catch-up: OP seat is never restarted unattended', '--ref', `catch-up:${host}:${desired.slice(0, 12)}`];
}
export function holdMailArgs(seat: string, text: string): string[] {
  return ['msg', 'post', '--from', seat, '--to', 'OP', '--kind', 'alert', '--body', `[self-update] OP seat update held; run els update-all from the OP seat to apply. ${text}`];
}
export function opDecisionArgs(seat: string, text: string, host: string, desired: string): string[] {
  return ['decisions', 'record-seat', '--seat', seat, '--title', 'OP seat self-update approved', '--decision', `update: ${text}`,
    '--delegation', 'OP started this update and confirmed it on its terminal', '--ref', `catch-up-approved:${host}:${desired.slice(0, 12)}`];
}
/** A record-seat retry whose row already exists (same ref) is a success, not a failure. */
export function recordSeatSucceeded(status: number | null, stderr: string): boolean {
  return status === 0 || stderr.includes('seat decision source already recorded');
}
function spawnRecord(args: string[]): boolean {
  try { const r = spawnElanousSync(args, { timeout: 30_000 }); return recordSeatSucceeded(r.status, String(r.stderr ?? '')); } catch { return false; }
}
function spawnOk(args: string[]): boolean {
  try { return spawnElanousSync(args, { timeout: 30_000 }).status === 0; } catch { return false; }
}
/** Both the row and the OP mail must succeed; otherwise the notice is retried (the row is idempotent by ref). */
function defaultHold(host: string, desired: string) {
  return (text: string, seat: string): boolean => {
    const recorded = spawnRecord(holdRecordArgs(seat, text, host, desired));
    const mailed = spawnOk(holdMailArgs(seat, text));
    return recorded && mailed;
  };
}
interface HitlMarker { sha: string; handoff: boolean; raised: boolean }
function readMarker(file: string): HitlMarker | null {
  try { const m = JSON.parse(readFileSync(file, 'utf8')) as Partial<HitlMarker>; return typeof m.sha === 'string' ? { sha: m.sha, handoff: m.handoff === true, raised: m.raised === true } : null; } catch { return null; }
}

const LOCK_NAME = 'host-catch-up.lock';
const LOCK_UNOWNED_STALE_MS = 60_000;
function lockOwner(lock: string): string | undefined { try { return readFileSync(join(lock, 'owner'), 'utf8'); } catch { return undefined; } }
function ownerAlive(token: string | undefined): boolean {
  const pid = Number(token?.split('.')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
/** Remove a lock only if it is still the one observed AND its owner is dead (a live owner is never reclaimed, however long the install runs). Reclaimers are serialised by a guard dir. */
function reclaimDeadLock(lock: string, observed: string | undefined): boolean {
  const guard = `${lock}.reclaim`;
  try { mkdirSync(guard); } catch {
    try { if (Date.now() - statSync(guard).mtimeMs > LOCK_UNOWNED_STALE_MS) rmSync(guard, { recursive: true, force: true }); } catch { /* gone */ }
    return false;
  }
  try {
    const age = (() => { try { return Date.now() - statSync(lock).mtimeMs; } catch { return 0; } })();
    if (lockOwner(lock) !== observed || ownerAlive(observed) || (observed === undefined && age < LOCK_UNOWNED_STALE_MS)) return false;
    rmSync(lock, { recursive: true, force: true });
    return true;
  } finally { rmSync(guard, { recursive: true, force: true }); }
}
/** Host-wide mutex (owner-tokened mkdir lock). Returns a release function, or null when another live run holds it. */
function acquireHostLock(stateDir: string): (() => void) | null {
  mkdirSync(stateDir, { recursive: true });
  const lock = join(stateDir, LOCK_NAME);
  const token = `${process.pid}.${randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner'), token);
      return () => { if (lockOwner(lock) === token) rmSync(lock, { recursive: true, force: true }); };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      if (!reclaimDeadLock(lock, lockOwner(lock))) return null;
    }
  }
  return null;
}

/** Records the host's catch-up gate state (atomic write). SCOPE: record only — nothing in this PR reads host-assign-gate.json, so a closed gate does not yet stop any
 *  assignment. The record shape {host, gate, sha, at} is the contract for the follow-up consumer (HOST-ASSIGN-GATE-CONSUME: assignment candidate filter, which must also
 *  carry this host-local file to the assigning side, e.g. via the host ledger heartbeat). */
/*
 * GATE STATE MACHINE (host-assign-gate.json) — every write below follows "the safe side first, open only after proof":
 *
 *   state / event                                   write            why
 *   ---------------------------------------------   --------------   ---------------------------------------------------------------
 *   lock NOT acquired (another run is active)       closed           we cannot prove anything; the active run reopens after its proof
 *   lock acquired, existing gate not closed         closed (first)   an older open must not survive verification/install/crash
 *   refusal (seat/rollback/non-dev/unknown sha)     closed           cannot prove the host is current
 *   plan says not current / hitl / rail off         closed           behind or unverifiable
 *   install / restart / health / checkout failure   closed (stays)   nothing reopens it on a failure path
 *   proof passed (installed record, running daemon  open             ONLY via openGate(): desired is re-read just before the write
 *     sha and a fresh desired all agree)                              and must still match; a changed desired keeps it closed, exit 1
 *   lock released                                   —                the file keeps the last proven state
 * The only two places that write `open` are the "already current" plan and the end of a successful restart; both go through openGate().
 */
function writeGate(stateDir: string, host: string, gate: CatchUpPlan['assignGate'], sha: string, now: Date): void {
  const file = join(stateDir, 'host-assign-gate.json');
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ host, gate, sha, at: now.toISOString() }, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Existing gate that is open, unreadable or malformed is closed before any verification starts (a missing file is left alone). */
function closeGateIfNotClosed(stateDir: string, host: string, sha: string, now: Date): void {
  const file = join(stateDir, 'host-assign-gate.json');
  if (!existsSync(file)) return;
  let gate: unknown;
  try { gate = (JSON.parse(readFileSync(file, 'utf8')) as { gate?: unknown }).gate; } catch { gate = undefined; }
  if (gate !== 'closed') writeGate(stateDir, host, 'closed', sha, now);
}

/** `self-update --catch-up`: a dev-channel host follows desiredSha (not the latest release); no rehearsal / gate / publish steps; install is allowed only when phase rules.rail is true. */
export async function runCatchUp(options: SelfUpdateOptions, deps: CatchUpDeps = {}): Promise<SelfUpdateResult> {
  // checkout move, install and gate writes of two runs must not interleave: one run per host at a time (a dry run writes nothing).
  if (options.dryRun) return runCatchUpLocked(options, deps);
  const stateDir = deps.stateDir ?? elanousStateRoot();
  const release = acquireHostLock(stateDir);
  if (!release) {
    const out = deps.out ?? console;
    const reason = 'another catch-up run holds the host lock; gate closed';
    try { writeGate(stateDir, deps.host ?? hostname(), 'closed', 'unknown', (deps.now ?? (() => new Date()))()); } catch { /* reported by exit code */ }
    const result: SelfUpdateResult = { exitCode: 1, installedVersion: null, decision: null, restarted: false, reason };
    out.log(options.json ? JSON.stringify(result) : `self-update --catch-up: ${reason}`);
    if (options.alert) (deps.alert ?? out.error)(`self-update --catch-up failed: ${reason}`);
    return result;
  }
  try { return await runCatchUpLocked(options, deps); } finally { release(); }
}

async function runCatchUpLocked(options: SelfUpdateOptions, deps: CatchUpDeps): Promise<SelfUpdateResult> {
  const out = deps.out ?? console;
  const root = deps.installRoot ?? defaultInstallRoot();
  const record = readInstallRecord(root);
  const host = deps.host ?? hostname();
  const stateDir = deps.stateDir ?? elanousStateRoot();
  const now = (deps.now ?? (() => new Date()))();
  const readDesired = (): string | undefined => (deps.desired ?? (() => readDesiredSha()))();
  const desired = readDesired();
  if (!options.dryRun) closeGateIfNotClosed(stateDir, host, record?.commit ?? 'unknown', now);
  const done = (exitCode: 0 | 1 | 2, reason: string, restarted = false): SelfUpdateResult => {
    const result: SelfUpdateResult = { exitCode, installedVersion: null, decision: null, restarted, reason };
    out.log(options.json ? JSON.stringify(result) : `self-update --catch-up: ${reason}`);
    if (options.alert && exitCode !== 0) (deps.alert ?? out.error)(`self-update --catch-up failed: ${reason}`);
    return result;
  };
  // Every refusal below records the gate as closed first: a gate opened by an earlier run must not outlive a run that cannot prove the host is current.
  const refuse = (exitCode: 1 | 2, reason: string, sha?: string): SelfUpdateResult => {
    if (!options.dryRun) writeGate(stateDir, host, 'closed', sha ?? desired ?? record?.commit ?? 'unknown', now);
    return done(exitCode, `${reason}; gate closed`);
  };
  if (options.seat !== 'OP' && options.seat !== 'TC' && options.seat !== 'MK' && options.seat !== 'UX') return refuse(2, '--catch-up requires a known --seat (OP|TC|MK|UX)');
  if (options.rollback || options.version) return refuse(2, '--catch-up cannot be combined with --rollback or --version');
  const approved = options.expectedDesired;
  if (approved !== undefined && (!/^[a-f0-9]{40}$/i.test(approved) || desired?.toLowerCase() !== approved.toLowerCase()))
    return refuse(1, 'approved desired sha changed');
  // A non-dev or unreadable install must never fall back to a normal update (it would bypass desiredSha / rail / OP protection).
  if (record?.channel !== 'dev') return refuse(2, '--catch-up requires a readable dev-channel install record; refusing normal update');
  const rail = await (async () => (deps.railAllowed ?? defaultRailAllowed)())().catch(() => false);
  if (!record.commit || !desired) return refuse(2, 'installed or desired sha unknown');
  const verify = deps.verifyRestart ?? defaultVerifyRestart;
  const installedMatches = shaMatches(record.commit, desired);
  let daemonSha: string | undefined;
  if (installedMatches) { const h = await verify(desired).catch(() => ({ ok: false } as { ok: boolean; daemonSha?: string })); if (h.ok) daemonSha = h.daemonSha; }
  const plan = planCatchUp({ host, installedSha: record.commit, daemonSha, desiredSha: desired, seatIsOp: options.seat === 'OP', railAllowed: rail });
  // The only `open` writers: re-read desired right before writing and require installed record, running daemon and fresh desired to all agree.
  const openGate = (daemon: string | undefined): boolean => {
    const again = readDesired();
    const installedNow = readInstallRecord(root)?.commit ?? '';
    if (!again || !daemon || !shaMatches(again, desired) || !shaMatches(installedNow, again) || !shaMatches(daemon, again)) return false;
    writeGate(stateDir, host, 'open', again, now);
    return true;
  };
  if (!options.dryRun) {
    if (plan.assignGate === 'open') { if (!openGate(daemonSha)) return refuse(1, 'desired sha changed or installed/daemon sha disagrees at the moment of opening'); }
    else writeGate(stateDir, host, 'closed', desired, now);
  }
  const marker = join(stateDir, 'host-hitl-raised.json');
  // Leaving the hitl state (recovered or no longer behind) ends that incident: a later relapse at the same desired sha is a new one and raises again.
  if (plan.action !== 'hitl' && !options.dryRun) rmSync(marker, { force: true });
  if (plan.action === 'none') {
    if (approved !== undefined && readInstallRecord(root)?.commit?.toLowerCase() !== approved.toLowerCase()) return refuse(1, 'installed sha differs from approved desired');
    return done(0, plan.reason);
  }
  if (plan.action === 'hitl') {
    const prior = readMarker(marker);
    const state: HitlMarker = { sha: desired, handoff: prior?.sha === desired && prior.handoff, raised: prior?.sha === desired && prior.raised };
    if (options.dryRun) return done(0, plan.reason);
    const text = `${plan.reason}. host ${host}, installed ${record.commit.slice(0, 12)}, desired ${desired.slice(0, 12)}. Update/restart held until OP runs it from its seat.`;
    // Two independent actions: one failing never skips the other; each success is remembered so a retry repeats only what is missing.
    const failures: string[] = [];
    const attempt = async (name: string, act: () => Promise<boolean | void> | boolean | void): Promise<boolean> => {
      try { if ((await act()) === false) throw new Error('reported failure'); return true; } catch (e) { failures.push(`${name}: ${String(e).slice(0, 200)}`); return false; }
    };
    if (!state.handoff) state.handoff = await attempt('handoff', () => (deps.recordHandoff ?? defaultHandoff)(text, now));
    // OP started an interactive run and answers on its own terminal: that answer is the decision, so no hold notice is sent.
    if (!deps.approveOp && !state.raised) state.raised = await attempt('hold notice', () => (deps.raiseHitl ?? defaultHold(host, desired))(text, options.seat ?? 'OP'));
    if (!prior || state.handoff !== prior.handoff || state.raised !== prior.raised) {
      try { writeFileSync(marker, JSON.stringify(state)); } catch (e) { failures.push(`marker: ${String(e).slice(0, 200)}`); }
    }
    if (failures.length) {
      (deps.alert ?? out.error)(`hold notice incomplete (will retry the missing part): ${failures.join(' | ')} — ${text}`);
      return done(1, `${plan.reason}; hold notice incomplete: ${failures.join(' | ')}`);
    }
    if (!deps.approveOp) return done(0, plan.reason);
    if (!rail) return refuse(1, 'rail not allowed by current phase');
    let approved = false;
    try { approved = await deps.approveOp(text); } catch { return refuse(1, 'OP approval unavailable'); }
    if (!approved) return refuse(1, `${plan.reason}; approval denied`);
    // The human may have spent the whole prompt window deciding. A phase change during that wait revokes this run's install authority.
    const railAfterApproval = await (async () => (deps.railAllowed ?? defaultRailAllowed)())().catch(() => false);
    if (!railAfterApproval) return refuse(1, 'rail not allowed after OP approval');
    if (!shaMatches(readDesired() ?? '', desired)) return refuse(1, 'desired sha changed after OP approval');
    const approvedText = `OP approved on its terminal. host ${host}, installed ${record.commit.slice(0, 12)}, desired ${desired.slice(0, 12)}.`;
    try { await (deps.recordOpDecision ?? ((t: string, seat: string) => spawnRecord(opDecisionArgs(seat, t, host, desired))))(approvedText, options.seat ?? 'OP'); } catch { /* trace only */ }
  }
  if (options.dryRun) return done(0, `${plan.reason} (dry run)`);
  if (approved !== undefined && readDesired()?.toLowerCase() !== approved.toLowerCase()) return refuse(1, 'approved desired sha changed before install');
  const checkout = options.from ?? record.source;
  if (!installedMatches) {
    const git = deps.git ?? ((cwd: string, args: string[]) => { const r = Bun.spawnSync(['git', ...args], { cwd }); return { status: r.exitCode, stdout: String(r.stdout), stderr: String(r.stderr) }; });
    if (!checkout || /^(?:https?:|file:)/.test(checkout) || !existsSync(join(checkout, 'scripts', 'install.sh'))) return done(1, 'local checkout unknown — use --from');
    const gate = (why: string): SelfUpdateResult => done(1, `${why}; gate stays closed`);
    for (const args of [['diff', '--quiet', 'HEAD', '--'], ['fetch', '--quiet', 'origin'], ['cat-file', '-e', `${desired}^{commit}`]]) if (git(checkout, args).status !== 0) return gate(`git ${args[0]} failed`);
    if (git(checkout, ['ls-files', '--others', '--exclude-standard']).stdout.trim()) return gate('checkout contains untracked files');
    // The install builds from this checkout, so it is moved to desired only for the install and put back afterwards (branch or detached HEAD as found).
    const branch = git(checkout, ['symbolic-ref', '-q', '--short', 'HEAD']);
    const origBranch = branch.status === 0 ? branch.stdout.trim() : '';
    const origSha = git(checkout, ['rev-parse', '--verify', 'HEAD']).stdout.trim();
    if (!origBranch && !origSha) return gate('checkout HEAD unknown');
    // git silently overwrites IGNORED untracked files (node_modules, local config) that desired tracks — refuse instead, naming paths only (never values).
    const ignored = git(checkout, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard']);
    const tracked = git(checkout, ['ls-tree', '-r', '-z', '--name-only', desired]);
    if (ignored.status !== 0 || tracked.status !== 0) return gate('could not list ignored/tracked paths');
    // A collision is an equal path, a desired file ABOVE an ignored local path (ignored foo/bar vs tracked foo), or a desired path BELOW an ignored local file (ignored foo vs tracked foo/baz).
    const localFiles = new Set(ignored.stdout.split('\0').filter(Boolean));
    const localDirs = new Set<string>();
    for (const file of localFiles) for (let i = file.indexOf('/'); i !== -1; i = file.indexOf('/', i + 1)) localDirs.add(file.slice(0, i));
    const clash = tracked.stdout.split('\0').filter((path) => {
      if (!path || localFiles.has(path) || localDirs.has(path)) return Boolean(path);
      for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) if (localFiles.has(path.slice(0, i))) return true;
      return false;
    });
    if (clash.length) return gate(`desired tracks ${clash.length} path(s) that exist locally as ignored files (not overwritten): ${clash.slice(0, 10).join(', ')}${clash.length > 10 ? ', …' : ''}`);
    if (git(checkout, ['checkout', '--quiet', '--detach', desired]).status !== 0) return gate('git checkout failed');
    let installed: SelfUpdateResult;
    try {
      installed = await (deps.installEdgeRail ?? ((next, injected) => runUpdateForInstallation(next, { cliRoot: injected.cliRoot, checkout: injected })))(
        { from: checkout, dev: true, restart: false }, { ...deps, notice: () => {}, out: { log: () => {}, error: () => {} } });
    } catch (e) { installed = { exitCode: 1, installedVersion: null, decision: null, restarted: false, reason: String(e).slice(0, 200) }; }
    const restored = git(checkout, origBranch ? ['checkout', '--quiet', origBranch] : ['checkout', '--quiet', '--detach', origSha]).status === 0;
    if (!restored) return gate(`checkout could not be restored to ${origBranch || origSha.slice(0, 12)}`);
    if (installed.exitCode !== 0) return gate(`install failed: ${installed.reason}`);
    const installedCommit = readInstallRecord(root)?.commit ?? '';
    if (approved !== undefined ? installedCommit.toLowerCase() !== approved.toLowerCase() : !shaMatches(installedCommit, desired))
      return gate('installed commit not confirmed against approved desired');
  }
  if (approved !== undefined && readDesired()?.toLowerCase() !== approved.toLowerCase()) return refuse(1, 'approved desired sha changed after install');
  if (approved !== undefined && readInstallRecord(root)?.commit?.toLowerCase() !== approved.toLowerCase()) return refuse(1, 'installed sha differs from approved desired');
  if (!options.restart) return done(0, 'desired sha installed; restart not requested, gate stays closed');
  if (!(await restartEdgeRail(deps, checkout ?? ''))) return done(1, 'restart not confirmed; gate stays closed');
  const health = await verify(desired);
  if (!health.ok || !health.daemonSha || !shaMatches(health.daemonSha, desired)) return done(1, 'restarted build health not confirmed; gate stays closed', true);
  if (!openGate(health.daemonSha)) return refuse(1, 'desired sha changed during catch-up (or installed/daemon sha disagrees); will retry');
  return done(0, `caught up to ${desired.slice(0, 12)}; gate open`, true);
}
