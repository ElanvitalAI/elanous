const TAIL_CHARS = 160;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const NON_REPLY_LINE = /^\s*(?:✔ (?:완료|done)|✘ (?:실패|failed)|응답 완료|응답 중|라우팅:|󰧑|⚙️|도구:|나:|↻ 자동 재개|⏰|⏸|⏹|❯)/u;
const PLEDGE_ALTS = [
  '[가-힣]+겠습니다', '[가-힣]+겠다', '[가-힣]*[갈낼될들랄릴볼할줄쓸올만]게요',
  '(?:해야|진행해야|완료해야|만들어야|실행해야|마쳐야|끝내야) (?:합니다|한다|해요|됩니다)',
  '(?:멈췄습니다|멈춰 있었습니다|중단했습니다)', "\\bI(?:'ll| will| need to| should)\\b[^?]*",
  "\\blet me\\b[^?]*", "\\bnext,? I\\b[^?]*",
].map((p) => `(?:${p})`).join('|');
const PLEDGE_RE = new RegExp(`(?:${PLEDGE_ALTS})[.!。…\\s]*$`, 'iu');
const ACK_END = /(?:알겠|좋겠|감사하겠|되겠|모르겠|있겠|없겠|같겠)(?:습니다|다)[.!。…\s]*$/u;
const ASKS_HUMAN = /(?:\?|？|까요[.!]?\s*$|주세요[.!]?\s*$|주시면|원하시면|알려 주|말씀해|선택해|승인(?:해 주세요|이 필요)|괜찮을까|어떨까|확인 부탁|let me know|please (?:confirm|choose)|tell me (?:if|which|what))/iu;

export type GoalContinueVerdict =
  | { pledge: true; phrase: string }
  | { pledge: false; reason: 'no-reply' | 'asks-human' | 'not-pledge' };

export function replyTailFromLines(lines: readonly string[]): string | null {
  const reply: string[] = [];
  for (let i = lines.length - 1; i >= 0 && reply.length < 6; i--) {
    const plain = lines[i]!.replace(ANSI, '').trimEnd();
    if (!plain.trim()) { if (reply.length) break; continue; }
    if (NON_REPLY_LINE.test(plain)) { if (reply.length) break; continue; }
    reply.unshift(plain.trim());
  }
  if (!reply.length) return null;
  const text = reply.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text;
}

/** A reply that ends by naming its next step as a noun phrase — «다음 스텝: …» · «다음 자리 턴: …» · «Next step: …» —
 *  instead of a verb pledge. Seen in the D/E/MOB-1 stalls: the turn ends right after declaring the step (ELN-CONTINUE-AFTER-DECLARED-NEXT-STEP). */
const NEXT_STEP_DECLARED = /(?:다음\s*(?:한\s*)?(?:스텝|단계|자리\s*턴|작업|할\s*일)|next\s+(?:step|action))\s*[:：=→\-–—][^?？]{3,}$/iu;

/** The same declaration written as a sentence — «다음 스텝은 … 커밋 작업입니다.» · «할 일은 …» · «다음 턴에 … 예정» · «The next step is …»
 *  (D 07:46: the turn ended on such a sentence, no auto-continue fired). Open work + no blocker is the criterion, so a closing
 *  that says nothing is left, or hands the choice to a person, never counts. */
const NEXT_STEP_PROSE = new RegExp(
  '(?:(?:다음\\s*(?:한\\s*)?(?:스텝|단계|작업|할\\s*일|자리\\s*턴)|(?:남은|할|해야\\s*할)\\s*(?:일|작업|것|단계|스텝)|다음으로\\s*할\\s*것)\\s*(?:은|는|이|가)\\s*[^?？]{4,}'
  + '|(?:다음\\s*턴|다음\\s*자리\\s*턴|이어서)[^?？]{3,}?예정(?:입니다|이다|임|이에요)?'
  + '|\\b(?:the\\s+)?(?:next\\s+(?:step|action)|remaining\\s+(?:work|steps?))\\s+(?:is|are|will be)\\b[^?]{4,})[.!。…\\s]*$', 'iu');
const NOTHING_LEFT = /(?:없습니다|없다|없어요|없음|없었|모두\s*(?:끝|완료|처리)|전부\s*(?:끝|완료)|완료했습니다|끝났습니다|nothing\s+(?:left|remains)|no\s+(?:more|remaining)|none\b)/iu;

export function classifyReplyTail(tail: string | null): GoalContinueVerdict {
  if (!tail) return { pledge: false, reason: 'no-reply' };
  const sentences = tail.split(/(?<=[.!?。？])\s+/u).filter(Boolean);
  const last = sentences.at(-1) ?? tail;
  if (ASKS_HUMAN.test(last)) return { pledge: false, reason: 'asks-human' };
  if (ACK_END.test(last)) return { pledge: false, reason: 'not-pledge' };
  const m = PLEDGE_RE.exec(last);
  if (m) return { pledge: true, phrase: m[0].trim() };
  const declared = NEXT_STEP_DECLARED.exec(tail);
  if (declared && !ASKS_HUMAN.test(declared[0])) return { pledge: true, phrase: declared[0].trim().slice(0, 80) };
  const prose = NEXT_STEP_PROSE.exec(last) ?? NEXT_STEP_PROSE.exec(tail);
  if (prose && !ASKS_HUMAN.test(prose[0]) && !NOTHING_LEFT.test(prose[0])) return { pledge: true, phrase: prose[0].trim().slice(0, 80) };
  return { pledge: false, reason: 'not-pledge' };
}
