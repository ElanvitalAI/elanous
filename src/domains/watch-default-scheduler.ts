import { debug } from '../debug/log.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getUserConfig } from '../user-config.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { listSources, runDue } from '../intake-plane/intake-sources.js';
import { runIntakeDigestCli } from '../cli/intake-cli.js';
import { resolveTimeZone } from '../time/format.js';
import { inventoryInternalSchedules, openSchedulesDb } from './schedule-registry.js';
import type { Database } from 'bun:sqlite';

export interface WatchDefaultSchedulerOpts {
  root?: string;
  enabled?: () => boolean;
  now?: () => Date;
  timeZone?: string;
  collect?: () => Promise<unknown>;
  brief?: () => Promise<unknown>;
  setInterval?: (tick: () => void, ms: number) => ReturnType<typeof setInterval>;
  openDb?: () => Database;
}

/** Daemon-owned watch jobs: the inventory rows describe these two actual timers. */
export function startWatchDefaultScheduler(opts: WatchDefaultSchedulerOpts = {}): { stop(): void; tickNow(): Promise<void> } {
  const root = opts.root ?? effectiveInstanceRoot();
  const enabled = opts.enabled ?? (() => getUserConfig().watch?.enabled !== false);
  const timeZone = opts.timeZone ?? resolveTimeZone().timeZone;
  const now = opts.now ?? (() => new Date());
  const collect = opts.collect ?? (() => runDue({ seat: 'user', deps: { stateDir: root } }));
  // The CLI sets process.exitCode on an unsent report; inside the daemon that would leak into the daemon's own exit status.
  const brief = opts.brief ?? (async () => {
    const before = process.exitCode;
    try { return await runIntakeDigestCli({ seat: 'user', telegram: true }, { root }); }
    finally { process.exitCode = before; }
  });
  const lastRunFile = join(root, 'intake', 'watch-default-last-run.json');
  const lastRun = new Map<string, string>();
  let lastInventory: string | undefined;
  let lastFailure: string | undefined;
  try {
    if (existsSync(lastRunFile)) {
      const saved = JSON.parse(readFileSync(lastRunFile, 'utf8')) as Record<string, string>;
      for (const [job, day] of Object.entries(saved)) if (typeof day === 'string') lastRun.set(job, day);
    }
  } catch (error) { debug.log('watch.default', 'failed', { reason: `last-run: ${String(error)}` }); }
  let running = false;
  let stopped = false;
  const tickNow = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const active = enabled() && listSources({ seat: 'user' }, root).length > 0;
      const registryDay = now().toISOString().slice(0, 10);
      const inventoryKey = `${registryDay}:${active}`;
      if (lastInventory !== inventoryKey) {
        // The registry row is a view; a registry failure must not skip the real collect/brief of this minute.
        try {
          const db = (opts.openDb ?? openSchedulesDb)();
          try { inventoryInternalSchedules(db, { watchRoot: root, watchEnabled: active }); lastInventory = inventoryKey; }
          finally { if (!opts.openDb) db.close(); }
        } catch (error) { debug.log('watch.default', 'failed', { stage: 'registry', reason: String(error) }); }
      }
      lastFailure = undefined;
      if (!active) return;
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(now());
      const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
      const day = `${part('year')}-${part('month')}-${part('day')}`;
      const clock = `${part('hour')}:${part('minute')}`;
      for (const [job, at, fire] of [['watch-collect', '07:00', collect], ['watch-brief', '08:30', brief]] as const) {
        if (clock !== at || lastRun.get(job) === day) continue;
        try {
          const outcome = await fire();
          if (job === 'watch-brief' && (!outcome || (outcome as { sent?: boolean }).sent !== true)) continue;
          if (job === 'watch-collect' && typeof outcome === 'object' && outcome && 'ran' in outcome
            && (outcome as { ran: Array<{ error?: string }> }).ran.some((row) => row.error)) continue;
          lastRun.set(job, day);
          mkdirSync(join(root, 'intake'), { recursive: true });
          const temp = `${lastRunFile}.${process.pid}.tmp`;
          writeFileSync(temp, JSON.stringify(Object.fromEntries(lastRun)) + '\n');
          renameSync(temp, lastRunFile);
        } catch (error) { debug.log('watch.default', 'failed', { job, reason: String(error) }); }
      }
    } catch (error) {
      const reason = String(error);
      if (reason !== lastFailure) debug.log('watch.default', 'failed', { reason });
      lastFailure = reason;
    } finally { running = false; }
  };
  const timer = (opts.setInterval ?? setInterval)(() => { void tickNow(); }, 60_000);
  if (typeof timer === 'object') timer.unref?.();
  void tickNow();
  return { stop() { stopped = true; clearInterval(timer); }, tickNow };
}
