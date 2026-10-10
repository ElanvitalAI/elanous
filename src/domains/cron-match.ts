// ── 크론 매칭 (dep-free) — catch-up 자기회복용 ─────────────────────────
//
// 문제: node-cron 은 "지금 이 tick" 순간에만 발화하고, 놓친 발화는 버린다
// (missed execution 경고). 데몬 재시작·이벤트루프 블로킹으로 일간 잡(예: 아침
// 리포트 07:45)이 그 1회 tick 을 놓치면 최대 24h 공백 — 재시도 없음.
//
// catch-up 러너가 "예정 시각이 지났는데 last_run 이 그보다 오래됐으면 지금 1회
// 발화"하려면 크론식의 "직전 예정 시각(prev scheduled fire)"을 계산해야 한다.
// 새 dep(cron-parser) 도입은 대표 보수룰(새 deps=사용자 결정)에 걸리므로 순수
// 구현. 표준 Vixie cron 5필드 시맨틱 준수(특히 dom/dow OR 규칙).
//
// 2026-07-24 — 'dep-free' 는 **외부 npm dep** 를 안 쓴다는 뜻이고, 시간대 해석은
// 레포 내부 계약(src/time/format.ts)에 위임한다. 로컬 게터로 시/분/요일을 뽑으면
// 프로세스 주변 TZ 에 종속돼 launchd 환경에서 조용히 어긋나기 때문.
import { calendarFields, resolveTimeZone } from '../time/format.js';
import '../user-config.js'; // Standalone catch-up queries share the saved timezone with the scheduler.

// 한 파트 매칭 — 지원: 별표, 별표+스텝, 범위 a-b, 범위+스텝, 단일 값 n.
function matchPart(part: string, value: number, min: number, max: number): boolean {
  let step = 1;
  let range = part;
  const slash = part.indexOf('/');
  if (slash >= 0) {
    step = Number.parseInt(part.slice(slash + 1), 10) || 1;
    range = part.slice(0, slash);
  }
  let lo = min;
  let hi = max;
  if (range === '*' || range === '') {
    lo = min; hi = max;
  } else if (range.includes('-')) {
    const [a, b] = range.split('-').map((x) => Number.parseInt(x, 10));
    if (Number.isNaN(a!) || Number.isNaN(b!)) return false;
    lo = a!; hi = b!;
  } else {
    const n = Number.parseInt(range, 10);
    if (Number.isNaN(n)) return false;
    if (slash < 0) return n === value; // 단일 값
    lo = n; hi = max;                   // `n/step` = n 부터 step 간격
  }
  if (value < lo || value > hi) return false;
  return (value - lo) % step === 0;
}

/** 한 필드(쉼표 목록) 매칭 — 하나라도 맞으면 true. */
export function matchField(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(',')) {
    if (matchPart(part.trim(), value, min, max)) return true;
  }
  return false;
}

/** 크론 판정 시간대. 생략 시 `resolveTimeZone()`(config → env.TZ → OS → UTC).
 *
 *  ⚠️ 이 값은 **발화 스케줄러(node-cron)에 넘기는 timezone 과 반드시 같아야 한다.**
 *  둘이 어긋나면 캐치업이 이미 발화한 잡을 다시 쏘거나(중복), 놓친 잡을 못 잡는다.
 *  배선: `domains/schedule-runner.ts` 가 한 값을 양쪽에 넘긴다. */
export interface CronTimeOpts {
  timeZone?: string;
}

/** 크론식(5필드: min hour dom month dow)이 주어진 순간에 매칭하는가.
 *  dow: 0=일..6=토, 7 도 일요일로 취급. dom/dow 둘 다 제한되면 OR(표준 cron).
 *
 *  2026-07-24 — 종전엔 `d.getHours()` 등 **로컬 게터**로 필드를 뽑아 프로세스 주변
 *  TZ 에 종속됐다. launchd 데몬은 `TZ` 를 물려받지 못하므로(실측 확인) 환경이 바뀌면
 *  모든 크론이 **조용히** 밀린다 — `TZ=UTC` 면 `45 7 * * *` 이 KST 16:45 에 발화한다.
 *  이제 시간대를 명시 해석해 그 종속을 끊는다. 계약: src/time/format.ts */
export function cronMatches(expr: string, d: Date, opts?: CronTimeOpts): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];

  const f = calendarFields(d, opts?.timeZone ? { timeZone: opts.timeZone } : undefined);
  if (!matchField(min, f.minute, 0, 59)) return false;
  if (!matchField(hour, f.hour, 0, 23)) return false;
  if (!matchField(mon, f.month, 1, 12)) return false;

  const domRestricted = dom !== '*';
  const dowRestricted = dow !== '*';
  const domM = matchField(dom, f.day, 1, 31);
  const dowM = matchField(dow.replace(/7/g, '0'), f.weekday, 0, 6);
  // 표준 Vixie: 둘 다 제한 → OR, 아니면 AND(하나는 * 라 항상 true → AND 로 충분).
  const dayMatch = domRestricted && dowRestricted ? domM || dowM : domM && dowM;
  return dayMatch;
}

/** now(로컬) 이하에서 크론이 매칭하는 가장 최근 '분'. graceMs 이내만 뒤로 스캔.
 *  못 찾으면 null. 분 단위 역방향 스캔(최대 grace 분 = 6h→360회, 저렴). */
export function prevScheduledFire(
  expr: string,
  now: Date,
  graceMs: number,
  opts?: CronTimeOpts,
): Date | null {
  // 분 경계로 절삭 — 초/밀리초는 시간대와 무관하므로 로컬 세터로 안전하다.
  let cur = new Date(now);
  cur.setSeconds(0, 0);
  const maxSteps = Math.ceil(graceMs / 60_000);
  const timeZone = opts?.timeZone ?? resolveTimeZone().timeZone;
  for (let i = 0; i <= maxSteps; i++) {
    if (cronMatches(expr, cur, { timeZone })) return new Date(cur);
    // 절대 시간으로 1분 후퇴. 종전 `setMinutes(getMinutes()-1)` 은 로컬 달력 산술이라
    // DST 전이 구간에서 같은 분을 반복하거나 건너뛸 수 있다(오프셋 고정 지역에선
    // 무해했으나 계약을 지역 무관하게 만드는 김에 함께 정리).
    cur = new Date(cur.getTime() - 60_000);
  }
  return null;
}
