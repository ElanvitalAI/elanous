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

// ── 범위 판정 축 (REVIEW-MUSTFIX-CLASSIFY 첫 조각 · 대표 10-17 19:3x) ──
//
// 회차 분류(①②③) 위에 must-fix «한 줄마다» 범위를 가른다:
//   in-scope   (가) 이 PR 범위 안 — 언급한 파일이 PR 변경 파일·칸 대상 경로 안이고, 쪼갤 신호가 없다 → 고친다.
//   split      (나) 새 축 — PR 밖 파일 · 다른 PR · 설계 문서 · 다른 자리 결정 · 앞 라운드에 없던 축(r≥3) · ③ recurring
//                    · ② 착지 뒤 증거(③·② 는 범위 입력·경로와 무관하게 split) → 같은 런에서 고치지 않고 «중간 착지 ⊕ 연결 골»로 뗀다.
//   ask-owner  (다) 판단 불가 — 신호가 엇갈리거나, 범위 입력(변경 파일·대상 경로)이 없거나, 신호가 하나도 없다 → 칸 주인 HITL.
// ⛔ 결정적 신호만(이 조각엔 LLM 판정 없음). ⛔ 입력이 없으면 «범위 밖 신호 없음»으로 읽지 않는다 — ask-owner.
// ⛔ in-scope 는 «긍정 증거»(PR 안 파일 언급)가 있을 때만 — 신호가 없다고 범위 안이 아니다.

export type MustFixScope = 'in-scope' | 'split' | 'ask-owner';

export type MustFixScopeSignal =
  | 'path-inside' | 'path-outside' | 'other-pr' | 'design-doc' | 'seat-decision'
  | 'new-axis' | 'recurring' | 'post-land-evidence' | 'no-scope-input' | 'no-signal'
  /** PR 번호를 언급했지만 이 PR 번호를 모른다 — 자기 번호일 수 있어 other-pr 로 단정하지 않는다. */
  | 'pr-unknown'
  /** 대상 경로 밖이지만 PR 변경 파일을 안 쟀다 — 실제 변경 파일일 수 있어 «밖»으로 단정하지 않는다. */
  | 'path-unmeasured';

export interface MustFixScopeInput {
  /** PR 변경 파일 목록. undefined = 안 쟀다(빈 배열과 다르다). */
  readonly changedFiles?: readonly string[];
  /** 칸·골 대상 경로(hotPaths). undefined = 안 쟀다. */
  readonly targetPaths?: readonly string[];
  /** 이 PR 번호 — 자기 번호 언급은 «다른 PR» 이 아니다. */
  readonly prNumber?: number;
  /** 리뷰 라운드(1부터). undefined = 안 쟀다 → new-axis 신호를 안 낸다. */
  readonly reviewRound?: number;
  /** 앞 라운드 must-fix. undefined = 안 쟀다 → new-axis 신호를 안 낸다. */
  readonly prevItems?: readonly MustFixItem[];
  /** 이 회차 ③ recurring 으로 짝지어진 정규화 문면. */
  readonly recurring?: readonly string[];
}

export interface MustFixScopeJudgement {
  readonly text: string;
  readonly scope: MustFixScope;
  readonly signals: readonly MustFixScopeSignal[];
  readonly reason: string;
  /** 언급한 경로 중 PR 범위 밖인 것 — 연결 골 대상 경로 초안. */
  readonly outsidePaths?: readonly string[];
  /** 언급한 경로 중 PR 범위 안인 것. */
  readonly insidePaths?: readonly string[];
  /** ② 착지 뒤 증거 종류 — 연결 골 판정선을 시험이 아니라 착지 후 관측으로 낸다. */
  readonly evidence?: MustFixEvidenceKind;
}

const SPLIT_SIGNALS: ReadonlySet<MustFixScopeSignal> = new Set([
  'path-outside', 'other-pr', 'design-doc', 'seat-decision', 'new-axis', 'recurring', 'post-land-evidence',
]);
/** «앞 라운드에 없던 축»이 쪼갤 신호가 되는 첫 라운드(대표 규칙 «r3 부터 (나) 먼저 뗀다»). */
export const NEW_AXIS_SPLIT_FROM_ROUND = 3;

const PATH_RE = /(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z]{1,5}\b|\b[\w-]+(?:\.[\w-]+)*\.(?:tsx?|mjs|cjs|jsx?|json|md|ya?ml|sh|py)\b/gu;
const DESIGN_DOC_RE = /\b(?:RFC|MANUAL|DECISION)[-_\s]/u;
const SEAT_DECISION_RE = /(?:다른\s*자리|자리\s*결정|대표\s*결정|\u{1F451}|owner\s+decision|another\s+seat)/iu;

function normPath(p: string): string {
  return p.replace(/^\.\//u, '').replace(/[),.;:]+$/u, '');
}

/** 경로가 범위 집합 안인가 — 정확 일치 · 디렉터리 접두 · (언급이 파일 이름뿐이면) 파일 이름 일치. */
function pathInside(mention: string, scope: readonly string[]): boolean {
  const m = normPath(mention);
  return scope.some((raw) => {
    const s = normPath(raw);
    if (s === m) return true;
    if (s.endsWith('/') ? m.startsWith(s) : m.startsWith(`${s}/`)) return true;
    return !m.includes('/') && s.split('/').at(-1) === m;
  });
}

/** 단순 토큰 자카드(2자 이상 · 소문자) — 앞 라운드에 없던 축 판정용. */
export function mustFixTokenJaccard(a: string, b: string): number {
  const tok = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length >= 2));
  const x = tok(a);
  const y = tok(b);
  if (x.size === 0 && y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

export function judgeMustFixScope(item: MustFixItem, input: MustFixScopeInput): MustFixScopeJudgement {
  const signals: MustFixScopeSignal[] = [];
  const scopePaths = [...(input.changedFiles ?? []), ...(input.targetPaths ?? [])];
  const scopeMeasured = input.changedFiles !== undefined || input.targetPaths !== undefined;
  const mentions = [...new Set((item.text.match(PATH_RE) ?? []).map(normPath))];
  const insidePaths = scopeMeasured ? mentions.filter((m) => pathInside(m, scopePaths)) : [];
  const outsidePaths = scopeMeasured ? mentions.filter((m) => !pathInside(m, scopePaths)) : mentions;
  if (!scopeMeasured) signals.push('no-scope-input');
  else {
    if (insidePaths.length) signals.push('path-inside');
    // 변경 파일을 안 쟀으면 대상 경로 밖이라는 사실만으로 «PR 밖»이 아니다.
    if (outsidePaths.length) signals.push(input.changedFiles === undefined ? 'path-unmeasured' : 'path-outside');
  }
  const prs = [...item.text.matchAll(/#(\d{5})\b/gu)].map((m) => Number(m[1]));
  if (prs.length > 0 && input.prNumber === undefined) signals.push('pr-unknown');
  else if (prs.some((n) => n !== input.prNumber)) signals.push('other-pr');
  if (DESIGN_DOC_RE.test(item.text)) signals.push('design-doc');
  if (SEAT_DECISION_RE.test(item.text)) signals.push('seat-decision');
  if (item.evidence !== undefined) signals.push('post-land-evidence');
  if (input.recurring?.includes(mustFixKey(item.text))) signals.push('recurring');
  if (input.reviewRound !== undefined && input.reviewRound >= NEW_AXIS_SPLIT_FROM_ROUND
    && input.prevItems !== undefined && input.prevItems.length > 0
    && input.prevItems.every((p) => mustFixTokenJaccard(p.text, item.text) === 0)) signals.push('new-axis');

  const split = signals.filter((s) => SPLIT_SIGNALS.has(s));
  const paths = {
    ...(outsidePaths.length ? { outsidePaths } : {}),
    ...(insidePaths.length ? { insidePaths } : {}),
    ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
  };
  if (signals.includes('recurring')) {
    return { text: item.text, scope: 'split', signals, reason: '같은 축이 수리 뒤 다시 나왔다 — 같은 런 재수리 대신 연결 골로 뗀다', ...paths };
  }
  // ② 착지 뒤 증거는 줄 단위 사실 — 경로가 PR 안이어도 같은 런에서 못 낸다. 회차 분류 ② 와 늘 같은 갈래(split)로 간다.
  if (signals.includes('post-land-evidence')) {
    return { text: item.text, scope: 'split', signals, reason: '증거는 착지 뒤에만 난다 — 그림자 착지 → 관측 → live 연결 골로 뗀다', ...paths };
  }
  if (signals.includes('path-unmeasured')) {
    return { text: item.text, scope: 'ask-owner', signals, reason: '대상 경로 밖 경로를 언급했지만 PR 변경 파일을 안 쟀다 — PR 밖인지 못 가린다', ...paths };
  }
  if (signals.includes('pr-unknown')) {
    return { text: item.text, scope: 'ask-owner', signals, reason: 'PR 번호를 언급했는데 이 PR 번호를 모른다 — 다른 PR 인지 못 가린다', ...paths };
  }
  if (split.length > 0 && !scopeMeasured) {
    return { text: item.text, scope: 'ask-owner', signals, reason: `쪼갤 신호(${split.join(' · ')})는 있으나 범위 입력이 없다 — 이 PR 이 이미 맡았는지 못 가린다`, ...paths };
  }
  if (split.length > 0 && signals.includes('path-inside')) {
    return { text: item.text, scope: 'ask-owner', signals, reason: `신호가 엇갈린다 — PR 안 파일 언급 ⊕ 쪼갤 신호(${split.join(' · ')})`, ...paths };
  }
  if (split.length > 0) {
    return { text: item.text, scope: 'split', signals, reason: `이 PR 범위 밖 신호(${split.join(' · ')}) — 중간 착지 ⊕ 연결 골로 뗀다`, ...paths };
  }
  if (signals.includes('path-inside')) {
    return { text: item.text, scope: 'in-scope', signals, reason: '언급한 파일이 PR 범위 안이고 쪼갤 신호가 없다 — 이 PR 에서 고친다', ...paths };
  }
  if (scopeMeasured) signals.push('no-signal');
  return {
    text: item.text, scope: 'ask-owner', signals,
    reason: scopeMeasured ? '범위 신호가 하나도 없다 — «없다»를 범위 안으로 읽지 않고 칸 주인에게 묻는다' : '범위 입력(변경 파일·대상 경로)이 없다 — 칸 주인에게 묻는다',
    ...paths,
  };
}

/** (나) split 한 줄의 «중간 착지 ⊕ 연결 골» 제안 — 다음 라운드 intent 스코프 경계 문장 ⊕ 연결 골 초안. */
export interface MustFixSplitProposal {
  readonly text: string;
  /** 다음 라운드 intent «의도적 스코프 경계» 에 넣을 문장(이유 포함). */
  readonly intentScopeBoundary: string;
  /** 연결 골 초안 — 대상 경로 ⊕ 판정선 한 줄. targetPaths 가 비면 «대상 경로 미상»(저작 단계에서 채운다). */
  readonly linkGoal: { readonly targetPaths: readonly string[]; readonly verdictLine: string };
}

function clip(text: string, n = 120): string {
  const t = text.trim().replace(/\s+/gu, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function testPathFor(path: string): string | undefined {
  if (/\.test\.tsx?$/u.test(path)) return path;
  const m = /^(.*)\.(tsx?)$/u.exec(path);
  return m ? `${m[1]}.test.${m[2]}` : undefined;
}

const EVIDENCE_OBSERVATION: Record<MustFixEvidenceKind, string> = {
  'live-caller': 'live 호출자가 실제로 부르는 것',
  'ops-consumption': '운영이 실제로 소비하는 것',
  'artifact-landing': '실물이 실제로 착지한 것',
};

/**
 * 연결 골 대상 경로는 지적이 «언급한» 경로만 — 원래 골의 hotPaths 를 끌어다 대지 않는다(근거 없음 → 미상, 저작 단계에서 채운다).
 * ② 착지 뒤 증거는 시험 통과로 증명되지 않으므로 판정선을 «그림자 착지 뒤 관측»으로 낸다.
 */
export function proposeMustFixSplit(j: MustFixScopeJudgement): MustFixSplitProposal {
  const targetPaths = j.outsidePaths?.length ? [...j.outsidePaths] : j.insidePaths?.length ? [...j.insidePaths] : [];
  const test = targetPaths.map(testPathFor).find((p): p is string => p !== undefined);
  const subject = clip(j.text, 80);
  if (j.evidence !== undefined) {
    return {
      text: j.text,
      intentScopeBoundary: `«${subject}» — 미완이 아니라 이 PR 의 결정이다: ${j.reason}(신호 ${j.signals.join(' · ')}). 연결 골로 뗐다 · 이것으로 must-fix 를 만들지 말 것`,
      linkGoal: {
        targetPaths,
        verdictLine: `판정(착지 뒤 관측): 그림자 착지 뒤 ${EVIDENCE_OBSERVATION[j.evidence]}을 로그·원장에서 관측 — 관측 명령은 저작 단계에서 채운다(시험 통과만으로는 증명 아님)`,
      },
    };
  }
  return {
    text: j.text,
    intentScopeBoundary: `«${subject}» — 미완이 아니라 이 PR 의 결정이다: ${j.reason}(신호 ${j.signals.join(' · ')}). 연결 골로 뗐다 · 이것으로 must-fix 를 만들지 말 것`,
    linkGoal: {
      targetPaths,
      verdictLine: test
        ? `판정: bun test ${test} → «${subject}» 고정 시험 ⊕ 0 fail`
        : `판정: «${subject}» 해소를 반증 명령 한 줄로 — 대상 경로 ${targetPaths.length ? targetPaths.join(' ') : '미상'}(저작 단계에서 채운다)`,
    },
  };
}
