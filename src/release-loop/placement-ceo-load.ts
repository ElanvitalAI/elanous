import { CliUserError } from '../cli/cli-user-error.js';
import { debug } from '../debug/log.js';
import { listChecklist, type ChecklistItem } from './checklist.js';
import { assignedVersions, type ScheduleRow } from './feature-store.js';
import { placementConfig, validCeoCap, type CeoCalendar } from './placement-config.js';

type CeoWork = Pick<ChecklistItem, 'id' | 'ceoMinutes' | 'ceoDate'>;
type ScheduleDeps = { listSchedules: (root?: string) => ScheduleRow[]; kstDay: (utc: string) => string };

function validDay(day: string): boolean {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`))
    && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

function calendarCap(day: string, cap: number, calendar: CeoCalendar): number {
  if (!calendar || (calendar.terms !== undefined && !Array.isArray(calendar.terms))
    || (calendar.events !== undefined && (!calendar.events || typeof calendar.events !== 'object' || Array.isArray(calendar.events))))
    throw new CliUserError('잘못된 대표 달력: release.placement.ceoCalendar');
  let effective = cap;
  for (const term of calendar.terms ?? []) {
    if (!term || typeof term !== 'object') throw new CliUserError('잘못된 대표 학기 달력: release.placement.ceoCalendar.terms');
    if (!validDay(term.from) || !validDay(term.to) || term.from > term.to) throw new CliUserError('잘못된 대표 학기 달력 날짜: release.placement.ceoCalendar.terms');
    validCeoCap(term.dailyCap);
    if (term.from <= day && day <= term.to) effective = Math.min(effective, term.dailyCap);
  }
  for (const [date, eventCap] of Object.entries(calendar.events ?? {})) {
    if (!validDay(date)) throw new CliUserError('잘못된 대표 행사 달력 날짜: release.placement.ceoCalendar.events');
    validCeoCap(eventCap);
  }
  return calendar.events?.[day] ?? effective;
}

function ceoDay(item: { ceoDate?: string }, row: ScheduleRow, toKstDay: ScheduleDeps['kstDay']): string {
  return item.ceoDate ?? toKstDay(row.landBy!);
}

export function ceoOverload(item: CeoWork, row: ScheduleRow, snapshots: Map<string, { items: CeoWork[] }>,
  schedules: ScheduleRow[], cap: number, toKstDay: ScheduleDeps['kstDay'], calendar: CeoCalendar = {}): string | null {
  if (!item.ceoMinutes) return null;
  const day = ceoDay(item, row, toKstDay);
  const limit = calendarCap(day, cap, calendar);
  const peers = [...snapshots].flatMap(([version, snapshot]) => {
    const schedule = schedules.find((candidate) => candidate.version === version);
    return snapshot.items.filter((other) => other.id !== item.id && other.ceoMinutes
      && (other.ceoDate === day || (!other.ceoDate && schedule?.landBy && ceoDay(other, schedule, toKstDay) === day)));
  });
  const total = item.ceoMinutes + peers.reduce((sum, other) => sum + other.ceoMinutes!, 0);
  if (total <= limit) return null;
  const reason = `대표 손 과부하 ${day} KST: ${[...peers.map((peer) => `${peer.id} ${peer.ceoMinutes}분`), `${item.id} ${item.ceoMinutes}분`].join(' + ')} = ${total}분 > 하루 상한 ${limit}분 — 늦추기(다음 날짜/판) · 자리 대행(대표 분량 축소) · 묶기(촬영·승인 합산 분량 축소)를 제안`;
  debug.log('release.placement', 'ceo-overload', { day, id: item.id, total, cap: limit, reason });
  return reason;
}

/** Called before a schedule landing-day change can overload an already placed cell. */
export function checkScheduleCeoLoad(version: string, landBy: string, root: string | undefined, deps: ScheduleDeps): void {
  const schedules = deps.listSchedules(root);
  const proposed = schedules.some((row) => row.version === version)
    ? schedules.map((row) => row.version === version ? { ...row, landBy } : row)
    : [...schedules, { version, cutAt: landBy, landBy, updatedAt: '', updatedBy: '' }];
  const target = proposed.find((row) => row.version === version)!;
  const targetItems = listChecklist(version, root).items;
  const changed = targetItems.filter((item) => item.ceoMinutes && !item.ceoDate);
  if (!changed.length) return;
  const versions = [...new Set([...proposed.map((row) => row.version), ...assignedVersions(root)])];
  const snapshots = new Map(versions.map((v) => [v, { items: v === version ? targetItems : listChecklist(v, root).items }]));
  const config = placementConfig(root);
  const cap = validCeoCap(config.ceoDailyCap ?? 30);
  for (const item of changed) {
    const issue = ceoOverload(item, target, snapshots, proposed, cap, deps.kstDay, config.ceoCalendar);
    if (issue) throw new CliUserError(issue);
  }
}
