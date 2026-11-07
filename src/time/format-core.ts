import { resolveTimeZone } from './time-zone.js';

export interface TimeFormatOpts {
  /** 명시 시간대. 생략 시 `resolveTimeZone()`. 테스트는 항상 이걸 넘겨 결정론을 확보한다. */
  timeZone?: string;
}

export function zoneOf(opts?: TimeFormatOpts): string {
  return opts?.timeZone ?? resolveTimeZone().timeZone;
}

export function toDate(ts: string | number | Date): Date | null {
  const d = ts instanceof Date ? ts : new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface CachedFormatter {
  intlConstructor: typeof Intl.DateTimeFormat;
  formatter: Intl.DateTimeFormat;
}

const formatterCache = new Map<string, CachedFormatter>();

function formatterKey(timeZone: string, extra: Intl.DateTimeFormatOptions): string {
  return `${timeZone}\u0000${Object.entries(extra)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${String(value)}`)
    .join('\u0000')}`;
}

/** `Intl` 파트를 이름으로 꺼낸다 — 로케일별 자리 순서에 의존하지 않기 위해. */
export function parts(d: Date, timeZone: string, extra: Intl.DateTimeFormatOptions): Record<string, string> {
  const key = formatterKey(timeZone, extra);
  const cached = formatterCache.get(key);
  const fmt = cached?.intlConstructor === Intl.DateTimeFormat
    ? cached.formatter
    : new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', ...extra });
  if (!cached || cached.intlConstructor !== Intl.DateTimeFormat) {
    formatterCache.set(key, { intlConstructor: Intl.DateTimeFormat, formatter: fmt });
  }
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}
