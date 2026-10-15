// ── REVIEW-MUSTFIX-CLASSIFY — 리뷰 must-fix 를 «수의 추이»가 아니라 «회차 짝»으로 가른다 ──
//
// 수의 추이(improving·stable·worsening·oscillating)는 «새 실결함이 매번 나오는 정상 수렴»과
// «원리상 못 닫는 요구»를 못 가른다(#26644 · 10-12 · 5→3→2→3). 이 판정은 회차 짝으로 가른다:
//
//   ① new-defect        앞 회차에 없던 새 지적 — 그대로 수렴 간다(계속).
//   ② post-land-evidence 착지 뒤에만 낼 수 있는 증거(운영 소비·실물 착지·live 호출자)를 요구하는
//                          지적 — 같은 런 재수리 0 · «그림자 착지 → 관측 → live» 쪼개기 결정.
//   ③ recurring          수리 뒤 같은 지적이 다시 나옴 — intent 경계 자동 명시 ⊕ 다른 모델 교차 리뷰 제안.
//   unmeasured           이 회차 must-fix 를 안 쟀다 — 분류 불가, 슈퍼바이저 지금 동작 그대로.
//
// ⛔ 임의 임계(«두 번») 금지 — 짝은 «정규화 문면이 같다»는 사실 하나로 맞는다.

/** Evidence a must-fix item demands that only a landing can produce. */
export type MustFixEvidenceKind = 'ops-consumption' | 'artifact-landing' | 'live-caller';

export interface MustFixItem {
  /** Verbatim reviewer must-fix text. */
  readonly text: string;
  /** Evidence this item demands that only a landing can produce. */
  readonly evidence?: MustFixEvidenceKind;
  /** Pairing scope — the task that raised it (supervisor ledger); pairing never crosses tasks. */
  readonly taskId?: string;
}

/** One round's observed must-fix list; `items` undefined/empty = the round's review was not observed. */
export interface MustFixRoundObservation {
  readonly items?: readonly MustFixItem[];
}

export type MustFixClass = 'new-defect' | 'post-land-evidence' | 'recurring' | 'unmeasured';

export interface MustFixRoundClassification {
  readonly class: MustFixClass;
  readonly reason: string;
  /** ② post-land-evidence — 같은 런 재수리 0, «그림자 착지 → 관측 → live» 쪼개기 결정. */
  readonly split?: 'shadow-land → observe → live';
  /** ③ recurring — intent 경계 자동 명시 ⊕ 다른 모델 교차 리뷰 제안. */
  readonly crossReview?: true;
  /** Evidence kinds this round's items demand (②). */
  readonly evidence?: readonly MustFixEvidenceKind[];
  /** Recurring item texts, normalized (③). */
  readonly recurring?: readonly string[];
}

/** Evidence subjects, each matched as a whole word group. */
const EVIDENCE_SUBJECTS: ReadonlyArray<readonly [MustFixEvidenceKind, string]> = [
  ['live-caller', String.raw`(?:live|라이브)\s*(?:호출자|caller)`],
  ['ops-consumption', String.raw`(?:운영(?:에서)?\s*소비|(?:prod(?:uction)?|ops)\s*consumption)`],
  ['artifact-landing', String.raw`(?:(?:실물|실제)\s*착지|artifact\s*landing)`],
];
/** Korean: «<대상>[ 증거](를|을)? <요구>» or «<대상> 증거가 없다». */
const KO_DEMAND = String.raw`(?:\s*(?:증거|증명)\s*(?:를|을)?|\s*(?:를|을))?\s*(?:보여라|보여\s*달라|대라|증명하라|입증하라|못\s*봤다|관측되지\s*않았다|확인되지\s*않았다)`;
const KO_MISSING = String.raw`\s*(?:증거|증명)\s*(?:가|이)?\s*없다`;
/** English: «show|prove|demonstrate [the] <subject> [evidence]» or «no <subject> evidence». */
const EN_PREFIX = String.raw`(?:show|prove|demonstrate)\s+(?:the\s+)?`;

/**
 * Derive the post-land evidence kind a must-fix text *demands* — allow-list only: the WHOLE text (trimmed,
 * one optional terminal «.»/«!») must be one of the pure evidence-demand forms above. Anything else — a second
 * sentence, a comma, «그리고», a defect word, a different verb — stays undefined, i.e. ① same-run repair
 * (의심스러우면 ① = 안전한 기본). Widening the recognised forms is a follow-up; outside them is ① on purpose.
 */
export function inferMustFixEvidence(text: string): MustFixEvidenceKind | undefined {
  const t = text.trim().toLowerCase().replace(/\s+/gu, ' ').replace(/[.!]$/u, '');
  for (const [kind, subject] of EVIDENCE_SUBJECTS) {
    const forms = [
      `${subject}${KO_DEMAND}`,
      `${subject}${KO_MISSING}`,
      `${EN_PREFIX}${subject}(?:\\s+evidence)?`,
      `no\\s+${subject}\\s+evidence`,
    ];
    if (forms.some((form) => new RegExp(`^${form}$`, 'u').test(t))) return kind;
  }
  return undefined;
}

/** Pairing key: whitespace collapsed, lower-cased — same discipline as `noPrStreakKey`. */
function mustFixKey(text: string): string {
  return text.trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function classifyMustFixRound(
  prev: MustFixRoundObservation | undefined,
  cur: MustFixRoundObservation,
): MustFixRoundClassification {
  const curItems = cur.items ?? [];
  if (curItems.length === 0) {
    return { class: 'unmeasured', reason: '이 회차 리뷰 must-fix 를 안 쟀다 — 분류 불가, 슈퍼바이저 지금 동작 그대로' };
  }
  const prevItems = prev?.items ?? [];
  // Pairing never crosses tasks: same normalized text AND both sides name the same task — unknown origin never pairs.
  const pairs = (p: MustFixItem, c: MustFixItem): boolean => mustFixKey(p.text) === mustFixKey(c.text)
    && p.taskId !== undefined && c.taskId !== undefined && p.taskId === c.taskId;
  const recurring = curItems.filter((item) => prevItems.some((p) => pairs(p, item)));
  if (prevItems.length > 0 && recurring.length > 0) {
    return {
      class: 'recurring',
      reason: `같은 지적이 수리 뒤에 다시 나왔다(${recurring.length}) — intent 경계를 명시하고 다른 모델 교차 리뷰를 제안한다`,
      crossReview: true,
      recurring: recurring.map((item) => mustFixKey(item.text)),
    };
  }
  // ② only when every item demands post-land evidence — a real defect mixed in still gets its same-run repair (①).
  const evidence = [...new Set(curItems.flatMap((item) => (item.evidence ? [item.evidence] : [])))];
  if (curItems.every((item) => item.evidence !== undefined)) {
    return {
      class: 'post-land-evidence',
      reason: `증거는 착지 뒤에만 난다(${evidence.join(' · ')}) — 같은 런 재수리 0, 그림자 착지 → 관측 → live 로 쪼갠다`,
      evidence,
      split: 'shadow-land → observe → live',
    };
  }
  return { class: 'new-defect', reason: '앞 회차에 없던 새 지적 — 새 실결함 수렴으로 그대로 간다' };
}
