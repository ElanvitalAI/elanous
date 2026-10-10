import { CliUserError } from '../cli/cli-user-error.js';
import { debug } from '../debug/log.js';
import { readSchedule, readSchedules, writeSchedule, type ScheduleRow } from './feature-store.js';
import { checkScheduleCeoLoad } from './placement.js';

export type ReleaseSchedule = ScheduleRow;

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
