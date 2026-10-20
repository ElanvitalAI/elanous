/** Release-day shadow: observe the scheduled phase without performing its action. */
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { listSchedules, type ReleaseSchedule } from '../release-loop/release-schedule.js';

export type ReleaseDayPhase = 'gate-mode' | 'carry-p0' | 'cut-run' | 'green-back' | 'none' | 'unmeasured';
export interface ReleaseDayDecision {
  version: string;
  phase: ReleaseDayPhase;
  dueAt: string | null;
  scheduleUpdatedAt: string;
  reason?: string;
}

/** Green-back waits for both the scheduled publish end and the actual publication record. */
export function decideReleaseDayPhase(schedule: ReleaseSchedule, now: Date, publishedAt: string | null): ReleaseDayDecision {
  const cut = Date.parse(schedule.cutAt);
  const land = schedule.landBy ? Date.parse(schedule.landBy) : cut;
  const gate = cut - 30 * 60_000;
  const time = now.getTime();
  const published = publishedAt ? Date.parse(publishedAt) : Number.NaN;
  const publishEnd = schedule.publishAt ? Date.parse(schedule.publishAt) : published;
  const greenAt = Number.isFinite(published) && Number.isFinite(publishEnd) ? Math.max(published, publishEnd) : Number.NaN;
  let phase: ReleaseDayPhase = 'none';
  let dueAt: string | null = null;
  if (time >= greenAt) {
    phase = 'green-back'; dueAt = publishEnd >= published ? schedule.publishAt ?? publishedAt : publishedAt;
  } else if (time >= cut) {
    phase = 'cut-run'; dueAt = schedule.cutAt;
  } else if (time >= land) {
    phase = 'carry-p0'; dueAt = schedule.landBy;
  } else if (time >= gate) {
    phase = 'gate-mode'; dueAt = new Date(gate).toISOString();
  }
  return { version: schedule.version, phase, dueAt, scheduleUpdatedAt: schedule.updatedAt };
}

export type PublicationProbe = { kind: 'published'; at: string } | { kind: 'unpublished' } | { kind: 'unmeasured'; reason: string };

function actualPublicationProbe(version: string, root: string): PublicationProbe {
  const path = join(root, 'release', version, 'release.json');
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'unpublished' };
    return { kind: 'unmeasured', reason: 'release-record-read-failed' };
  }
  try {
    const record = JSON.parse(raw) as { version?: unknown; publishedAt?: unknown };
    if (record.version !== version) return { kind: 'unmeasured', reason: 'release-record-version-mismatch' };
    if (record.publishedAt == null) return { kind: 'unmeasured', reason: 'release-record-published-at-missing' };
    if (typeof record.publishedAt !== 'string' || !Number.isFinite(Date.parse(record.publishedAt)))
      return { kind: 'unmeasured', reason: 'release-record-published-at-invalid' };
    return { kind: 'published', at: record.publishedAt };
  } catch { return { kind: 'unmeasured', reason: 'release-record-json-failed' }; }
}

export interface ReleaseDayScheduleState { publication: PublicationProbe; greenObserved: boolean }

/** A late release and the next gate can both be due; return both instead of starving either. */
export function selectReleaseDaySchedules(
  schedules: ReleaseSchedule[], now: Date, state: (version: string) => ReleaseDayScheduleState,
): ReleaseSchedule[] {
  const ordered = schedules.filter(s => Number.isFinite(Date.parse(s.cutAt))).sort((a, b) => Date.parse(a.cutAt) - Date.parse(b.cutAt));
  const time = now.getTime();
  const dueFuture = ordered.filter(s => {
    const cut = Date.parse(s.cutAt);
    const firstDue = Math.min(cut - 30 * 60_000, s.landBy ? Date.parse(s.landBy) : cut);
    return time < cut && time >= firstDue;
  });
  const past = ordered.filter(s => Date.parse(s.cutAt) <= time);
  const unpublished = past.filter(s => state(s.version).publication.kind === 'unpublished');
  const unmeasured = past.filter(s => state(s.version).publication.kind === 'unmeasured');
  const pendingGreen = past.filter(s => {
    const status = state(s.version);
    return status.publication.kind === 'published' && !status.greenObserved;
  });
  const due = [...dueFuture, ...unpublished, ...unmeasured, ...pendingGreen];
  if (due.length) return [...new Map(due.map(s => [s.version, s])).values()];
  const upcoming = ordered.find(s => Date.parse(s.cutAt) > time);
  return upcoming && Date.parse(upcoming.cutAt) - time <= 24 * 60 * 60_000 ? [upcoming] : [];
}

export interface ReleaseDayShadowDeps {
  now?: () => Date;
  releaseRoot?: string;
  stateRoot?: string;
  schedules?: () => ReleaseSchedule[];
  publishedAt?: (version: string, root: string) => string | null;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface ReleaseDayShadowResult extends ReleaseDayDecision { recorded: boolean }

export function runReleaseDayShadow(deps: ReleaseDayShadowDeps = {}): ReleaseDayShadowResult[] {
  const now = (deps.now ?? (() => new Date()))();
  // The graph child's stamped universe also owns its release schedule under --test.
  const releaseRoot = deps.releaseRoot ?? effectiveInstanceRoot();
  const schedules = (deps.schedules ?? (() => listSchedules(releaseRoot)))();
  const log = deps.log ?? ((event: string, data: Record<string, unknown>) => debug.log('steward.release-day', event, data));
  if (!schedules.length) { log('decision', { phase: 'none', reason: 'no-release-schedule', at: now.toISOString(), recorded: false, mode: 'shadow' }); return []; }
  const dir = join(deps.stateRoot ?? effectiveInstanceRoot(), 'steward');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'release-day-shadow.sqlite');
  const db = new Database(path, { create: true, strict: true });
  try {
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec('CREATE TABLE IF NOT EXISTS phase_observations (version TEXT NOT NULL, phase TEXT NOT NULL, due_at TEXT NOT NULL, observed_at TEXT NOT NULL, schedule_updated_at TEXT NOT NULL, PRIMARY KEY (version, phase))');
    const states = new Map<string, ReleaseDayScheduleState>();
    for (const schedule of schedules) {
      const observed = db.query('SELECT phase FROM phase_observations WHERE version = ?').all(schedule.version) as Array<{ phase: string }>;
      const injected = deps.publishedAt?.(schedule.version, releaseRoot);
      states.set(schedule.version, {
        publication: deps.publishedAt
          ? injected == null ? { kind: 'unpublished' }
            : Number.isFinite(Date.parse(injected)) ? { kind: 'published', at: injected }
              : { kind: 'unmeasured', reason: 'injected-published-at-invalid' }
          : actualPublicationProbe(schedule.version, releaseRoot),
        greenObserved: observed.some(row => row.phase === 'green-back'),
      });
    }
    const selected = selectReleaseDaySchedules(schedules, now, version => states.get(version)!);
    if (!selected.length) { log('decision', { phase: 'none', reason: 'outside-release-window', at: now.toISOString(), recorded: false, mode: 'shadow' }); return []; }
    const results: ReleaseDayShadowResult[] = [];
    for (const schedule of selected) {
      const publication = states.get(schedule.version)!.publication;
      if (publication.kind === 'unmeasured') {
        const result: ReleaseDayShadowResult = { version: schedule.version, phase: 'unmeasured', dueAt: null,
          scheduleUpdatedAt: schedule.updatedAt, reason: publication.reason, recorded: false };
        log('unmeasured', { ...result, at: now.toISOString(), mode: 'shadow' });
        results.push(result);
        continue;
      }
      const publishedAt = publication.kind === 'published' ? publication.at : null;
      // The steward graph tick records this judgment only; release CLI actions remain outside this shadow boundary.
      const decision = decideReleaseDayPhase(schedule, now, publishedAt);
      let recorded = false;
      if (decision.phase !== 'none') {
      const row = db.query('INSERT OR IGNORE INTO phase_observations (version, phase, due_at, observed_at, schedule_updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(decision.version, decision.phase, decision.dueAt!, now.toISOString(), decision.scheduleUpdatedAt);
      recorded = row.changes === 1;
      }
      log('decision', { ...decision, at: now.toISOString(), recorded, mode: 'shadow', publishedAt });
      results.push({ ...decision, recorded });
    }
    return results;
  } finally { db.close(); }
}

if (import.meta.main) {
  try {
    const sinkReady = await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('steward');
    if (!sinkReady) throw new Error('durable log sink unavailable');
    const results = runReleaseDayShadow();
    console.log(`steward release-day shadow: ${results.map(result => `${result.version}:${result.phase}${result.recorded ? ' · recorded' : ''}`).join(', ') || 'none'}`);
  }
  catch (error) { console.error(`steward release-day shadow failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
