import { type TimeFormatOpts, toDate, zoneOf, parts } from './format-core.js';

/** 날짜 표시/집계 키 `YYYY-MM-DD`.
 *  집계에 쓰는 값이므로 UTC 로 뽑으면 KST 00~09시 데이터가 전날로 샌다. */
export function dateKey(ts: string | number | Date = new Date(), opts?: TimeFormatOpts): string {
  const d = toDate(ts);
  if (!d) return String(ts);
  const p = parts(d, zoneOf(opts), { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
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
