// ── 답의 약속 추출 `commitment-extract` (ELN-COMMITMENT-LEDGER · I1 · 2026-11-17) ──────────────────────
//
// 🚨 무엇을 푸는가: 자리가 «다음 스텝: …»·«이어서 …»·«…하겠습니다»·«확인 후 보고» 를 적고 턴을 끝내면, 그 약속은
//   화면 글로만 남고 아무도 추적하지 않는다(11-17 D 06:07 실측 — METHOD-SELF-PROACTIVE-1117 I1).
// ⭐ 이 모듈은 어시스턴트 «최종 답 전문»에서 약속 문장을 뽑는다. 원장(commitment-ledger.ts)에 싣는 것은 호출자 몫이다.
// ⛔ 순수 판정 — 파일·로그·TUI 의존 0. LLM 추론 아님 — 정규식 휴리스틱이고 «보수적»이다(놓침 > 오탐).
//   · 코드 블록(```)·인라인 코드·인용줄(>)·표 줄(|)·제목(#)은 건너뛴다.
//   · 문장 «끝»이 미래 약속형일 때만 잡는다(문장 중간 «…하겠습니다» 인용은 약속이 아니다).
//   · 과거형·가정(«원하시면 …하겠습니다»)·사람에게 묻는 문장(«?»·«…할까요»)·부정 약속(«않겠습니다»)은 버린다.
// ⚖️ #38049 `classifyReplyTail`(src/chat/goal-continue-verdict.ts) 과 갈래: 그쪽은 «답 꼬리가 약속인가»(자동 계속
//   방아쇠 · 한 문장) · 이쪽은 «답 전체에 약속이 몇 개 있나»(원장 항목 · 여러 문장). 같은 어휘 결을 따르되 상태는 나누지 않는다.

/** 추출된 약속 하나 — 원장 항목의 재료. */
export interface ExtractedCommitment {
  /** 사람이 읽는 약속 내용 — «다음 스텝: X» 면 X, 그 밖엔 문장 전체(앞 목록 기호 제거). */
  text: string;
  /** 근거 문장 — 답에 실제로 있던 문장 원문(목록 기호만 걷음). */
  evidence: string;
  /** 어떤 꼴로 잡혔나 — 관측·시험용. */
  pattern: CommitmentPattern;
  /** 문장에 보이는 «깨울 조건» 단서 — I3 깨우개(eln msg wait-for)의 조건 문법으로 바로 옮길 수 있는 것만. */
  waitHint?: CommitmentWaitHint;
}

export type CommitmentPattern = 'declared-next-step' | 'continue-marker' | 'pledge-ko' | 'pledge-en' | 'report-after-check';

/** I3 조건 문법(`pr-merged:N` · `review:N` · `mail-reply:M` · `time:<dur>`)과 1:1 — 문면에 숫자가 있을 때만. */
export type CommitmentWaitHint =
  | { kind: 'pr-merged'; pr: number }
  | { kind: 'review'; pr: number }
  | { kind: 'mail-reply'; message: number }
  | { kind: 'time'; minutes: number };

// ── 건너뛸 영역 ─────────────────────────────────────────────────────────────────────────

const FENCE = /^\s*(```|~~~)/;
const SKIP_LINE = /^\s*(?:>|\||#{1,6}\s)/;
const INLINE_CODE = /`[^`\n]*`/g;
/** 직선·굽은 큰따옴표 인용 — 남의 말·예시. «»는 이 저장소의 강조 관례라 지우지 않고, 문장 끝 판정에서만 비운다. */
const DQUOTE = /"[^"\n]*"|“[^”\n]*”/g;
const GUILLEMET = /«[^»\n]*»/g;
const LIST_MARKER = /^\s*(?:[-*+•]|\d+[.)])\s+/;
/** 문장 경계 — 마침표류 뒤 공백. 줄바꿈은 이미 갈랐다. */
const SENTENCE_SPLIT = /(?<=[.!?。？…])\s+/u;
const TRAILING_PUNCT = /[\s.!。…~]+$/u;

// ── 버릴 문장 ─────────────────────────────────────────────────────────────────────────

/** 사람에게 묻는 문장 — 물음표·«let me know» 는 어디서든, «…할까요/…인가요/…주세요» 는 문장 끝(끝 문장부호 뗀 뒤). */
const ASKS_HUMAN_ANY = /[?？]|let me know|please (?:confirm|choose)/iu;
const ASKS_HUMAN_END = /(?:까요|나요|인가요|을까|할지|주세요|주십시오|바랍니다)$/u;
/** 사람 쪽 조건에 걸린 가정 제안 — «원하시면·필요하시면·승인해 주시면 …하겠습니다» · «If you want, I'll …». */
const HYPOTHETICAL = /(?:원하시면|필요하다면|원한다면|괜찮다면|필요하시면|괜찮으시면|승인(?:해\s*)?(?:주시면|하시면)|허락(?:해\s*)?주시면|말씀(?:해\s*)?주시면|알려\s*주시면|요청하시면|시키시면|\bif you\b|\bshould you\b|\bonce you\b|\bwhen you\b|\bwould\b|\bcould\b|\bmight\b)/iu;
/** 부정 약속·인사·추측 어미 — 일의 약속이 아니다(«않겠습니다»·«알겠습니다»·«좋겠습니다»·«…것 같겠다»). */
const NOT_A_PLEDGE = /(?:않겠|말겠|안\s*하겠|못\s*하겠|알겠|좋겠|감사하겠|되겠|모르겠|있겠|없겠|같겠|싶겠|반갑겠|기쁘겠|won't|will not|never)/iu;
/** 과거·완료형 끝 — «했습니다·했음·끝냈다·완료» 는 보고이지 약속이 아니다. */
const PAST_END = /(?:했|었|았|였|됐|냈|봤|왔|갔|줬|썼|렸|켰|쳤|졌)(?:다|습니다|음|어요|어|죠)$|(?:완료|끝남|끝|마침|done|finished|completed)$/iu;

// ── 잡을 문장 ─────────────────────────────────────────────────────────────────────────

/** «다음 스텝: X» · «다음 단계 → X» · «Next step: X» — 명사형 선언(#38049 NEXT_STEP_DECLARED 와 같은 결). */
const DECLARED_NEXT = /^(?:다음\s*(?:한\s*)?(?:스텝|단계|작업|할\s*일|자리\s*턴)|남은\s*(?:일|것|작업)|next\s+(?:steps?|actions?))\s*[:：=→\-–—]\s*(.{3,})$/iu;
/** «이어서 X 합니다/하겠습니다/한다» — 문장 머리 «이어서·계속해서» ⊕ 현재·미래 서술 끝. */
const CONTINUE_MARKER = /^(?:이어서|계속해서|곧이어)\s+(.{3,})$/u;
const CONTINUE_END = /(?:합니다|한다|갑니다|간다|봅니다|본다|돌립니다|올립니다|냅니다|보고합니다)$/u;
/** 한국어 미래 약속 어미(문장 끝) — «…하겠습니다·…하겠다·…할게요·…해 두겠음». */
const PLEDGE_KO = /(?:[가-힣]+겠(?:습니다|다|음|어요)|[가-힣]*[갈낼될들랄릴볼할줄쓸올만둘걸](?:게요|게))$/u;
/** 영어 1인칭 미래 — 문장 머리 근처의 «I'll / I will / I'm going to / Let me / Next, I». */
const PLEDGE_EN = /^(?:(?:ok(?:ay)?|now|next|then|so|first|after that)[,\s]+)?(?:I(?:'ll| will| am going to|'m going to)|let me|next,? I(?:'ll| will))\s+\S/iu;
/** «확인 후 보고» · «결과 보고 드리겠습니다» · «report back» — 끝이 과거가 아니면 약속. */
const REPORT_AFTER_CHECK = /(?:확인\s*(?:후|하고|되면|뒤)\s*(?:보고|알리|공유|회신)|결과\s*(?:를\s*)?보고|report back|follow up)/iu;

// ── 깨울 조건 단서 ─────────────────────────────────────────────────────────────────────

const HINT_PR_MERGED = /(?:#(\d+)\s*(?:이|가|PR)?\s*(?:머지|merge|착지|land)|(?:PR\s*)?#(\d+)\s*(?:is\s*)?merged)/iu;
const HINT_REVIEW = /#(\d+)[^#]{0,20}?(?:리뷰|review)\s*(?:결과|result|도착|arriv)/iu;
const HINT_MAIL = /(?:우편|메일|mail|msg)\s*#(\d+)[^#]{0,12}?(?:회신|답|repl)/iu;
const HINT_TIME = /(\d+)\s*(?:분|min(?:ute)?s?)\s*(?:뒤|후|after|later)|in\s+(\d+)\s*min(?:ute)?s?/iu;

export function detectWaitHint(sentence: string): CommitmentWaitHint | undefined {
  const review = HINT_REVIEW.exec(sentence);
  if (review) return { kind: 'review', pr: Number(review[1]) };
  const pr = HINT_PR_MERGED.exec(sentence);
  if (pr) return { kind: 'pr-merged', pr: Number(pr[1] ?? pr[2]) };
  const mail = HINT_MAIL.exec(sentence);
  if (mail) return { kind: 'mail-reply', message: Number(mail[1]) };
  const time = HINT_TIME.exec(sentence);
  if (time) {
    const minutes = Number(time[1] ?? time[2]);
    if (Number.isSafeInteger(minutes) && minutes > 0) return { kind: 'time', minutes };
  }
  return undefined;
}

// ── 문장 나누기 ─────────────────────────────────────────────────────────────────────────

/** 답 전문 → 판정 대상 문장들(코드·인용·표·제목 제외 · 목록 기호 걷음). */
export function commitmentCandidateSentences(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    if (FENCE.test(raw)) { inFence = !inFence; continue; }
    if (inFence || SKIP_LINE.test(raw)) continue;
    const line = raw.replace(LIST_MARKER, '').replace(INLINE_CODE, ' ').trim();
    if (!line) continue;
    for (const s of line.split(SENTENCE_SPLIT)) {
      const sentence = s.trim();
      if (sentence) out.push(sentence);
    }
  }
  return out;
}

function normalizedKey(text: string): string {
  return text.replace(/\s+/g, ' ').replace(TRAILING_PUNCT, '').trim().toLowerCase();
}

/** 한 문장 판정 — 약속이면 꼴과 내용, 아니면 null. */
export function classifyCommitmentSentence(sentence: string): ExtractedCommitment | null {
  const evidence = sentence.trim();
  // 판정용 사본: 따옴표 인용은 통째로 비우고, «» 는 안쪽만 비운다(문장 끝 판정을 인용이 흐리지 않게).
  const probe = evidence.replace(DQUOTE, ' ').replace(GUILLEMET, '«»').replace(/\s+/g, ' ').trim();
  const bare = probe.replace(TRAILING_PUNCT, '');
  if (!bare || ASKS_HUMAN_ANY.test(probe) || ASKS_HUMAN_END.test(bare)) return null;
  if (HYPOTHETICAL.test(probe)) return null;
  if (NOT_A_PLEDGE.test(bare.slice(-24))) return null;
  const waitHint = detectWaitHint(evidence);
  const make = (text: string, pattern: CommitmentPattern): ExtractedCommitment =>
    ({ text: text.replace(TRAILING_PUNCT, '').trim(), evidence, pattern, ...(waitHint ? { waitHint } : {}) });

  const declared = DECLARED_NEXT.exec(evidence.replace(TRAILING_PUNCT, ''));
  if (declared) {
    const content = declared[1]!.trim();
    if (PAST_END.test(content.replace(TRAILING_PUNCT, ''))) return null;
    return make(content, 'declared-next-step');
  }
  if (PAST_END.test(bare)) return null;
  if (CONTINUE_MARKER.test(bare) && (CONTINUE_END.test(bare) || PLEDGE_KO.test(bare))) return make(evidence, 'continue-marker');
  if (PLEDGE_KO.test(bare)) {
    return make(evidence, REPORT_AFTER_CHECK.test(bare) ? 'report-after-check' : 'pledge-ko');
  }
  if (PLEDGE_EN.test(bare)) return make(evidence, REPORT_AFTER_CHECK.test(bare) ? 'report-after-check' : 'pledge-en');
  // «확인 후 보고» 명사형(«PR 착지 확인 후 보고») — 끝이 과거가 아니고 약속 어미도 없는 짧은 선언.
  if (REPORT_AFTER_CHECK.test(bare) && /(?:보고|공유|회신|report back|follow up)$/iu.test(bare)) return make(evidence, 'report-after-check');
  return null;
}

/**
 * 어시스턴트 최종 답 전문 → 약속 목록(답 안 같은 내용은 하나로).
 * 보수적: 확신 없는 문장은 버린다. 원장 등재·상태 전이는 하지 않는다(§6 불변식 10 — 접수 ≠ 개정).
 */
export function extractCommitments(finalText: string): ExtractedCommitment[] {
  if (typeof finalText !== 'string' || !finalText.trim()) return [];
  const seen = new Set<string>();
  const out: ExtractedCommitment[] = [];
  for (const sentence of commitmentCandidateSentences(finalText)) {
    const found = classifyCommitmentSentence(sentence);
    if (!found) continue;
    const key = normalizedKey(found.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(found);
  }
  return out;
}
