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
