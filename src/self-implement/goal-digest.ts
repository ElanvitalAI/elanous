import { extractGoalDocSections } from './goal-doc/section.js';

// 감독자(rework 진단가)에게 보낼 **골 요약** — 계약 절을 먼저 싣고, 노이즈를 뒤로 민다.
//
// ⛔⭐ 왜 있나 (2026-07-28 실측):
//   감독자 프롬프트가 `골(수용기준·스코프 경계):` 라는 라벨을 달고 `goal.slice(0, 3000)` 을 실었다.
//   그런데 `elanous self author` 가 내는 골 파일은 **앞부분이 grounding 후보 목록**이고
//   **수용 기준·규칙·스코프 경계는 뒤쪽**에 있다. ⇒ 라벨이 약속한 것을 자름이 정확히 제거했다.
//   실측: 9,602자 골을 3000 에서 자르면 `… groundGoalInCodebase 를 src/auto` 에서 끊겼고,
//   감독자가 *"원문 요구도 `src/auto` 에서 잘려 있어 수렴 범위를 확정할 수 없다"* 며
//   **UNCONVERGEABLE** 을 냈다. 일하던 런이 **자름 때문에** 버려진 것이다.
//
// ⇒ 원칙 둘:
//   ① **계약 절을 먼저 싣는다** — 수용 기준·규칙·스코프 경계·원문 ask 는 감독 판단의 재료다.
//   ② ⭐ **자르면 잘랐다고 말한다** — 조용한 자름이 위 사고의 원인이다.

/**
 * 감독 판단에 필요한 순서. 앞일수록 먼저 담는다(예산이 모자라면 뒤가 밀린다).
 *
 * ⛔⭐ **각 칸은 동의어 집합이다** — 골에는 **두 방언**이 있다(T 리뷰 2026-07-28):
 *   · 저작기(`elanous self author`) 산출 → 영문 헤더(`## ACCEPTANCE CRITERIA` …)
 *   · 손으로 쓴 골            → 한글 헤더(`## 수용 기준` · `## 파일 경계` …)
 * 초판은 **영문만** 담아 손글씨 골의 계약 절을 **최하위로 매겼다** — 이 파일이 막으려는
 * 바로 그 사고가 **대상만 바뀌어** 재발한다. ⚠️ 그리고 손글씨 골은 소수가 아니다:
 * T 가 오늘 무인 완주시킨 두 건(#5814·#5820)이 **그 방언 위에 서 있다.**
 * ⇒ 다음 방언이 또 생겨도 **한 줄만 늘리면 되게** 집합으로 둔다.
 */
const PRIORITY: readonly (readonly string[])[] = [
  ['ACCEPTANCE CRITERIA', '수용 기준', '수용기준'],
  ['RULES', '규칙', '⚠️ 전제가 틀리면'],
  ['SCOPE BOUNDARY', '스코프 경계', '파일 경계', '불변식', '판정 신호', '경계'],
  ['리뷰 지적을 처리하는 규율', '리뷰 지적'],
  ['사전 실측', '왜 (실측', '왜(실측'],
  ['WHAT TO BUILD', '무엇을 만드나'],
];

/**
 * 예산 우선권을 받을 감독 판정 절의 명시적 제목 접두사다.
 * `rank()`의 유연한 정렬 동의어와 분리해 일반 서술 제목이 계약 몫을 차지하지 않게 한다.
 */
const SUPERVISOR_DECISION_TITLES = [
  'ACCEPTANCE CRITERIA', '수용 기준', '수용기준',
  'WHAT TO BUILD', '무엇을 만드나',
  'SCOPE BOUNDARY', '스코프 경계', '의도적 스코프 경계', '파일 경계',
  '불변식', '판정 신호',
] as const;

const SUPERVISOR_CONTRACT_TITLES = [
  ...SUPERVISOR_DECISION_TITLES,
  'RULES', '규칙', '⚠️ 전제가 틀리면',
] as const;
/** 계약 절 하나의 본문 몫은 일반 서술 절 하나의 세 배다. */
const CONTRACT_WEIGHT = 3;
const PROSE_WEIGHT = 1;

/** grounding 이 채우는 나열 줄 — 감독 판단에 값이 낮고 길이만 먹는다. */
const NOISE_LINE = /^\s*-\s+(Candidate requiring path tracing|Verified fact):/;

interface Section { readonly title: string; readonly body: string }

/** 말미 경고에 미리 떼어 두는 몫 — 이걸 안 빼면 결과가 예산을 넘는다(초판 실측 3229 > 3000). */
const RESERVED_FOR_NOTICE = 260;
/** 절 하나가 최소한 이만큼은 실린다 — 계약 절이 통째로 사라지는 것을 막는다. */
const MIN_SECTION_CHARS = 220;
/** 절 잘림 표시의 길이 상한(수렴 초기값). */
const MARKER_MAX = 40;

function truncMarker(n: number): string { return `\n… [이 절에서 ${n}자 잘림 — 없는 것이 아니다]`; }

function buildNotice(dropped: readonly string[], truncated: readonly string[], noise: number): string {
  if (!dropped.length && !truncated.length && !noise) return '';
  const bits: string[] = [];
  if (dropped.length) bits.push(`절 ${dropped.length}개 통째로(${dropped.join(' · ')})`);
  if (truncated.length) bits.push(`절 ${truncated.length}개 부분(${truncated.join(' · ')})`);
  if (noise) bits.push(`grounding 나열 ${noise}줄`);
  return `⚠️ 이 요약에서 빠진 것: ${bits.join(' · ')}.`
    + ` 빠진 것을 근거로 "스코프 밖"이나 "수렴 불가"를 판정하지 마라 — 안 본 것이지 없는 것이 아니다.`;
}

/**
 * ⚠️ 상수를 그대로 쓰면 **작은 `limit` 에서 계약 절이 하나도 못 실린다**(T should-fix).
 * 예: `limit=500` 이면 경고 몫 260 을 뗀 240 에 최소 몫 220 이라 절 하나가 겨우 들어가고
 * 헤더까지 세면 못 들어간다. ⇒ 작은 예산에서는 **둘 다 비례로 줄인다.**
 */
function scaled(limit: number): { reserved: number; minSection: number } {
  const base = RESERVED_FOR_NOTICE + MIN_SECTION_CHARS * 2;   // 경고 + 계약 절 최소 둘
  if (limit >= base) return { reserved: RESERVED_FOR_NOTICE, minSection: MIN_SECTION_CHARS };
  const k = limit / base;
  return { reserved: Math.floor(RESERVED_FOR_NOTICE * k), minSection: Math.max(40, Math.floor(MIN_SECTION_CHARS * k)) };
}

/** 골 문서에서 `판정 신호` 절만 뽑아 리뷰 acceptance 로 쓴다. 계보 = self-implement seams. */
export function extractHarnessReviewAcceptance(goalDocument: string | undefined): { goal: string | undefined; acceptance: string | undefined } {
  let goal: string | undefined;
  try {
    goal = goalDocument?.trim() || undefined;
  } catch {
    return { goal: undefined, acceptance: undefined };
  }
  if (!goal) return { goal: undefined, acceptance: undefined };
  try {
    const acceptance = splitGoalSections(supervisorGoalDigest(goal, 3000).text)
      .find((section) => isSupervisorDecisionSection(section.title) && section.title.includes('판정 신호'))
      ?.body.trim() || undefined;
    return { goal, acceptance };
  } catch {
    return { goal, acceptance: undefined };
  }
}

/** `## <제목>` 기준으로 절을 가른다. 헤더 앞 서두는 제목 `''` 로 담는다. */
export function splitGoalSections(goal: string): Section[] {
  return extractGoalDocSections(goal, {
    search: 'heading-regexp',
    heading: /^##\s+(.+?)\s*$/,
    endHeading: /^##\s+(.+?)\s*$/,
    includePreamble: true,
    trimBody: true,
  }).map(({ heading, body }) => ({ title: heading ?? '', body })).filter((section) => section.body.length > 0);
}

/** 우선순위 인덱스. 제목이 **동의어 중 하나라도** 포함하면 그 순위(제목이 장식을 달고 있어도 잡힌다). */
export function rank(title: string): number {
  for (const [i, keys] of PRIORITY.entries()) if (keys.some((k) => title.includes(k))) return i;
  return PRIORITY.length;
}

export interface GoalDigestResult {
  /** 감독자에게 실을 본문. */
  readonly text: string;
  /** 예산에 못 들어가 빠진 절 제목들(빈 배열이면 전부 실렸다). */
  readonly droppedSections: readonly string[];
  /** 일부만 실려 뒤가 잘린 절 제목들(빈 배열이면 모든 실린 절이 온전하다). */
  readonly truncatedSections: readonly string[];
  /** 노이즈로 걷어낸 줄 수. */
  readonly droppedNoiseLines: number;
}

/**
 * 감독자용 골 요약을 만든다.
 *
 * ⚠️ 예산을 넘겨도 **조용히 자르지 않는다** — 무엇이 빠졌는지 본문 끝에 명시한다.
 * 감독자가 *"원문이 잘려 판단할 수 없다"* 고 **말할 수 있어야** 하기 때문이다(그게 실제로 일어났다).
 */
/**
 * 감독 판정에 쓰는 절만 계약 예산을 받는다. 제목 뒤 장식은 명확한 구분자로만 허용해
 * `불변식에 대한 배경`과 `판정 신호 분석` 같은 일반어 확장을 계약으로 오인하지 않는다.
 */
function matchesContractTitle(title: string, contractTitles: readonly string[]): boolean {
  const normalized = title.trim();
  return contractTitles.some((contractTitle) => normalized === contractTitle
    || (normalized.startsWith(contractTitle)
      && /^\s*(?:[—:：(\[·]|[-–]\s)/.test(normalized.slice(contractTitle.length))));
}

/** 다섯 감독 판정 절만 잴 때 쓰는 엄격한 제목 경계다. */
export function isSupervisorDecisionSection(title: string): boolean {
  return matchesContractTitle(title, SUPERVISOR_DECISION_TITLES);
}

export function isSupervisorContract(title: string): boolean {
  return matchesContractTitle(title, SUPERVISOR_CONTRACT_TITLES);
}

export function supervisorGoalDigest(goal: string, limit = 3000): GoalDigestResult {
  const sections = splitGoalSections(goal);
  let droppedNoiseLines = 0;
  const cleaned = sections.map((s) => {
    const kept = s.body.split('\n').filter((l) => {
      if (NOISE_LINE.test(l)) { droppedNoiseLines += 1; return false; }
      return true;
    });
    return { title: s.title, body: kept.join('\n').trim() };
  }).filter((s) => s.body.length > 0);

  const head = (s: Section) => (s.title ? `## ${s.title}\n` : '');
  const cost = (s: Section, bodyLen: number) => head(s).length + bodyLen + 2;   // 절 사이 빈 줄

  /** 절을 방(room)에 맞춘다. ⭐ **항상 원문 기준**으로 잘린 양을 센다(리뷰 must-fix ④ 2차:
   *  이미 marker 가 붙은 중간 문자열을 다시 자르면 누락량이 원문과 어긋난다). */
  function fit(orig: string, room: number, wholeLinesOnly = false): { text: string; cut: number } {
    if (orig.length <= room) return { text: orig, cut: 0 };
    let keep = Math.max(0, room - MARKER_MAX);
    let marker = truncMarker(orig.length - keep);
    keep = Math.max(0, room - marker.length);
    if (wholeLinesOnly) keep = Math.max(0, orig.lastIndexOf('\n', keep - 1) + 1);
    const cut = orig.length - keep;
    return { text: `${orig.slice(0, keep)}${truncMarker(cut)}`, cut };
  }

  // ⭐⭐ **계약 절이 먼저 자리를 잡는다**(리뷰 must-fix ① 2차). 초판은 모든 절에 **균등 몫**을
  //   예약해서, 3000자 안에 들어갈 수 있는 계약 본문이 잘린 채 **저우선 서술 절이 실렸다.**
  //   ⇒ ① 계약 절에 필요한 만큼 먼저 준다 ② 남은 것을 서술 절이 나눈다.
  const ordered = [...cleaned].sort((a, b) => rank(a.title) - rank(b.title));
  const contracts = ordered.filter((s) => isSupervisorContract(s.title));
  const rest = ordered.filter((s) => !isSupervisorContract(s.title));

  const alloc = new Map<Section, number>();   // 절 → 본문에 줄 방

  /**
   * 가중 워터필링은 계약 절 하나에 서술 절 하나의 두 배 몫을 준다. 짧은 절이 남긴 예산은
   * 아직 잘리지 않은 모든 절에 다시 나눠 계약 절 부재와 잔여 예산을 결정적으로 처리한다.
   */
  function waterfill(group: readonly Section[], pool: number): number {
    let left = Math.max(0, pool - group.reduce((sum, s) => sum + head(s).length + 2, 0));
    let pending = group.filter((s) => s.body.length > (alloc.get(s) ?? 0));
    while (pending.length > 0 && left > 0) {
      const weightTotal = pending.reduce((sum, s) => sum + (isSupervisorContract(s.title) ? CONTRACT_WEIGHT : PROSE_WEIGHT), 0);
      let spent = 0;
      for (const s of pending) {
        const weight = isSupervisorContract(s.title) ? CONTRACT_WEIGHT : PROSE_WEIGHT;
        const share = Math.floor(left * weight / weightTotal);
        const remaining = Math.max(0, s.body.length - (alloc.get(s) ?? 0));
        const room = Math.min(share, remaining);
        if (room > 0) {
          alloc.set(s, (alloc.get(s) ?? 0) + room);
          spent += room;
        }
      }
      if (spent === 0) {
        for (const s of pending) {
          if (left === 0) break;
          const remaining = Math.max(0, s.body.length - (alloc.get(s) ?? 0));
          if (remaining > 0) {
            alloc.set(s, (alloc.get(s) ?? 0) + 1);
            spent += 1;
            left -= 1;
          }
        }
      } else {
        left -= spent;
      }
      pending = pending.filter((s) => s.body.length > (alloc.get(s) ?? 0));
    }
    return left;
  }

  const total = Math.max(0, limit - scaled(limit).reserved);
  // 계약 여부는 정렬용 `rank()`와 독립적인 경계 있는 명시적 제목 표로 정한다. 가중치가
  // 계약 절마다 적용되므로 다섯 계약 절 각각은 같은 길이의 서술 절보다 덜 잘린다.
  waterfill(ordered, total);

  const truncated: string[] = [];
  const dropped = ordered.filter((s) => !alloc.has(s)).map((s) => s.title || '(서두)');
  const order = new Map(cleaned.map((s, i2) => [s, i2] as const));
  const pick = cleaned.filter((s) => alloc.has(s)).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  const render = (): string => {
    truncated.length = 0;
    const parts = pick.map((s) => {
      const { text, cut } = fit(s.body, alloc.get(s)!, rank(s.title) === 0);
      if (cut > 0) truncated.push(s.title || '(서두)');
      return `${head(s)}${text}`;
    });
    const notice = buildNotice(dropped, truncated, droppedNoiseLines);
    return [...parts, ...(notice ? [notice] : [])].join('\n\n');
  };

  let text = render();
  // ⛔⭐ **예산은 결과로 보장한다.** 넘치면 **저우선 절부터** 방을 줄이고 다시 렌더한다.
  //   ⚠️ 줄이는 것은 항상 `alloc`(원문에 대한 방)이라 누락량이 **원문 기준**으로 유지된다.
  for (let guard = 0; text.length > limit && guard < ordered.length * 3 + 4; guard += 1) {
    const victim = [...pick].sort((a, b) => rank(b.title) - rank(a.title))
      .find((s) => (alloc.get(s) ?? 0) > MIN_SECTION_CHARS / 2);
    if (!victim) break;
    alloc.set(victim, Math.max(0, (alloc.get(victim) ?? 0) - Math.max(40, text.length - limit)));
    text = render();
  }
  // ⛔ 마지막 방어(리뷰 must-fix ③ 2차): 안내문만으로도 예산을 넘는 극단이면 **안내문을 자르고
  //   잘랐다고 말한다**. 조용히 예산을 넘기지 않는다.
  if (text.length > limit) text = `${text.slice(0, Math.max(0, limit - 12))}\n…[요약 잘림]`;

  return { text, droppedSections: dropped, truncatedSections: truncated, droppedNoiseLines };
}
