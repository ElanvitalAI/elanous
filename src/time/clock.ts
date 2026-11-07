import { type TimeFormatOpts, toDate, zoneOf, parts } from './format-core.js';

/** 시계 표시 `HH:MM:SS` (기본) 또는 `HH:MM:SS.mmm`.
 *  파싱 불가한 입력은 원본을 그대로 돌려준다 — 표시 함수가 던져서 화면을 깨면 안 된다. */
export function formatClock(
  ts: string | number | Date,
  opts?: TimeFormatOpts & { millis?: boolean },
): string {
  const d = toDate(ts);
  if (!d) return String(ts);
  // 밀리초까지 `Intl` 파트로 뽑는다. `d.getMilliseconds()` 도 값 자체는 같지만(밀리초는
  // 시간대 불변) 필드마다 경로가 달라지면 "모든 표시는 parts() 를 통과한다"는 규칙이
  // 깨진다 — #5258 리뷰 지적 반영.
  const p = parts(d, zoneOf(opts), {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    ...(opts?.millis ? { fractionalSecondDigits: 3 as const } : {}),
  });
  const base = `${p.hour}:${p.minute}:${p.second}`;
  if (!opts?.millis) return base;
  return `${base}.${(p.fractionalSecond ?? '000').padStart(3, '0')}`;
}
