// 수호자 — sanitize = TEST-UNIVERSE-REAPER (LLM 0).
//
// S: 11-27 07:3x — node-b (32 cpu) load 135: 234 orphaned test-universe processes (els holder-main · elanous --tui · bun test under
//    /tmp · /private/tmp · /var/tmp · ~/elanous-hq/cx*-els-*) alive 1–16 days, plus 16-day test-profile Chrome renderers at
//    100 %; mbp 40 · node-c 13 · mshq 8 more. They were killed by hand, by exact PID.
// C: a test universe had no owner after its launcher died — nothing recorded what it started or when it should end.
// A: launchers register {host · pid · pgid · command prefix · TTL (2 h default)} in a reaper registry; the guardian's sanitize
//    step lists each host's processes (one `ps`, no LLM) and kills, by exact PID only, (a) registered groups past their TTL and
//    (b) unregistered processes that look like a test universe, are orphaned (parent gone / ppid 1) and older than 2 h. Every
//    kill is re-verified against the same command right before it (no PID reuse) and leaves one audit row. `eln res reap`.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

export const REAP_TTL_MS = 2 * 60 * 60_000;
export const ORPHAN_MIN_AGE_MS = 2 * 60 * 60_000;

export interface Proc { readonly pid: number; readonly ppid: number; readonly pgid: number; readonly ageMs: number; readonly cpu: number; readonly command: string }
export interface Registration { readonly host: string; readonly pid: number; readonly pgid: number; readonly cmd: string; readonly at: string; readonly ttlMs: number; readonly by: string }
export interface ReapCandidate { readonly pid: number; readonly pgid: number; readonly ageMs: number; readonly cpu: number; readonly command: string; readonly why: string }

/** Test-universe shapes (structural path/flag markers of isolated runs — never a person's own session). */
const TMP = String.raw`(?:\/private)?\/(?:tmp|var\/tmp|var\/folders)\/`;
// A test universe is recognised by its ISOLATED STATE ROOT (a temp --state-root / --config-dir / --test-state-dir), a cx*-els-*
// test tree, a bun test run over temp paths, or a test-profile browser — never by a temp cwd alone (a real seat pane can sit
// in /tmp). Anything that names the production state root (~/.elanous) is never a test universe.
const TEST_UNIVERSE: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'test-state-dir', re: /--test-state-dir\b/u },
  { name: 'tmp-state-root', re: new RegExp(String.raw`--(?:state-root|config-dir)[ =]${TMP}`, 'u') },
  { name: 'els-test-tree', re: /elanous-hq\/cx[\w-]*-els-[\w.-]*\//u },
  { name: 'bun-test-tmp', re: new RegExp(String.raw`\bbun\b\S*\s+test\s+${TMP}`, 'u') },
  { name: 'chrome-test-profile', re: new RegExp(String.raw`(?:Chrome|Chromium)[^/]*Helper.*--user-data-dir=${TMP}`, 'u') },
];
const PRODUCTION_ROOT = /--(?:state-root|config-dir)[ =]\/Users\/[^/\s]+\/\.elanous(?:\s|$)/u;
export const testUniverseShape = (command: string): string | null => (PRODUCTION_ROOT.test(command) ? null : TEST_UNIVERSE.find(t => t.re.test(command))?.name ?? null);

/** `[[dd-]hh:]mm:ss` (ps etime) → ms. */
export function parseEtime(s: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(s.trim());
  if (!m) return 0;
  return (((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000;
}
/** `ps -axo pid=,ppid=,pgid=,etime=,pcpu=,command=` → procs. */
export function parsePs(text: string): Proc[] {
  return text.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(.*)$/u.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), ageMs: parseEtime(m[4]!), cpu: Number(m[5]), command: m[6]!.trim() }] : [];
  });
}

/** Pure: what to kill on one host. `self` = pids that must never be touched (this process and its parents). */
export function planReap(procs: readonly Proc[], registry: readonly Registration[], nowMs: number, opts: { self?: ReadonlySet<number> } = {}): ReapCandidate[] {
  const alive = new Set(procs.map(p => p.pid));
  const out: ReapCandidate[] = [];
  const seen = new Set<number>();
  const push = (p: Proc, why: string) => { if (!seen.has(p.pid) && p.pid > 1 && !opts.self?.has(p.pid)) { seen.add(p.pid); out.push({ pid: p.pid, pgid: p.pgid, ageMs: p.ageMs, cpu: p.cpu, command: p.command.slice(0, 200), why }); } };
  // (a) registered groups past their TTL — every live member of the group, still matching the registered command prefix for the leader
  for (const r of registry) {
    if (nowMs - Date.parse(r.at) < r.ttlMs) continue;
    const leader = procs.find(p => p.pid === r.pid);
    if (leader && !leader.command.startsWith(r.cmd.slice(0, 40))) continue; // PID reused by something else
    for (const p of procs) if (p.pgid === r.pgid && r.pgid > 1) push(p, `registered ${r.by} ttl ${Math.round(r.ttlMs / 60_000)}m expired`);
  }
  // (b) unregistered orphans shaped like a test universe, older than 2 h
  for (const p of procs) {
    const shape = testUniverseShape(p.command);
    if (!shape || p.ageMs < ORPHAN_MIN_AGE_MS) continue;
    const orphan = p.ppid === 1 || !alive.has(p.ppid);
    if (orphan) push(p, `orphan ${shape} ${Math.round(p.ageMs / 3_600_000)}h`);
  }
  return out;
}

// ── registry ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const reaperRegistryPath = (stateRoot: string): string => join(stateRoot, 'res', 'reaper', 'registry.jsonl');
export const reaperAuditPath = (stateRoot: string): string => join(stateRoot, 'res', 'reaper', 'audit.jsonl');
const shortHost = (): string => hostname().split('.')[0]!.toLowerCase();

/** A test-universe launcher calls this once with its own process group (fail-open). */
export function registerTestUniverse(stateRoot: string, input: { pid?: number; pgid?: number; cmd: string; ttlMs?: number; by: string; now?: Date }): boolean {
  try {
    const p = reaperRegistryPath(stateRoot); mkdirSync(dirname(p), { recursive: true });
    const pid = input.pid ?? process.pid;
    const row: Registration = { host: shortHost(), pid, pgid: input.pgid ?? pid, cmd: input.cmd.slice(0, 200), at: (input.now ?? new Date()).toISOString(), ttlMs: input.ttlMs ?? REAP_TTL_MS, by: input.by };
    appendFileSync(p, `${JSON.stringify(row)}\n`);
    return true;
  } catch { return false; }
}
export function readRegistry(text: string): Registration[] {
  return text.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as Registration]; } catch { return []; } });
}
export function readLocalRegistry(stateRoot: string): Registration[] {
  const p = reaperRegistryPath(stateRoot);
  return existsSync(p) ? readRegistry(readFileSync(p, 'utf8')) : [];
}

// ── live: list · kill (exact PID, re-verified) ───────────────────────────────────────────────────────────────────────

const PS = `ps -U ${JSON.stringify(userInfo().username)} -axo pid=,ppid=,pgid=,etime=,pcpu=,command=`;
function run(host: string, script: string, timeoutMs = 20_000): { ok: boolean; out: string } {
  const local = host === shortHost();
  const r = local ? spawnSync('sh', ['-c', script], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
    : spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, script], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}
export function listProcs(host: string): Proc[] | null { const r = run(host, PS); return r.ok ? parsePs(r.out) : null; }
export function remoteRegistry(host: string): Registration[] {
  if (host === shortHost()) return [];
  const r = run(host, 'cat ~/.elanous/res/reaper/registry.jsonl 2>/dev/null');
  return r.ok ? readRegistry(r.out) : [];
}

/** Kill by exact PID: each pid is re-checked to still run the same command (first 60 chars), TERM, then KILL after 5 s. */
export function killExact(host: string, cands: readonly ReapCandidate[]): { killed: number[]; skipped: number[] } {
  if (!cands.length) return { killed: [], skipped: [] };
  const sq = (t: string) => `'${t.replace(/'/gu, `'\\''`)}'`; // single-quoted: nothing in a command line expands
  const lines = cands.map(c => `p=${c.pid}; c=$(ps -o command= -p $p 2>/dev/null | cut -c1-60); [ "$c" = ${sq(c.command.slice(0, 60))} ] && kill -TERM $p 2>/dev/null && echo K$p || echo S$p`);
  const script = `${lines.join('\n')}\nsleep 5\n${cands.map(c => `kill -0 ${c.pid} 2>/dev/null && kill -KILL ${c.pid} 2>/dev/null`).join('\n')}\ntrue`;
  const r = run(host, script, 60_000);
  const killed = [...r.out.matchAll(/^K(\d+)$/gmu)].map(m => Number(m[1]));
  const skipped = [...r.out.matchAll(/^S(\d+)$/gmu)].map(m => Number(m[1]));
  return { killed, skipped };
}

export const reaperLockPath = (stateRoot: string): string => join(stateRoot, 'res', 'reaper', 'reap.lock');
/** One reaper action at a time on this install: every actor (guardian sanitize · the macrophage card) takes this lock around
 *  plan-check → kill → audit, so one target is signalled and audited once (dead holder broken at once · 2 min stale). */
export function withReapLock<T>(stateRoot: string, fn: () => T): T {
  mkdirSync(dirname(reaperLockPath(stateRoot)), { recursive: true });
  const { withFileLockSync } = require('../storage/file-lock.js') as typeof import('../storage/file-lock.js');
  return withFileLockSync(reaperLockPath(stateRoot), fn, { breakDeadHolder: true, staleMs: 2 * 60_000 });
}

/** A target reaped within this window (by any actor · the shared audit) is not signalled again. */
export const RECENT_REAP_WINDOW_MS = 30 * 60_000; // 출처: decision 11-27 «one reaper» · macrophage recent_reap_min 30 (graphs/loop-agents/macrophage/agent.yaml)
/** `${host}:${pid}` of every audit row newer than `windowMs` — the whole time window, whoever wrote it (fail-open → empty). */
export function recentReaps(stateRoot: string, nowMs: number, windowMs = RECENT_REAP_WINDOW_MS): Set<string> {
  const out = new Set<string>();
  try {
    const p = reaperAuditPath(stateRoot);
    if (!existsSync(p)) return out;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line) as { at?: string; host?: string; pid?: number }; if (r.host && r.pid && r.at && nowMs - Date.parse(r.at) < windowMs) out.add(`${r.host}:${r.pid}`); } catch { /* torn line */ }
    }
  } catch { /* unknown → none */ }
  return out;
}

export function auditReap(stateRoot: string, row: Record<string, unknown>): void {
  try { const p = reaperAuditPath(stateRoot); mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, `${JSON.stringify(row)}\n`); } catch { /* audit is fail-open */ }
}
