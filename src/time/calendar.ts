import { type TimeFormatOpts, toDate, zoneOf, parts } from './format-core.js';

/** 날짜 표시/집계 키 `YYYY-MM-DD`.
 *  집계에 쓰는 값이므로 UTC 로 뽑으면 KST 00~09시 데이터가 전날로 샌다. */
export function dateKey(ts: string | number | Date = new Date(), opts?: TimeFormatOpts): string {
  const d = toDate(ts);
  if (!d) return String(ts);
  const p = parts(d, zoneOf(opts), { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

/** 달력 날짜 `YYYY-MM-DD` 에 일수를 더한다(시간대 무관 — 순수 달력 산술). */
export function addCalendarDays(day: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`invalid calendar day: ${day}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days)).toISOString().slice(0, 10);
}

/** 그 시간대에서 `day` 가 시작되는 첫 순간(ms) — 보통은 자정(00:00), 자정에 DST 가 시작되는 날은 전환 순간
 *  (예: America/Sao_Paulo 2018-11-04 는 00:00 이 없고 01:00 = 03:00Z 에 시작). `dateKey` 와 같은 시간대
 *  해석(`zoneOf`)으로, 지역 날짜가 처음 `day` 이상이 되는 초를 이분 탐색한다(지역 날짜는 시각에 단조).
 *  탐색 폭 ±15h 는 실재 UTC 편차(-12h ~ +14h)를 덮는다. */
export function zonedDayStartMs(day: string, opts?: TimeFormatOpts): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`invalid calendar day: ${day}`);
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const timeZone = zoneOf(opts);
  const second = 1000;
  let before = target - 15 * 3_600_000; // 지역 날짜 < day
  let atOrAfter = target + 15 * 3_600_000; // 지역 날짜 ≥ day
  while (atOrAfter - before > second) {
    const mid = before + Math.floor((atOrAfter - before) / (2 * second)) * second;
    if (dateKey(mid, { timeZone }) >= day) atOrAfter = mid;
    else before = mid;
  }
  return atOrAfter;
}

/** 그 시간대의 하루 창 `[자정, 다음 자정)` — ISO(UTC) 두 끝. 집계를 UTC 날짜로 자르지 않기 위해. */
export function zonedDayWindow(day: string, opts?: TimeFormatOpts): { since: string; until: string; timeZone: string } {
  return { since: new Date(zonedDayStartMs(day, opts)).toISOString(),
    until: new Date(zonedDayStartMs(addCalendarDays(day, 1), opts)).toISOString(), timeZone: zoneOf(opts) };
}

/** 날짜+시각 `YYYY-MM-DD HH:MM` (기본) 또는 초까지. */
export function formatDateTime(
  ts: string | number | Date,
  opts?: TimeFormatOpts & { seconds?: boolean },
): string {
  const d = toDate(ts);
  if (!d) return String(ts);
  const p = parts(d, zoneOf(opts), {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', ...(opts?.seconds ? { second: '2-digit' } : {}),
  });
  const hm = `${p.hour}:${p.minute}${opts?.seconds ? `:${p.second}` : ''}`;
  return `${p.year}-${p.month}-${p.day} ${hm}`;
}

/** 특정 시간대에서 본 달력 필드. cron 매칭처럼 "시/분/요일" 로 판정해야 하는 로직이
 *  `Date` 의 로컬 게터(`getHours()` 등)를 쓰면 **프로세스 주변 TZ 에 종속**된다 —
 *  launchd 데몬처럼 TZ 를 물려받지 못하는 환경에서 조용히 어긋난다. */
export interface CalendarFields {
  year: number;
  /** 1-12 (Date.getMonth() 의 0-based 와 다르다) */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0=일 … 6=토 (Date.getDay() 와 동일 규약) */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** 주어진 순간을 특정 시간대에서 본 달력 필드로 분해. */
export function calendarFields(ts: string | number | Date, opts?: TimeFormatOpts): CalendarFields {
  const d = toDate(ts) ?? new Date(NaN);
  const p = parts(d, zoneOf(opts), {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAY_INDEX[p.weekday ?? ''] ?? 0,
  };
}

/** 짧은 표기 `MM-DD HH:MM` — 타임라인/이력 목록용(기존 `.slice(5,16)` 대체). */
export function formatShortDateTime(ts: string | number | Date, opts?: TimeFormatOpts): string {
  const d = toDate(ts);
  if (!d) return String(ts);
  const p = parts(d, zoneOf(opts), {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
