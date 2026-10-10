import { spawnSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { logsDbPath, LogStore, type LogStoreRow, type LogQuery } from '../mss/logging/log-store.js';
import { getUserConfig } from '../user-config.js';
import { harnessQueuePath } from './harness-queue.js';
import { leaseKubectl, measurePoolLease, recommendConcurrency } from '../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool, resolvePodPoolSpec } from '../task-orchestrator/surfaces/pod-pool.js';
import { listCodexAccountsInStore } from '../oauth/codex-account-store.js';
import { defaultSshRunner, resolveParentHosts, type SshRunner } from '../task-agent/parent-host.js';

export const BUILD_STOP = 4;
export const BUILD_SLOW = 2;
export const QUEUE_STOP = 8;
export const QUEUE_SLOW = 4;
export const UNKNOWN_CAP = 1;

export type BackpressureSignal = number | 'unknown';
export interface BackpressureSignals {
  queueDepth: BackpressureSignal;
  admitWaiting: BackpressureSignal;
  admitStarvedOver30m: BackpressureSignal;
  dockerBuilds: { local: BackpressureSignal; remote: BackpressureSignal };
  podRecommended: BackpressureSignal;
  staleParents: BackpressureSignal;
  /**
   * Parts that could not be measured while the signal's number is still a measured lower bound (e.g. the remote
   * half of admitWaiting after an ssh failure, local half counted). Each part is an unknown (cap 1); the number
   * still applies so measured saturation keeps winning.
   */
  unmeasured?: string[];
}

const constants = { BUILD_STOP, BUILD_SLOW, QUEUE_STOP, QUEUE_SLOW, UNKNOWN_CAP };
const valid = (value: unknown): BackpressureSignal =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 'unknown';

/** Fixed, reviewable thresholds; observations are normalized before any arithmetic. */
export function decideBackpressure(input: BackpressureSignals, { maxPerCycle = 6 }: { maxPerCycle?: number } = {}) {
  const max = Number.isSafeInteger(maxPerCycle) && maxPerCycle >= 0 ? maxPerCycle : 6;
  const signals: BackpressureSignals = {
    queueDepth: valid(input.queueDepth), admitWaiting: valid(input.admitWaiting),
    admitStarvedOver30m: valid(input.admitStarvedOver30m),
    dockerBuilds: { local: valid(input.dockerBuilds?.local), remote: valid(input.dockerBuilds?.remote) },
    podRecommended: valid(input.podRecommended), staleParents: valid(input.staleParents),
  };
  const unmeasured = Array.isArray(input.unmeasured) ? input.unmeasured.filter((part): part is string => typeof part === 'string' && part.length > 0) : [];
  if (unmeasured.length) signals.unmeasured = unmeasured;
  const reasons: string[] = [];
  let budget = max;
  const unknown = (name: string, value: BackpressureSignal) => {
    if (value === 'unknown') { reasons.push(`unknown:${name}`); budget = Math.min(budget, UNKNOWN_CAP); }
  };
  for (const [name, value] of [
    ['queueDepth', signals.queueDepth], ['admitWaiting', signals.admitWaiting],
    ['admitStarvedOver30m', signals.admitStarvedOver30m],
    ['dockerBuilds.local', signals.dockerBuilds.local], ['dockerBuilds.remote', signals.dockerBuilds.remote],
    ['podRecommended', signals.podRecommended], ['staleParents', signals.staleParents],
  ] as const) unknown(name, value);
  for (const part of unmeasured) unknown(part, 'unknown');
  // A measured part is a lower bound on the unmeasured whole (counts are ≥ 0), so measured saturation still wins
  // over unknown: podRecommended alone bounds podRecommended−admitWaiting; one side's builds bound the total.
  if (signals.podRecommended !== 'unknown') {
    budget = Math.min(budget, Math.max(0, signals.podRecommended - (signals.admitWaiting === 'unknown' ? 0 : signals.admitWaiting)));
    reasons.push('podRecommended−admitWaiting');
  }
  if (signals.admitStarvedOver30m !== 'unknown' && signals.admitStarvedOver30m >= 1) {
    budget = 0; reasons.push('admit-starved');
  }
  if (signals.dockerBuilds.local !== 'unknown' || signals.dockerBuilds.remote !== 'unknown') {
    // Each side is clamped at BUILD_STOP before adding: the sum stays a small safe integer and saturation is kept.
    const side = (n: BackpressureSignal) => n === 'unknown' ? 0 : Math.min(n, BUILD_STOP);
    const builds = side(signals.dockerBuilds.local) + side(signals.dockerBuilds.remote);
    if (builds >= BUILD_SLOW) {
      budget = Math.min(budget, builds >= BUILD_STOP ? 0 : Math.floor(max / 2));
      reasons.push('docker-builds');
    }
  }
  if (signals.queueDepth !== 'unknown' && signals.queueDepth >= QUEUE_SLOW) {
    budget = Math.min(budget, signals.queueDepth >= QUEUE_STOP ? 0 : Math.floor(max / 2));
    reasons.push('queue-depth');
  }
  if (signals.staleParents !== 'unknown' && signals.staleParents > 0) reasons.push(`stale-parents:${signals.staleParents}`);
  return { launchBudget: Math.max(0, Math.min(max, Math.floor(budget))), reasons, signals, constants };
}

const LOG_LIMIT = 1000;
const LOG_WINDOW_MS = 35 * 60_000;
const WAIT_FRESH_MS = 5 * 60_000;
const STARVED_MS = 30 * 60_000;
const REMOTE_PS_MARKER = '__ELANOUS_BACKPRESSURE_PS__';

type AdmissionRow = Pick<LogStoreRow, 'ts_ms' | 'data'>;
export interface BackpressureReadDeps {
  now?: () => number;
  queue?: () => unknown;
  podRecommended?: () => number | null;
  logs?: (query: LogQuery) => readonly AdmissionRow[];
  ps?: () => string;
  currentVersion?: () => string;
  parentHost?: () => { host: string; elanous?: string } | readonly { host: string; elanous?: string }[] | null;
  ssh?: SshRunner;
}

function readQueue(): unknown {
  return JSON.parse(readFileSync(harnessQueuePath(), 'utf8'));
}

/** Same pool, usage and recommendation inputs as pod lease status; DNS is deliberately skipped (no disposable Pod). */
function readPodRecommendation(): number | null {
  const config = getUserConfig();
  const spec = resolvePodPoolSpec(undefined, process.env, () => config.harness?.podPool ?? config.pod?.pool);
  const current = spec ? null : leaseKubectl(['config', 'current-context']);
  const context = spec ?? (current?.status === 0 ? current.stdout.trim() : '');
  if (!context) return null;
  const members = parsePodPool(context);
  const measure = measurePoolLease(members, { measureUsage: true, skipDnsProbe: true });
  let accounts = -1;
  try { accounts = listCodexAccountsInStore().length; } catch { /* Accounts are only observed, not a limit. */ }
  return recommendConcurrency(measure, { capacity: members.reduce((sum, member) => sum + member.capacity, 0),
    accounts, perAccount: config.pod?.lease?.perAccount ?? 4 }).recommended;
}

function readLocalAdmission(query: LogQuery): readonly AdmissionRow[] {
  const store = LogStore.openReadOnly(logsDbPath());
  try { return store.query(query); } finally { store.close(); }
}

function processOutput(): string {
  const result = spawnSync('ps', ['-Ao', 'command'], { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') throw new Error('ps unavailable');
  return result.stdout;
}

/**
 * Counts docker *client* processes only (argv[0] is `docker`): a wrapping `sh -c "… docker build …"` line
 * (remote build.sh runs over ssh that way) and the `docker-buildx` plugin child would otherwise double-count one build.
 * Rail bakes labelled `elanous.builder=rail` are excluded — only launch bakes slow launches (OP 02:06 review note).
 */
function countBuilds(ps: string): number {
  return ps.split('\n').filter((line) => /^(?:\S*\/)?docker\s+(?:buildx\s+build|build)(?:\s|$)/.test(line.trim())
    && !/elanous\.builder=rail(?:\s|$|['"])/.test(line)).length;
}

function countStaleParents(ps: string, version: string): number {
  return ps.split('\n').filter((line) => /\bharness\s+(?:say|ask)\b/.test(line)
    && /\/\.local\/share\/elanous\/versions\/([^/\s]+)\//.test(line)
    && /\/\.local\/share\/elanous\/versions\/([^/\s]+)\//.exec(line)![1] !== version).length;
}

function admissionCounts(rows: readonly AdmissionRow[], now: number): { waiting: BackpressureSignal; starved: BackpressureSignal } {
  if (!Array.isArray(rows) || rows.length >= LOG_LIMIT) return { waiting: 'unknown', starved: 'unknown' };
  const byRun = new Map<string, { firstZero: number | null; last: number; recommended: number }>();
  for (const row of [...rows].sort((a, b) => a.ts_ms - b.ts_ms)) {
    let data: unknown;
    try { data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data; } catch { return { waiting: 'unknown', starved: 'unknown' }; }
    const value = data as { runId?: unknown; recommended?: unknown } | null;
    if (!value || typeof value !== 'object' || !Number.isFinite(row.ts_ms)) return { waiting: 'unknown', starved: 'unknown' };
    // Rows without a runId come from non-run callers (`pod lease status`, this command's own pool read) — not a waiting
    // parent. A null recommendation is an unmeasured sample, not «recommended 0». Neither is a parent wait signal.
    if (typeof value.runId !== 'string' || !value.runId || value.recommended === null) continue;
    if (!Number.isSafeInteger(value.recommended) || (value.recommended as number) < 0) return { waiting: 'unknown', starved: 'unknown' };
    if (row.ts_ms < now - LOG_WINDOW_MS || row.ts_ms > now) continue;
    const recommended = value.recommended as number;
    const previous = byRun.get(value.runId);
    // Starvation is a continuous zero streak: a recovery (recommended > 0) resets it.
    byRun.set(value.runId, { firstZero: recommended === 0 ? previous?.firstZero ?? row.ts_ms : null,
      last: row.ts_ms, recommended });
  }
  let waiting = 0, starved = 0;
  for (const run of byRun.values()) {
    if (run.recommended !== 0 || now - run.last > WAIT_FRESH_MS) continue;
    waiting++;
    if (run.firstZero !== null && now - run.firstZero >= STARVED_MS) starved++;
  }
  return { waiting, starved };
}

function readRemote(host: { host: string; elanous?: string }, ssh: SshRunner): { rows: AdmissionRow[]; ps: string } {
  const executable = host.elanous ?? '$HOME/.local/share/elanous/bin/elanous';
  const escaped = executable === '$HOME/.local/share/elanous/bin/elanous' ? '"$HOME"/.local/share/elanous/bin/elanous'
    : `'${executable.replaceAll("'", "'\\''")}'`;
  const script = `${escaped} logs --event admit-by-usage --since 35m --json --limit ${LOG_LIMIT}; rc=$?; if [ "$rc" -ne 0 ]; then exit "$rc"; fi; printf '\\n${REMOTE_PS_MARKER}\\n'; ps -Ao command`;
  const result = ssh(host.host, script, 15_000);
  if (result.status !== 0) throw new Error(`remote observation unavailable: ${result.stderr}`);
  if (typeof result.stdout !== 'string') throw new Error('remote observation missing stdout');
  const index = result.stdout.indexOf(`\n${REMOTE_PS_MARKER}\n`);
  if (index < 0) throw new Error('remote observation incomplete');
  const logs = result.stdout.slice(0, index);
  const ps = result.stdout.slice(index + REMOTE_PS_MARKER.length + 2);
  if (!ps.trim()) throw new Error('remote ps unavailable');
  const rows: AdmissionRow[] = [];
  for (const line of logs.split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as Record<string, unknown>;
    if (row._meta && typeof row._meta === 'object' && (row._meta as { limitReached?: boolean }).limitReached === true) throw new Error('remote logs truncated');
    if (row._meta) continue;
    if (row.event !== 'admit-by-usage' || row.category !== 'pod-lease') throw new Error('remote logs invalid row');
    const ms = typeof row.ts_ms === 'number' ? row.ts_ms : Date.parse(String(row.ts ?? ''));
    rows.push({ ts_ms: ms, data: typeof row.data === 'string' ? row.data : JSON.stringify(row.data ?? null) });
  }
  if (rows.length >= LOG_LIMIT) throw new Error('remote logs truncated');
  return { rows, ps };
}

/** All probes are injectable; a failed individual observation is unknown, not a false zero. */
export function readBackpressureSignals(deps: BackpressureReadDeps = {}): BackpressureSignals {
  const now = (deps.now ?? Date.now)();
  if (!Number.isFinite(now)) throw new Error('backpressure clock unavailable');
  const query: LogQuery = { exactCategories: ['pod-lease'], events: ['admit-by-usage'], sinceMs: now - LOG_WINDOW_MS, limit: LOG_LIMIT };
  const attempt = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };
  const queue = attempt(() => (deps.queue ?? readQueue)(), null);
  const queueDepth = Array.isArray(queue) && queue.every((row) => row && typeof row === 'object'
    && ['queued', 'launching', 'launched', 'finished'].includes(row.status))
    ? queue.filter((row) => row.status === 'queued' || row.status === 'launching').length : 'unknown';
  const podRecommended = valid(attempt(() => (deps.podRecommended ?? readPodRecommendation)(), null));
  const local = attempt(() => admissionCounts((deps.logs ?? readLocalAdmission)(query), now), { waiting: 'unknown', starved: 'unknown' } as ReturnType<typeof admissionCounts>);
  const localPs = attempt(() => (deps.ps ?? processOutput)(), null);
  const localBuilds = typeof localPs === 'string' ? countBuilds(localPs) : 'unknown';
  const current = attempt(() => (deps.currentVersion ?? (() => basename(readlinkSync(join(homedir(), '.local/share/elanous/current')))))(), null);
  const staleParents = typeof localPs !== 'string' || !current ? 'unknown' : countStaleParents(localPs, current);
  // `null` = no parent host configured (remote share is 0, not unknown); a failed config/host read is unknown.
  const configured = attempt<{ host: string; elanous?: string } | readonly { host: string; elanous?: string }[] | null | 'unknown'>(
    () => (deps.parentHost ?? (() => resolveParentHosts(getUserConfig().taskAgent?.parentHost)))(), 'unknown');
  const hosts = configured === 'unknown' || configured === null ? [] : Array.isArray(configured) ? configured : [configured as { host: string; elanous?: string }];
  let waiting = 0, starved = 0, builds = 0;
  let measuredHosts = 0;
  let missingRemote = configured === 'unknown';
  for (const host of hosts) {
    try {
      const observed = readRemote(host, deps.ssh ?? defaultSshRunner);
      const counts = admissionCounts(observed.rows, now);
      if (counts.waiting === 'unknown' || counts.starved === 'unknown') missingRemote = true;
      else { waiting += counts.waiting; starved += counts.starved; measuredHosts++; }
      builds += countBuilds(observed.ps);
    } catch { missingRemote = true; }
  }
  const remote: ReturnType<typeof admissionCounts> = missingRemote && measuredHosts === 0
    ? { waiting: 'unknown', starved: 'unknown' } : { waiting, starved };
  const remoteBuilds: BackpressureSignal = missingRemote ? 'unknown' : builds;
  // One measured half is a lower bound on the total: keep it (so a measured local starvation still stops launches)
  // and name the missing half in `unmeasured` (so the unknown cap still applies).
  const unmeasured: string[] = [];
  const add = (name: string, a: BackpressureSignal, b: BackpressureSignal): BackpressureSignal => {
    if (configured === null || (Array.isArray(configured) && configured.length === 0)) return a; // no remote half exists
    if (a === 'unknown' && b === 'unknown') return 'unknown';
    if (a === 'unknown') { unmeasured.push(`${name}.local`); return b; }
    if (b === 'unknown') { unmeasured.push(`${name}.remote`); return a; }
    return valid(a + b);
  };
  const admitWaiting = add('admitWaiting', local.waiting, remote.waiting);
  const admitStarvedOver30m = add('admitStarvedOver30m', local.starved, remote.starved);
  if (missingRemote && hosts.length) {
    if (!unmeasured.includes('admitWaiting.remote')) unmeasured.push('admitWaiting.remote');
    if (!unmeasured.includes('admitStarvedOver30m.remote')) unmeasured.push('admitStarvedOver30m.remote');
  }
  return { queueDepth, podRecommended, admitWaiting, admitStarvedOver30m,
    dockerBuilds: { local: localBuilds, remote: remoteBuilds }, staleParents, ...(unmeasured.length ? { unmeasured } : {}) };
}
