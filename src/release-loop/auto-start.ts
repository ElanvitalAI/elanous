import { debug } from '../debug/log.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { releaseReadiness, type ReleaseReadiness } from '../../scripts/release-loop/release-readiness.js';
import { listSchedules, type ReleaseSchedule } from './release-schedule.js';
import { releasedVersion } from './feature-store.js';

function isNewerVersion(version: string, published: string): boolean {
  if (!published) return true;
  const left = version.split('.').map(Number), right = published.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]!;
  }
  return false;
}

/** The look-ahead selects before cutAt; overdue cuts remain eligible until published. */
export function selectScheduledCut(schedules: readonly ReleaseSchedule[], now: Date, windowMinutes: number, published = ''): ReleaseSchedule | null {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) throw new Error('windowMinutes must be positive and finite');
  const current = now.getTime();
  if (!Number.isFinite(current)) throw new Error('now must be a valid date');
  return schedules
    .filter((schedule) => {
      const cut = Date.parse(schedule.cutAt);
      return isNewerVersion(schedule.version, published) && Number.isFinite(cut)
        && cut <= current + windowMinutes * 60_000;
    })
    .sort((a, b) => Date.parse(a.cutAt) - Date.parse(b.cutAt) || a.version.localeCompare(b.version))[0] ?? null;
}

export type AutoStartDeferral = { deferred: true; reason: Exclude<ReleaseReadiness, { ready: true }>['reason'] | 'frozen' };

export type AutoStartResult =
  | { status: 'no-cut' }
  | { status: 'planned'; version: string; cutAt: string }
  | { status: 'skipped'; version: string; reason: Exclude<AutoStartDeferral['reason'], 'already-running'> }
  /** A live run of the selected version is a refusal (rc1), not a quiet deferral — the reason names that run. */
  | { status: 'already-running'; version: string; runId: string; pid: number; startedAt: string }
  | { status: 'started'; version: string; cutAt: string; publishAt?: string };

export interface AutoStartActiveRun { runId: string; pid: number; startedAt: string }

export interface AutoStartOptions {
  windowMinutes: number;
  apply?: boolean;
  now?: Date;
  ledgerRoot?: string;
  schedules?: (root: string) => ReleaseSchedule[];
  readiness?: (version: string, ledgerRoot: string, now: Date) => ReleaseReadiness;
  /** The live run of `version` (graph-run ledger · force marker · run.lock), asked before readiness on `--apply`. */
  activeRun?: (version: string, ledgerRoot: string) => AutoStartActiveRun | undefined;
  launch?: (version: string, launchOptions?: { publishAt?: string }) => void | AutoStartDeferral | Promise<void | AutoStartDeferral>;
}

/** Select from the release schedule; the existing `release run --if-ready` owns the launch-time lock and guards. */
export async function autoStartScheduledRelease(options: AutoStartOptions): Promise<AutoStartResult> {
  const root = options.ledgerRoot ?? releaseLedgerRoot();
  const now = options.now ?? new Date();
  // Validate the window even when the ledger has no rows.
  const schedule = selectScheduledCut((options.schedules ?? listSchedules)(root), now, options.windowMinutes, releasedVersion(root));
  if (!schedule) return { status: 'no-cut' };
  const { version, cutAt, publishAt } = schedule;
  if (!options.apply) return { status: 'planned', version, cutAt };
  const refuse = (run: AutoStartActiveRun): AutoStartResult => {
    debug.log('release.schedule', 'auto-start-already-running', { version, cutAt, ...run });
    return { status: 'already-running', version, ...run };
  };
  const active = options.activeRun?.(version, root);
  if (active) return refuse(active);
  const readiness = (options.readiness ?? ((v, ledgerRoot, at) => releaseReadiness(v, { ledgerRoot, now: () => at, allowBeforeCut: true })))(version, root, now);
  // A live run.lock without a resolvable run identity still refuses; its pid is the readiness detail.
  if (!readiness.ready && readiness.reason === 'already-running') return refuse({ runId: 'pending', pid: Number(readiness.details), startedAt: 'unknown' });
  if (!readiness.ready) return { status: 'skipped', version, reason: readiness.reason };
  if (!options.launch) {
    const reason = 'auto-start apply requires a launch callback';
    debug.log('release.schedule', 'countdown-launch-failed', { version, cutAt, observedAt: now.toISOString(), reason });
    throw new Error(reason);
  }
  let launched: void | AutoStartDeferral;
  try { launched = await options.launch(version, publishAt != null ? { publishAt: publishAt } : {}); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debug.log('release.schedule', 'countdown-launch-failed', { version, cutAt, observedAt: now.toISOString(), reason });
    throw error;
  }
  if (launched?.deferred) {
    const { reason } = launched;
    debug.log('release.schedule', 'countdown-launch-failed', { version, cutAt, observedAt: now.toISOString(), reason });
    if (reason === 'already-running') return refuse(options.activeRun?.(version, root) ?? { runId: 'pending', pid: 0, startedAt: 'unknown' });
    return { status: 'skipped', version, reason };
  }
  const startedAt = options.now ?? new Date();
  debug.log('release.schedule', 'countdown-started', { version, cutAt, observedAt: startedAt.toISOString(),
    eta: Date.parse(cutAt) > startedAt.getTime() ? cutAt : startedAt.toISOString(), phase: Date.parse(cutAt) > startedAt.getTime() ? 'pre-cut' : 'go' });
  debug.log('release.schedule', 'auto-start', { version, cutAt, publishAt: publishAt ?? null });
  return { status: 'started', version, cutAt, ...(publishAt != null ? { publishAt: publishAt } : {}) };
}
