import { releaseLedgerRoot } from '../instance/resolve.js';
import { releaseReadiness, type ReleaseReadiness } from '../../scripts/release-loop/release-readiness.js';
import { listSchedules, type ReleaseSchedule } from './release-schedule.js';

/** Cuts become eligible at cutAt and remain eligible through the end of the window. */
export function selectScheduledCut(schedules: readonly ReleaseSchedule[], now: Date, windowMinutes: number): ReleaseSchedule | null {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) throw new Error('windowMinutes must be positive and finite');
  const current = now.getTime();
  if (!Number.isFinite(current)) throw new Error('now must be a valid date');
  return schedules
    .filter((schedule) => {
      const cut = Date.parse(schedule.cutAt);
      return Number.isFinite(cut) && cut <= current && current - cut <= windowMinutes * 60_000;
    })
    .sort((a, b) => Date.parse(a.cutAt) - Date.parse(b.cutAt) || a.version.localeCompare(b.version))[0] ?? null;
}

export type AutoStartResult =
  | { status: 'no-cut' }
  | { status: 'planned'; version: string; cutAt: string }
  | { status: 'skipped'; version: string; reason: Exclude<ReleaseReadiness, { ready: true }>['reason'] }
  | { status: 'started'; version: string; cutAt: string };

export interface AutoStartOptions {
  windowMinutes: number;
  apply?: boolean;
  now?: Date;
  ledgerRoot?: string;
  schedules?: (root: string) => ReleaseSchedule[];
  readiness?: (version: string, ledgerRoot: string, now: Date) => ReleaseReadiness;
  launch?: (version: string) => void | Promise<void>;
}

/** Select from the release schedule; the existing `release run --if-ready` owns the launch-time lock and guards. */
export async function autoStartScheduledRelease(options: AutoStartOptions): Promise<AutoStartResult> {
  const root = options.ledgerRoot ?? releaseLedgerRoot();
  const now = options.now ?? new Date();
  // Validate the window even when the ledger has no rows.
  const schedule = selectScheduledCut((options.schedules ?? listSchedules)(root), now, options.windowMinutes);
  if (!schedule) return { status: 'no-cut' };
  const { version, cutAt } = schedule;
  if (!options.apply) return { status: 'planned', version, cutAt };
  const readiness = (options.readiness ?? ((v, ledgerRoot, at) => releaseReadiness(v, { ledgerRoot, now: () => at })))(version, root, now);
  if (!readiness.ready) return { status: 'skipped', version, reason: readiness.reason };
  if (!options.launch) throw new Error('auto-start apply requires a launch callback');
  await options.launch(version);
  return { status: 'started', version, cutAt };
}
