/** Resync labeled PRs before the steward's TA rejudge node sees their heads. */
import { debug } from '../debug/log.js';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { resolveHqLaunchSeat } from '../hq/seats.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { runResyncShadow, type ResyncShadowSummary } from '../loops/orchestrator/resync-shadow.js';
import { listSchedules, type ReleaseSchedule } from '../release-loop/release-schedule.js';

type ReleaseRunState = 'active' | 'idle' | 'unknown';
type ReleaseWindowState = 'inside' | 'outside' | 'unknown';
type ResyncTickResult = { decision: 'ran' | 'failed' | 'skipped-release' | 'skipped-release-window'; summary?: ResyncShadowSummary; reason?: string };

export function resyncPendingPath(): string { return join(effectiveInstanceRoot(), 'steward', 'resync-pending.json'); }

/** The same registered, detached OP checkout used by steward launch; the installed package is not a git repository. */
export function stewardResyncRepoRoot(
  resolveSeat: typeof resolveHqLaunchSeat = resolveHqLaunchSeat,
  configDir: () => string = getElanousConfigDir,
): string { return resolveSeat('OP', configDir()); }

/** A release may detach the OP checkout. Unknown process state also skips remote branch writes. */
export function probeReleaseRun(
  list: () => { status: number | null; stdout?: string; error?: Error } = () => spawnSync('pgrep', ['-f', 'release[[:space:]]+(run|resume)'], { encoding: 'utf8', timeout: 5_000 }),
  command: (pid: string) => string | null = pid => {
    const result = spawnSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8', timeout: 5_000 });
    return result.status === 0 ? result.stdout.trim() : null;
  },
): ReleaseRunState {
  try {
    const result = list();
    if (result.error || result.status === null) return 'unknown';
    if (result.status === 1) return 'idle';
    if (result.status !== 0) return 'unknown';
    const pids = (result.stdout ?? '').trim().split(/\s+/).filter(pid => /^\d+$/.test(pid));
    if (!pids.length) return 'unknown';
    for (const pid of pids) {
      const argv = command(pid);
      if (argv === null) continue;
      const executable = argv.trim().split(/\s+/)[0]?.split('/').at(-1);
      if (['bun', 'node', 'eln', 'elanous'].includes(executable ?? '') && /(?:^|\s)release\s+(?:run|resume)(?:\s|$)/.test(argv)) return 'active';
      // pgrep saw a release-shaped command, but a shell/wrapper cannot prove whether it will launch the CLI.
    }
    return 'unknown';
  } catch { return 'unknown'; }
}

/** A release cut may start after the process probe; the scheduled cut/publication window is a fixed safety boundary. */
export function releaseWindowState(
  nowMs = Date.now(),
  read: () => ReleaseSchedule[] = listSchedules,
): ReleaseWindowState {
  try {
    const schedules = read();
    if (!schedules.length) return 'unknown';
    const rows = schedules.map(row => ({ cut: Date.parse(row.cutAt), publish: Date.parse(row.publishAt ?? '') }));
    if (rows.some(row => !Number.isFinite(row.cut))) return 'unknown';
    const latestPast = rows.filter(row => row.cut <= nowMs).sort((a, b) => b.cut - a.cut)[0];
    if (latestPast && !Number.isFinite(latestPast.publish)) return 'unknown';
    if (latestPast && nowMs <= latestPast.publish + 60 * 60_000) return 'inside';
    const next = rows.filter(row => row.cut > nowMs).sort((a, b) => a.cut - b.cut)[0];
    if (!next || !Number.isFinite(next.publish) || next.publish < next.cut) return 'unknown';
    return nowMs >= next.cut - 40 * 60_000 ? 'inside' : 'outside';
  } catch { return 'unknown'; }
}

export function defaultResyncRun(
  repoRoot = stewardResyncRepoRoot(),
  execute: typeof runResyncShadow = runResyncShadow,
): Promise<ResyncShadowSummary> { return execute(3, { repoRoot }, 'live'); }

export async function resyncTick(
  run: () => Promise<ResyncShadowSummary> = () => defaultResyncRun(),
  log: (event: string, data: Record<string, unknown>) => void = (event, data) => debug.log('loop.steward', event, data),
  pendingPath: string = resyncPendingPath(),
): Promise<ResyncTickResult> { return resyncTickWithReleaseProbe(run, log, pendingPath, probeReleaseRun); }

export async function resyncTickWithReleaseProbe(
  run: () => Promise<ResyncShadowSummary>,
  log: (event: string, data: Record<string, unknown>) => void,
  pendingPath: string,
  releaseProbe: () => ReleaseRunState,
  windowProbe: () => ReleaseWindowState = releaseWindowState,
): Promise<ResyncTickResult> {
  let result: ResyncTickResult;
  try {
    const release = releaseProbe();
    if (release !== 'idle') {
      result = { decision: 'skipped-release', reason: release === 'active' ? 'release run active' : 'release process probe unavailable' };
    } else {
      const window = windowProbe();
      if (window !== 'outside') {
        result = { decision: 'skipped-release-window', reason: window === 'inside' ? 'scheduled release window' : 'release schedule unavailable' };
      } else {
        const summary = await run();
        if (summary.saved > 0) {
          mkdirSync(dirname(pendingPath), { recursive: true });
          writeFileSync(pendingPath, JSON.stringify({ savedAt: new Date().toISOString() }));
        }
        result = { decision: 'ran', summary };
      }
    }
  }
  catch (error) { result = { decision: 'failed', reason: (error instanceof Error ? error.message : String(error)).slice(-300) }; }
  try { log('resync-tick', { ...result }); }
  catch (error) {
    result = { decision: 'failed', reason: `log failed: ${error instanceof Error ? error.message : String(error)}`.slice(-300) };
    console.error(`steward resync: ${result.reason}`);
  }
  return result;
}

if (import.meta.main) {
  let sinkReady = false;
  try { sinkReady = await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('steward'); }
  catch (error) { console.error(`steward resync: log sink registration failed — ${error instanceof Error ? error.message : String(error)}`); }
  // A missing durable sink must not precede a remote branch update.
  const result = sinkReady ? await resyncTick() : { decision: 'failed' as const, reason: 'log sink unavailable' };
  console.log(`steward resync: ${result.decision}${result.reason ? ` — ${result.reason}` : ''}`);
  process.exitCode = 0;
}
