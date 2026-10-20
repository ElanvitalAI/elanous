const EXPLICIT_OBLIGATION_MODAL = /\b(?:must|should|needs?\s+to|is\s+required\s+to)\s+/gi;
const OBLIGATION_HARD_BOUNDARY = /[.;!?]|\s+but\s+|\s+(?:although|because|while)\s+/i;
const COORDINATED_OBLIGATION = /\s+(?:and|or)\s+|,\s*(?:(?:and|or)\s+)?/i;
const PRESERVATION_OBLIGATION_VERB = /^(?:preserve|remain|retain|keep|maintain)$/i;
// ⛔⭐ 수동태 보존(`must be preserved` · `should be unchanged`)은 동사가 `be` 라 위 배제를 빠져나간다.
//    실측 2026-08-03: `this behavior should be preserved across releases` 가 요구로 오탐됐다.
//    ⚠️ 오탐 비용이 낮지 않다 — 이 판정은 clarification 을 만들고, 미답 clarification 은
//    발사 전 도달 경로를 태운다(`RUN-S13`). ⇒ `be` 뒤의 분사만 좁게 더 본다.
const PRESERVATION_PARTICIPLE = /^(?:preserved|retained|kept|maintained|unchanged|intact|stable)$/i;

/** Persistent evidence remains a preservation contract; only preservation verbs are excluded from explicit modal obligations. */
/** ⭐ 테스트가 **배포 코드**를 물게 export 한다 — 종전 회귀는 정규식을 복사해 vacuous 였다(`[T]` 반증 자기검증). */
export function hasUnmetRequirementOutsidePreservationClause(evidence: string): boolean {
  return explicitObligationPhrases(evidence).some((phrase) => {
    const [verb, next] = phrase.trim().split(/\s+/, 2);
    if (!verb) return false;
    if (PRESERVATION_OBLIGATION_VERB.test(verb)) return false;
    // `be preserved` / `be unchanged` 처럼 수동태로 쓴 보존은 요구가 아니다.
    if (/^be$/i.test(verb) && next && PRESERVATION_PARTICIPLE.test(next)) return false;
    return true;
  });
}

/** 배제 판정에 `be <분사>` 를 보려면 동사 하나가 아니라 구가 필요하다. */
function explicitObligationPhrases(evidence: string): string[] {
  const modals = Array.from(evidence.matchAll(EXPLICIT_OBLIGATION_MODAL));
  return modals.flatMap((modal, index) => {
    const start = (modal.index ?? 0) + modal[0].length;
    const nextModal = modals[index + 1]?.index ?? evidence.length;
    const remaining = evidence.slice(start, nextModal);
    const boundary = remaining.search(OBLIGATION_HARD_BOUNDARY);
    const obligation = remaining.slice(0, boundary === -1 ? remaining.length : boundary);
    return obligation.split(COORDINATED_OBLIGATION).map((phrase) => phrase.trim()).filter(Boolean);
  });
}
