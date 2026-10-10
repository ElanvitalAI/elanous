// 시각 표시 계약 (2026-07-24) — "저장은 UTC, 표시는 사용자 시간대".
//
// 왜 생겼나: 레포에 공용 시각 포맷터가 없어서 각 저자가 그때그때 규약을 골랐고,
// 그 결과 같은 제품의 두 서피스가 정반대로 갔다 —
//   · `cli/logs-cli.ts` / `cli/logs-timeline.ts` / `conv-dash/...` → ISO slice(UTC)
//   · `notifications/bell-modal.ts` → getHours()(로컬)
//   · PWA `LogsPanel.tsx` 는 **한 컴포넌트 안에서** 둘 다 씀(101행 로컬 ↔ 126행 UTC)
// KST 머신에서 UTC-slice 는 9시간 어긋나 보인다. 표시만의 문제가 아니라
//   · LLM 컨텍스트 팩에 UTC 가 "사실"로 주입되고(session-context / mission-incident-context)
//   · 날짜키가 UTC 라 KST 00~09시 집계가 전날로 새고(budget / market-quote / dashboard-data)
//   · 스케줄 리포트가 정상 실행을 사고로 오진하게 만든다(schedule-health-report)
// `domains/morning-report.ts:33` 이 이 문제를 이미 알고 **한 파일에서만** 고쳐뒀다 —
// 계약이 없으니 전파가 안 됐다는 증거다.
//
// 설계: 내부 문서 `PLAN-self-cognition-observability-surgery-2026-07-24`
//
// 규칙
//   1. 저장·전송은 언제나 UTC ISO. 이 모듈은 **표시/집계 키**만 다룬다.
//   2. 표시는 반드시 이 모듈을 통과한다. 새 코드에서 `toISOString().slice(11,19)` 금지.
//   3. 시간대는 주입 가능해야 한다 — 테스트가 실행 머신 TZ 에 의존하면 안 된다.

/** 시간대 해석 결과와 그 출처(관측·진단용). */
export interface ResolvedTimeZone {
  timeZone: string;
  source: 'config' | 'env' | 'system' | 'fallback';
}

/** 마지막 수단. 하드코딩된 지역을 기본값으로 두지 않는다 — 지역 하드코딩이
 *  애초에 이 계약이 없어서 생긴 문제였다. */
const FALLBACK_TIME_ZONE = 'UTC';

function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `resolveTimeZone` 주입 seam.
 *
 *  ⚠️ 테스트가 `process.env.TZ` 를 **변이하면 안 된다** — 실측 결과 되돌릴 수 없다:
 *    before: Asia/Seoul · TZ='UTC' 설정 → during: UTC · delete 후 → after: **UTC**
 *  런타임이 마지막 설정값을 유지하므로 `delete` 해도 원복되지 않고, 같은 프로세스에서
 *  뒤이어 도는 모든 테스트 파일이 오염된다(실제로 이 세션에서 catch-up 테스트 4건이
 *  그렇게 깨졌고, 파일 순서를 뒤집으면 통과했다). 그래서 env/OS 를 주입으로 뺀다. */
export interface ResolveTimeZoneDeps {
  /** config 의 timezone 값. 생략 시 등록된 config 소스에서 읽는다. */
  configTimeZone?: string | undefined;
  /** env 의 TZ 값. 생략 시 `process.env.TZ`. */
  envTimeZone?: string | undefined;
  /** OS 가 보고하는 시간대. 생략 시 `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  systemTimeZone?: string | undefined;
}

/** 시간대 단일 진입점 — config → env → OS → UTC.
 *
 *  `process.env.TZ` 를 단독으로 믿지 않는 이유: launchd 로 뜬 데몬은 TZ 를 물려받지
 *  못한다(실측 확인). 반면 `Intl` 은 OS 설정을 직접 읽어 그 경우에도 올바른 지역을
 *  돌려준다. 그래서 env 보다 OS 를 **뒤**에 두되 fallback 으로 반드시 둔다. */
let configTimeZoneSource: (() => string | undefined) | undefined;

/** Config 소유자가 로드될 때 등록한다. 이 바닥 모듈은 config 를 로드하지 않는다.
 * 반환된 함수는 이전 소스를 복원한다(격리 테스트에서만 사용). */
export function setConfigTimeZoneSource(fn: () => string | undefined): () => void {
  const previous = configTimeZoneSource;
  configTimeZoneSource = fn;
  return () => { configTimeZoneSource = previous; };
}

export function resolveTimeZone(deps: ResolveTimeZoneDeps = {}): ResolvedTimeZone {
  let cfg = deps.configTimeZone;
  if (!('configTimeZone' in deps)) {
    try {
      cfg = configTimeZoneSource?.();
    } catch { /* config 미가용(부팅 초기·격리 테스트) — 아래로 */ }
  }
  if (typeof cfg === 'string' && isValidTimeZone(cfg.trim())) {
    return { timeZone: cfg.trim(), source: 'config' };
  }

  const env = ('envTimeZone' in deps ? deps.envTimeZone : process.env.TZ)?.trim();
  if (env && isValidTimeZone(env)) return { timeZone: env, source: 'env' };

  try {
    const sys = 'systemTimeZone' in deps
      ? deps.systemTimeZone
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (sys && isValidTimeZone(sys)) return { timeZone: sys, source: 'system' };
  } catch { /* Intl 미가용 — 아래로 */ }

  return { timeZone: FALLBACK_TIME_ZONE, source: 'fallback' };
}

export interface TimeFormatOpts {
  /** 명시 시간대. 생략 시 `resolveTimeZone()`. 테스트는 항상 이걸 넘겨 결정론을 확보한다. */
  timeZone?: string;
}

function zoneOf(opts?: TimeFormatOpts): string {
  return opts?.timeZone ?? resolveTimeZone().timeZone;
}

function toDate(ts: string | number | Date): Date | null {
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
function parts(d: Date, timeZone: string, extra: Intl.DateTimeFormatOptions): Record<string, string> {
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
