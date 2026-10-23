const TAIL_CHARS = 160;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const NON_REPLY_LINE = /^\s*(?:✔ 완료|✘ 실패|응답 완료|응답 중|라우팅:|󰧑|⚙️|도구:|나:|↻ 자동 재개|⏰|⏸|⏹|❯)/u;
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

export function classifyReplyTail(tail: string | null): GoalContinueVerdict {
  if (!tail) return { pledge: false, reason: 'no-reply' };
  const sentences = tail.split(/(?<=[.!?。？])\s+/u).filter(Boolean);
  const last = sentences.at(-1) ?? tail;
  if (ASKS_HUMAN.test(last)) return { pledge: false, reason: 'asks-human' };
  if (ACK_END.test(last)) return { pledge: false, reason: 'not-pledge' };
  const m = PLEDGE_RE.exec(last);
  if (!m) return { pledge: false, reason: 'not-pledge' };
  return { pledge: true, phrase: m[0].trim() };
}
