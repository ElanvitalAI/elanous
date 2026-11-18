// ELN-QUEUE-SUPERSEDE — «대체 후보» 판정(CONDUCTOR ELN-STEER-AND-TOOL-WATCHDOG §6 불변식 5 · 대표 보강으로 낮춤).
//
// S  턴 중 쏟아지는 발화 가운데 하나가 앞 대기 발화를 정정하는 일이 잦다(11-17 #37992·#37995 중복 PR).
// C  자동으로 옛 항목을 `superseded` 로 바꾸면 «새 발화 접수 ≠ 계획 자동 개정»(불변식 10)을 어긴다.
// Q  그럼 큐는 무엇을 하나?
// A  «같은 대상 ⊕ 정정어» 일 때만 새 항목에 «대체 후보» 표시를 붙이고, 화면 1줄 ⊕ 모델 맥락 1줄로 알린다.
//    상태는 바꾸지 않는다. 실제 전이는 `supersede(id, by)` 명시 호출(모델의 계획 도구 · 사람의 큐 조작)뿐이다.
//
// 이 파일은 순수하다 — 판정과 문면만. 기록·화면·모델 전달은 `src/tui/core/queue.ts` 와 `src/tui/entry.ts` 가 한다.
// ⏭ 대상 추출은 #38016 의 `extractTargets`(seat-task-decompose) 와 같은 일을 한다. #38016 이 아직 착지 전이라
//    아무것도 복사하지 않고 작게 새로 썼다 — 착지 뒤 하나로 합치는 것이 후속이다.

/** «같은 대상» 하나. PR 번호 `#N` · 칸 id `ELN-…` · 명시된 파일 경로. */
export type SupersedeTarget = string;

const PR_PATTERN = /(?:^|[^\w&#])#(\d+)\b/g;
const CELL_PATTERN = /\bELN-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;
/** 디렉터리 한 단 이상 ⊕ 확장자가 있는 경로만 «명시된 파일 경로»로 본다(`/help` 같은 명령은 아니다). */
const PATH_PATTERN = /(?:^|[\s(«'"`])((?:\.\/)?(?:[\w.@-]+\/)+[\w.@-]*\.[A-Za-z0-9]+)(?=$|[\s)»'"`,:;.!?])/g;

/** 발화에서 대상을 뽑는다. 순서는 처음 나온 순서, 중복 없음. 순수. */
export function extractSupersedeTargets(text: string): SupersedeTarget[] {
  const found: SupersedeTarget[] = [];
  const add = (target: SupersedeTarget): void => { if (!found.includes(target)) found.push(target); };
  for (const match of text.matchAll(PR_PATTERN)) add(`#${match[1]}`);
  for (const match of text.matchAll(CELL_PATTERN)) add(match[0]);
  for (const match of text.matchAll(PATH_PATTERN)) add(match[1]!.replace(/^\.\//, ''));
  return found;
}

/** 정정어 — 한국어는 어간 그대로(«말고»·«고쳐서»·«취소해»·«보류»), 영어는 낱말 경계. */
export const SUPERSEDE_CORRECTION_WORDS_KO = ['대신', '말고', '고쳐', '취소', '보류'] as const;
export const SUPERSEDE_CORRECTION_WORDS_EN = ['instead', 'not', 'cancel', 'hold'] as const;

const EN_CORRECTION_PATTERN = new RegExp(`\\b(${SUPERSEDE_CORRECTION_WORDS_EN.join('|')})\\b`, 'i');

/** 발화에 든 첫 정정어. 없으면 null. 순수. */
export function findCorrectionWord(text: string): string | null {
  let best: { word: string; at: number } | null = null;
  for (const word of SUPERSEDE_CORRECTION_WORDS_KO) {
    const at = text.indexOf(word);
    if (at >= 0 && (best === null || at < best.at)) best = { word, at };
  }
  const english = EN_CORRECTION_PATTERN.exec(text);
  if (english && (best === null || english.index < best.at)) best = { word: english[1]!.toLowerCase(), at: english.index };
  return best?.word ?? null;
}

/** 판정에 필요한 만큼의 대기 항목 모양 — `NextTuiQueueItem` 이 그대로 들어온다. */
export interface SupersedeQueueItem {
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly kind?: string;
}

export interface ReplacementCandidate {
  readonly kind: 'candidate';
  /** 새로 들어온 항목 — 대체할 «수도» 있는 쪽. */
  readonly id: string;
  /** 대기 중인 옛 항목 — 대체될 «수도» 있는 쪽. 상태는 그대로 `queued`. */
  readonly candidateFor: string;
  /** 두 발화가 함께 가리키는 대상. */
  readonly targets: readonly SupersedeTarget[];
  readonly correctionWord: string;
}

export type ReplacementDetection =
  | ReplacementCandidate
  | { readonly kind: 'none'; readonly reason: 'not-user' | 'no-target' | 'no-correction-word' | 'no-overlap' | 'ambiguous' };

/**
 * 새 항목이 대기 항목 하나를 대체할 «후보»인지 판정한다. 순수 — 아무것도 바꾸지 않는다.
 * - 새 항목·옛 항목 모두 사람 발화(`user`)여야 한다. 알림(`notice`)은 대상이 아니다.
 * - 옛 항목은 `queued` 여야 한다 — `delivered`(·active)·`cancelled`·`superseded` 는 절대 후보가 아니다.
 * - 대상이 겹치는 대기 항목이 정확히 하나일 때만 후보다. 0개 = 겹침 없음 · 2개 이상 = 모호 → 아무것도 안 한다.
 */
export function detectReplacementCandidate(
  newItem: SupersedeQueueItem,
  pendingItems: readonly SupersedeQueueItem[],
): ReplacementDetection {
  if (newItem.kind !== undefined && newItem.kind !== 'user') return { kind: 'none', reason: 'not-user' };
  const targets = extractSupersedeTargets(newItem.text);
  if (targets.length === 0) return { kind: 'none', reason: 'no-target' };
  const correctionWord = findCorrectionWord(newItem.text);
  if (correctionWord === null) return { kind: 'none', reason: 'no-correction-word' };
  const matches: { id: string; shared: SupersedeTarget[] }[] = [];
  for (const item of pendingItems) {
    if (item.id === newItem.id || item.status !== 'queued') continue;
    if (item.kind !== undefined && item.kind !== 'user') continue;
    const theirs = extractSupersedeTargets(item.text);
    const shared = targets.filter((target) => theirs.includes(target));
    if (shared.length > 0) matches.push({ id: item.id, shared });
  }
  if (matches.length === 0) return { kind: 'none', reason: 'no-overlap' };
  if (matches.length > 1) return { kind: 'none', reason: 'ambiguous' };
  const [match] = matches;
  return { kind: 'candidate', id: newItem.id, candidateFor: match!.id, targets: match!.shared, correctionWord };
}

const EXCERPT_LIMIT = 60;

/** 한 줄 발췌 — 줄바꿈은 공백으로 접고 길면 자른다(문면 한 줄 보장). 순수. */
export function supersedeExcerpt(text: string, limit = EXCERPT_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** 화면 1줄(알림 줄). 상태가 그대로라는 것과 누가 대체를 정하는지를 함께 말한다. 순수. */
export function replacementCandidateScreenLine(candidate: ReplacementCandidate, oldText: string): string {
  return `대체 후보: 앞 대기 «${supersedeExcerpt(oldText)}» (${candidate.targets.join(' · ')} · «${candidate.correctionWord}») · 자동 취소 없음`;
}

/** 모델 맥락 줄의 고정 머리 — 화면·앵커에서 떼어 낼 때 이것으로 알아본다. */
export const REPLACEMENT_CANDIDATE_NOTE_PREFIX = '[대체 후보 ';

/**
 * 모델 맥락 1줄 — 새 항목이 모델에게 전달될 때 그 앞에 붙는다(`withReplacementCandidateContext`).
 * «X 는 Y 로 대체될 수 있다» 는 맥락이지 지시가 아니다: 옛 항목은 자동 취소되지 않았다(불변식 10). 순수.
 * 옛 항목의 «지금» 상태로 문면을 고른다 — 꺼낼 때 이미 전달·실행된 옛 지시를 «대기 중» 이라고 말하지 않는다
 * (#38029 r1 MF: 같은 delivery 면 seq 순이라 정정 발화를 꺼낼 때 옛 발화는 이미 delivered 다).
 * 취소·대체된 옛 항목은 맥락 줄이 없다(null).
 */
export function replacementCandidateContextLine(
  candidate: ReplacementCandidate,
  oldText: string,
  oldStatus: string = 'queued',
): string | null {
  const head = `${REPLACEMENT_CANDIDATE_NOTE_PREFIX}${candidate.id}: `;
  const why = ` (같은 대상 ${candidate.targets.join(' · ')} · 정정어 «${candidate.correctionWord}»).`;
  if (oldStatus === 'queued') {
    return `${head}이 발화는 대기 중이던 ${candidate.candidateFor} «${supersedeExcerpt(oldText)}» 를 대체할 수 있습니다${why}`
      + ` ${candidate.candidateFor} 는 자동 취소되지 않았습니다 — 대체한다면 계획 도구로 명시적으로 개정하십시오.]`;
  }
  if (oldStatus === 'delivered') {
    return `${head}이 발화는 이미 전달·실행된 ${candidate.candidateFor} «${supersedeExcerpt(oldText)}» 를 고치려는 것일 수 있습니다${why}`
      + ` 앞 지시는 이미 실행됨 — 되돌릴지(예: 이미 만든 결과·PR 정리) 판단하고, 개정한다면 계획 도구로 명시적으로 하십시오.]`;
  }
  return null;
}
