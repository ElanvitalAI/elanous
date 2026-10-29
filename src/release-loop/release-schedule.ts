import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliUserError } from '../cli/cli-user-error.js';
import { debug } from '../debug/log.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { readSchedule, readSchedules, releasedVersion, writeSchedule, type ScheduleRow } from './feature-store.js';
import { checkScheduleCeoLoad } from './placement.js';

export type ReleaseSchedule = ScheduleRow;

export interface ReleaseCutDueEvent {
  id: string;
  type: 'release.cut.due';
  version: string;
  cutAt: string;
  at: string;
}

function newerVersion(version: string, published: string): boolean {
  if (!published) return true;
  const left = version.split('.').map(Number), right = published.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]!;
  }
  return false;
}

/** A scheduler tick observes due cuts; it does not directly start a release run. */
export function dueReleaseCutEvents(now: string, root = releaseLedgerRoot()): ReleaseCutDueEvent[] {
  const at = Date.parse(now);
  if (!Number.isFinite(at)) throw new Error(`invalid schedule tick time: ${now}`);
  const published = releasedVersion(root);
  return readSchedules(root).filter(row => {
    const cut = Date.parse(row.cutAt);
    return newerVersion(row.version, published) && cut <= at && at - cut < 24 * 3_600_000;
  }).map(row => ({ id: `release.cut.due:${row.version}:${row.cutAt}`, type: 'release.cut.due' as const,
    version: row.version, cutAt: row.cutAt, at: new Date(at).toISOString() }));
}

function hasReleaseRunForEvent(root: string, eventId: string): boolean {
  const dir = join(root, 'graph-runs', 'release-loop');
  if (!existsSync(dir)) return false;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const run = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { input?: { triggerEvent?: { id?: string } } };
      if (run.input?.triggerEvent?.id === eventId) return true;
    } catch { /* Ignore a partially written run; the next scheduler tick retries. */ }
  }
  return false;
}

/** Claim each version+cut only once across scheduler processes; a dead pending owner can be retried. */
export async function emitDueReleaseCutEvents(now: string, emit: (event: ReleaseCutDueEvent) => Promise<void>,
  root = releaseLedgerRoot(), subscriptionId = 'graph:release-loop'): Promise<ReleaseCutDueEvent[]> {
  const emitted: ReleaseCutDueEvent[] = [];
  for (const event of dueReleaseCutEvents(now, root)) {
    const hash = createHash('sha256').update(`${subscriptionId}\0${event.id}`).digest('hex').slice(0, 16);
    const path = join(root, 'release', 'cut-events', `${event.version}-${hash}.json`);
    mkdirSync(dirname(path), { recursive: true });
    let fd: number;
    try { fd = openSync(path, 'wx', 0o600); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      let prior: { status?: string; pid?: number } = {};
      try { prior = JSON.parse(readFileSync(path, 'utf8')) as typeof prior; } catch { /* pending write */ }
      if (prior.status !== 'pending' || !Number.isInteger(prior.pid)) {
        // A crash between O_EXCL creation and the first write leaves an empty claim.
        if (Date.now() - statSync(path).mtimeMs < 60_000 || prior.status === 'emitted') continue;
      } else {
        try { process.kill(prior.pid!, 0); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      }
      if (hasReleaseRunForEvent(root, event.id)) {
        writeFileSync(path, JSON.stringify({ ...event, subscriptionId, status: 'emitted', recovered: true }) + '\n', { mode: 0o600 });
        continue;
      }
      try { unlinkSync(path); fd = openSync(path, 'wx', 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
    }
    closeSync(fd);
    writeFileSync(path, JSON.stringify({ ...event, subscriptionId, status: 'pending', pid: process.pid }) + '\n', { mode: 0o600 });
    try {
      await emit(event);
      writeFileSync(path, JSON.stringify({ ...event, subscriptionId, status: 'emitted', pid: process.pid }) + '\n', { mode: 0o600 });
      debug.log('release.schedule', 'cut-due', { version: event.version, cutAt: event.cutAt, eventId: event.id, subscriptionId });
      emitted.push(event);
    } catch (error) {
      if (existsSync(path)) unlinkSync(path);
      throw error;
    }
  }
  return emitted;
}

/** A release landing and its representative work share the same KST day boundary. */
export function kstDay(utc: string): string {
  return new Date(Date.parse(utc) + 9 * 3_600_000).toISOString().slice(0, 10);
}

function utcIso(input: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(input);
  if (!match) throw new CliUserError(`시각에는 ISO 오프셋 필요: ${input}`);
  const hours = Number(match[6] ?? 0), minutes = Number(match[7] ?? 0);
  const offset = (match[5] === '-' ? -1 : 1) * (hours * 60 + minutes);
  const millis = Date.parse(input);
  if (hours > 23 || minutes > 59 || !Number.isFinite(millis) ||
      new Date(millis + offset * 60_000).toISOString().slice(0, 19) !== `${match[1]}T${match[2]}:${match[3] ?? '00'}`) {
    throw new CliUserError(`잘못된 ISO 시각: ${input}`);
  }
  return new Date(millis).toISOString();
}

export function formatKst(utc: string): string {
  const parts = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(utc));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  return `${get('month')}-${get('day')}(${get('weekday')}) ${get('hour')}:${get('minute')} KST`;
}

export function getSchedule(version: string, root?: string): ReleaseSchedule | null {
  const schedule = readSchedule(version, root);
  debug.log('release.schedule', 'read', { version, cutAt: schedule?.cutAt ?? null, landBy: schedule?.landBy ?? null });
  return schedule;
}

export function listSchedules(root?: string): ReleaseSchedule[] {
  const schedules = readSchedules(root);
  for (const { version, cutAt, landBy } of schedules) debug.log('release.schedule', 'read', { version, cutAt, landBy });
  return schedules;
}

export function setSchedule(version: string, patch: { cutAt?: string; landBy?: string; freezeFrom?: string; freezeUntil?: string; publishAt?: string }, by: string, root?: string): ReleaseSchedule {
  const landing = patch.landBy !== undefined ? utcIso(patch.landBy) : undefined;
  if (landing !== undefined) {
    const previous = readSchedule(version, root);
    // Check the landing against the same ledger and configuration root that writeSchedule will use.
    if (!previous?.landBy || kstDay(previous.landBy) !== kstDay(landing)) checkScheduleCeoLoad(version, landing, root);
  }
  const schedule = writeSchedule(version, {
    ...(patch.cutAt !== undefined ? { cutAt: utcIso(patch.cutAt) } : {}),
    ...(landing !== undefined ? { landBy: landing } : {}),
    ...(patch.freezeFrom !== undefined ? { freezeFrom: utcIso(patch.freezeFrom) } : {}),
    ...(patch.freezeUntil !== undefined ? { freezeUntil: utcIso(patch.freezeUntil) } : {}),
    ...(patch.publishAt !== undefined ? { publishAt: utcIso(patch.publishAt) } : {}),
  }, by, root);
  debug.log('release.schedule', 'set', { version, cutAt: schedule.cutAt, landBy: schedule.landBy });
  return schedule;
}

export function formatSchedule(schedule: ReleaseSchedule): string {
  const cut = formatKst(schedule.cutAt);
  const deadline = schedule.landBy ? formatKst(schedule.landBy) : null;
  const sameDay = schedule.landBy && new Date(Date.parse(schedule.landBy) + 9 * 60 * 60_000).toISOString().slice(0, 10)
    === new Date(Date.parse(schedule.cutAt) + 9 * 60 * 60_000).toISOString().slice(0, 10);
  const publish = schedule.publishAt ? formatKst(schedule.publishAt) : null;
  const publishSameDay = schedule.publishAt && new Date(Date.parse(schedule.publishAt) + 9 * 60 * 60_000).toISOString().slice(0, 10)
    === new Date(Date.parse(schedule.cutAt) + 9 * 60 * 60_000).toISOString().slice(0, 10);
  return `${schedule.version} 컷 ${cut}${deadline ? ` · 착지 마감 ${sameDay ? deadline.split(' ')[1] : deadline}` : ''}${publish ? ` · 발행 ${publishSameDay ? publish.split(' ')[1] : publish}` : ''}`;
}
