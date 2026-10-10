// 🔁 「같은 지적이 되돌아왔나」를 «문면과 무관하게» 센다.
//
// ⛔⭐⭐ **왜 필요한가**(🅕 실측 2026-08-20 · 🅣 가 되재서 확인):
//   판사의 «산문»은 옳았다 — *"…이전 라운드와 동일하게 반복되어"*. 사람이 그 draft 를 열어
//   같은 지적임을 확인했다. 그런데 계측은 `repeatedBlockingFindingIds: []` 를 냈다.
//
//   📏 뿌리 둘을 갈랐다:
//   ⓐ `stableMustFixId` 는 must-fix «문장 전체»의 해시다.
//      ⇒ 리뷰어가 같은 지적을 «한 글자라도 다르게» 쓰면 id 가 완전히 달라진다(실측 확인).
//      ⛔ 그 함수를 «바꾸지 않는다» — 기각·인용 축이 그 id 에 매여 있다.
//   ⓑ 심볼 축(`citedReviewSymbols`)은 «멀쩡히 작동한다»(실측: sharedSymbolCount=1).
//      ⛔ 그런데 그것을 orchestrator 에 «넣어 주는 자»가 «전수 0» 이었다 —
//        `reworkBudgetReviewFindingRecurrence` 의 기본값이 `() => null` 이고 주입자가 없다.
//      ⇒ 🔑 ***검출기가 죽은 게 아니라 아무도 안 불렀다.***
//
// ⇒ ⭐ 그래서 이 셀은 «둘째 축»이다. id 축(정확하지만 문면에 취약)과 «나란히» 둔다.
//   ⛔ id 축을 «대체하지 않는다» — 둘이 다른 것을 잡는다.
import { citedReviewSymbols, reviewFindingKey } from '../agent-substrate/review-finding-key.js';

/** 심볼의 «기본 이름» — 마지막 `.` 뒤 ⊕ 뒤따르는 `()` 제거.
 *
 *  ⛔⭐⭐ **왜 이 축이 필요한가**(🅣 가 🅕 실물을 갈라 확인 · 2026-08-20):
 *  같은 API 를 리뷰어가 라운드마다 «다른 한정»으로 부른다:
 *  ```
 *  round 1  McpClientsHandle.authorizer · RegisterMcpClientsOpts.authorizer · revoke()
 *  round 2  McpToolAuthorizer.revoke()
 *  round 3  McpClientsHandle.authorizer · McpToolAuthorizer.revoke()
 *  ```
 *  ⇒ «전체 문자열»로 견주면 `revoke()` ↔ `McpToolAuthorizer.revoke()` 가 «안 겹친다»(실측 shared=0).
 *    기본 이름으로 접으면 `revoke` 가 ***round 1·2·3 연속 3*** 으로 드러난다.
 *  ⛔ 그렇다고 «전체 이름 축을 버리지 않는다** — 서로 다른 타입의 같은 멤버명을 한 덩이로 묶으면
 *    과검출이 난다. 두 축을 «따로» 센다. */
export function symbolBaseName(symbol: string): string {
  const withoutCall = symbol.replace(/\(\s*\)\s*$/, '').trim();
  const lastDot = withoutCall.lastIndexOf('.');
  return (lastDot >= 0 ? withoutCall.slice(lastDot + 1) : withoutCall).trim();
}

export interface RecurrenceFinding {
  readonly id: string;
  readonly item: string;
}

/** Pod 리뷰 예산 소진 잔여 분류(FLEX-POD-ACCEPT-1).
 *  `repeatedIds` = 앞 라운드와 id(내용 해시) 또는 비지 않은 `reviewFindingKey` 가 같은 지적.
 *  `keyOnlyRepeatedIds` = 그중 «키로만» 반복된 것(문면이 달라 내용 해시는 다르다).
 *  ⛔ 사양 v2(OP 18:1x (a)): Pod 수락은 «전부 내용 해시 반복»일 때만 — 키로만 반복된 지적은 관측만 하고 수락 근거로 쓰지 않는다. */
export function classifyPodReviewBudgetResidue(
  current: readonly RecurrenceFinding[] | undefined,
  previous: readonly RecurrenceFinding[] | undefined,
): { status: 'all-repeated' | 'has-new' | 'unmeasured'; repeatedIds: string[]; newIds: string[]; keyOnlyRepeatedIds: string[] } {
  if (!previous?.length || !current?.length) return { status: 'unmeasured', repeatedIds: [], newIds: [], keyOnlyRepeatedIds: [] };
  const previousIds = new Set(previous.map(({ id }) => id));
  const previousKeys = new Set(previous.map(({ item }) => reviewFindingKey(item).key).filter(Boolean));
  const repeatedIds: string[] = [];
  const newIds: string[] = [];
  const keyOnlyRepeatedIds: string[] = [];
  for (const { id, item } of current) {
    if (previousIds.has(id)) {
      repeatedIds.push(id);
      continue;
    }
    const key = reviewFindingKey(item).key;
    if (key !== '' && previousKeys.has(key)) {
      repeatedIds.push(id);
      keyOnlyRepeatedIds.push(id);
    } else newIds.push(id);
  }
  return { status: newIds.length ? 'has-new' : 'all-repeated', repeatedIds, newIds, keyOnlyRepeatedIds };
}

export interface AcceptedRefutationHistory {
  /** 반박이 수용되어 앞 라운드에 기각된 stable must-fix ID. */
  readonly acceptedRefutationFindingIds?: readonly string[];
}

/** 수용된 반박 이력이 읽힌 ID만 기각된 재발로 분류한다. 이력 부재·손상은 보수적으로 일반 반복이다. */
function isPreviouslyDismissedReviewFinding(
  findingId: string,
  history: AcceptedRefutationHistory | undefined,
): boolean {
  const dismissedIds = history?.acceptedRefutationFindingIds;
  return Boolean(findingId && Array.isArray(dismissedIds) && dismissedIds.includes(findingId));
}

export interface ReviewFindingRecurrence {
  /** id 가 «그대로» 같은 지적 수 — 정확하지만 문면이 바뀌면 «0이 된다». */
  readonly normalizedRepeatedReviewFindingCount: number;
  /** 수용된 반박 이력이 없는 일반 id 반복 수. 기존 total에서 기각된 재발만 분리한다. */
  readonly ordinaryRepeatedReviewFindingCount: number;
  /** 앞 라운드에서 수용된 반박으로 기각된 id가 다시 나온 횟수. 판정은 변경하지 않는 관측값이다. */
  readonly previouslyDismissedRepeatedReviewFindingCount: number;
  /** ⭐ 인용된 «심볼»이 «전체 이름»으로 겹치는 지적 수 — 문면이 바뀌어도 산다(한정은 같아야). */
  readonly citedReviewSymbolRepeatCount: number;
  /** ⭐⭐ «기본 이름»으로 겹치는 지적 수 — 한정이 라운드마다 달라도 «산다».
   *  ⛔ 전체 이름 축보다 «넓다» — 과검출 위험이 있어 «따로» 센다(합치지 않는다). */
  readonly citedReviewSymbolBaseNameRepeatCount: number;
  /** ⛔ 「셀 수 없었다」를 「0」과 «가른다» — 어느 쪽에도 심볼 인용이 없으면 비교 자체가 불가다. */
  readonly comparableFindings: number;
  /** 지적 키(`reviewFindingKey`)가 직전 라운드 키 집합에 있는 현재 라운드 지적 수.
   *  문장·id 가 달라도 같은 심볼 집합이면 같은 키라 잡힌다. ⛔ 이름에 normalized 를 쓰지 않는다 — 그 낱말은 id 축이다. */
  /** ⛔ optional 인 것은 «의도»다 — 필수 필드로 더하면 tsc 게이트가 «저장소 전체 검사»로 승격하고
   *  그 순간 이 축과 무관한 기존 76건(28파일 · test·widgets·plugins)에 걸려 무조건 막힌다(실측 2026-08-24).
   *  생산자는 «항상» 채우고 소비자는 `?? null` 로 읽으므로 호환 가능한 추가다. */
  readonly reviewFindingKeyRepeatCount?: number;
}

/**
 * 두 라운드의 blocking 지적을 견줘 「되돌아온 것」을 «두 축»으로 센다.
 *
 * ⛔ 한쪽이라도 «없으면» null — 「반복 0」이 아니라 ***「비교할 게 없다」***다.
 *   그 둘을 접으면 첫 라운드가 「반복 없음」으로 읽힌다.
 */
export function measureReviewFindingRecurrence(
  current: readonly RecurrenceFinding[] | undefined,
  previous: readonly RecurrenceFinding[] | undefined,
  acceptedRefutationHistory?: AcceptedRefutationHistory,
): ReviewFindingRecurrence | null {
  if (!current || !previous || current.length === 0 || previous.length === 0) return null;

  const previousIds = new Set(previous.map(({ id }) => id));
  // ⛔ 빈 키는 담지 않는다 — 서로 «다른» 공백 지적 둘이 같은 `''` 키로 «반복»이 된다(실측 2026-08-24).
  //   orchestrator.ts 의 누적 계수기가 이미 같은 방어(`if (!key) continue`)를 가진다.
  const previousKeys = new Set(previous.map((p) => reviewFindingKey(p.item).key).filter(Boolean));
  const priorSymbols = previous.map((p) => citedReviewSymbols(p.item).map((s) => s.symbol));
  const priorFull = new Set(priorSymbols.flat());
  const priorBase = new Set(priorSymbols.flat().map(symbolBaseName).filter(Boolean));
  // ⛔⭐ **비교 «상대»가 없으면 이 축은 못 잰다** — 이전 라운드에 심볼 인용이 «하나도» 없으면
  //   현재 쪽에 아무리 많아도 「반복 0」이 아니라 ***「잴 수 없었다」***다.
  //   📏 첫 판이 이 자리를 놓쳤다(리뷰 #10615 must-fix): comparableFindings=1 · 반복 0 을 냈고,
  //     읽는 쪽은 그것을 「봤는데 반복 없음」으로 읽는다. 내가 세운 분모 규칙을 «내가» 깼다.
  const comparableAgainstPrevious = priorFull.size > 0;

  let idRepeats = 0;
  let ordinaryIdRepeats = 0;
  let previouslyDismissedIdRepeats = 0;
  let keyRepeats = 0;
  let symbolRepeats = 0;
  let baseNameRepeats = 0;
  let comparable = 0;

  for (const finding of current) {
    if (previousIds.has(finding.id)) {
      idRepeats += 1;
      if (isPreviouslyDismissedReviewFinding(finding.id, acceptedRefutationHistory)) previouslyDismissedIdRepeats += 1;
      else ordinaryIdRepeats += 1;
    }
    const findingKey = reviewFindingKey(finding.item).key;
    if (findingKey && previousKeys.has(findingKey)) keyRepeats += 1;
    // ⛔ 심볼 인용이 «없는» 지적은 이 축으로 못 잰다 — 0 으로 세지 않고 «분모에서» 뺀다.
    //   ⊕ 비교 상대가 «없어도» 마찬가지다(양쪽 다 있어야 «견줄» 수 있다).
    if (!comparableAgainstPrevious) continue;
    const symbols = citedReviewSymbols(finding.item).map((s) => s.symbol);
    if (symbols.length === 0) continue;
    comparable += 1;
    if (symbols.some((s) => priorFull.has(s))) symbolRepeats += 1;
    if (symbols.map(symbolBaseName).filter(Boolean).some((s) => priorBase.has(s))) baseNameRepeats += 1;
  }

  return {
    normalizedRepeatedReviewFindingCount: idRepeats,
    ordinaryRepeatedReviewFindingCount: ordinaryIdRepeats,
    previouslyDismissedRepeatedReviewFindingCount: previouslyDismissedIdRepeats,
    citedReviewSymbolRepeatCount: symbolRepeats,
    citedReviewSymbolBaseNameRepeatCount: baseNameRepeats,
    comparableFindings: comparable,
    reviewFindingKeyRepeatCount: keyRepeats,
  };
}
