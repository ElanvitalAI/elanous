import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Parse the explicit peak size before the tool-free drafting route is selected. */
export function scene4ConcurrentUsers(prompt: string): number {
  // The three-line contract is what / scale / constraints. Only the scale
  // line can set capacity; cited numbers in the brief or constraints cannot.
  const scaleLine = prompt.trim().split(/\r?\n/u)[1] ?? prompt;
  const leads = scaleLine.matchAll(/(?:동시|concurrent)\s*((?:(?:접속(?:자)?|사용자|이용자|관객|users?|connections?|수)\s*)*)(?:(?:약|대략|최대|about|around)\s*)*/giu);
  let best: { score: number; users: number } | null = null;
  for (const lead of leads) {
    let rest = scaleLine.slice(lead.index! + lead[0].length);
    if (/^\d+\s*천\s*\d+\s*백만/u.test(rest)) continue; // Unsupported compound unit: never silently emit the wrong capacity.
    let total = 0;
    let previousMultiplier = Number.POSITIVE_INFINITY;
    let ambiguousUnits = false;
    for (;;) {
      const part = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(천만|백만|십만|억|만|천|백|십)?/u.exec(rest);
      if (!part) break;
      const multiplier = { 천만: 10_000_000, 백만: 1_000_000, 십만: 100_000, 억: 100_000_000, 만: 10_000, 천: 1_000, 백: 100, 십: 10 }[part[3] as '천만' | '백만' | '십만' | '억' | '만' | '천' | '백' | '십'] ?? 1;
      if (multiplier >= previousMultiplier) { ambiguousUnits = true; break; }
      previousMultiplier = multiplier;
      total += Number(`${part[1]!.replaceAll(',', '')}${part[2] ? `.${part[2]}` : ''}`) * multiplier;
      rest = rest.slice(part[0].length).trimStart();
      if (!part[3] || !/^\d/u.test(rest)) break;
    }
    if (ambiguousUnits || !Number.isSafeInteger(total) || total < 1 || /^(?:천만|백만|십만|억|만|천|백|십)/u.test(rest)
      || /^(?:개(?:의)?|회)\s*(?:공연|콘서트|행사|좌석|장)/u.test(rest)) continue;
    const score = (/^(?:명|인|users?|connections?)/iu.test(rest) ? 2 : 0)
      + (lead[1]?.trim() ? 1 : 0);
    if (!best || score > best.score) best = { score, users: total };
  }
  return best?.users ?? 0;
}

/** A scene-specific drafting turn. Explicit requests for questions stay in ordinary chat. */
export function isTicketingArchitecturePrompt(prompt: string): boolean {
  const lines = prompt.trim().split(/\r?\n/u);
  const questionRequests = /(?:먼저|우선|설계\s*전에).{0,40}(?:(?:확인|필요한)\s*)?질문(?:을|부터)?(?:\s*몇\s*(?:개|가지))?\s*(?:해줘|해주세요|해\s*주(?:시겠어요|실래요|실\s*수\s*있나요|세요|십시오)|하라|부탁(?:드립니다|해요|해줘)|주세요|주십시오|원합니다)|(?:먼저|우선|설계\s*전에).{0,40}물어(?:봐|봐줘|주세요)|질문(?:을|부터)?\s*(?:먼저\s*)?(?:해줘|해주세요|하라)|ask\s+(?:me\s+)?(?:clarifying\s+)?questions\s+(?:first|before\s+designing)/giu;
  const asksFirst = [...prompt.matchAll(questionRequests)].some(request => {
    const tail = prompt.slice(request.index! + request[0].length).trimStart();
    return !/^(?:가\s*아니라|말고|아니고|대신)/u.test(tail);
  });
  return lines.length === 3 && /티켓|ticket/iu.test(prompt) && /설계|아키텍처|design/iu.test(prompt)
    && /대기열|queue/iu.test(prompt) && /좌석|seat/iu.test(prompt) && /결제|payment/iu.test(prompt)
    && scene4ConcurrentUsers(prompt) > 0 && !asksFirst;
}

export const SCENE4_DRAFT_POLICY = '이 턴은 검토용 시스템 설계 초안이다. 미정인 제품 정책은 가정으로 명시하고, 추가 질문을 기다리지 말고 지금 완결된 설계를 답하라. 저장소 탐색·도구 호출·파일 작성은 하지 마라. 출력 그래프가 RFC·다이어그램·PDF를 생성한다.';

/** Model tools and preamble see a scratch workspace; the user's cwd is restored after the turn. */
export async function withScene4Workspace<T>(prompt: string, deps: {
  getCwd: () => string;
  setCwd: (cwd: string) => void;
  run: () => Promise<T>;
}): Promise<T> {
  if (!isTicketingArchitecturePrompt(prompt)) return deps.run();
  const previous = deps.getCwd();
  const isolated = mkdtempSync(join(tmpdir(), 'elanous-scene4-'));
  try {
    deps.setCwd(isolated);
    return await deps.run();
  } finally {
    try { deps.setCwd(previous); }
    finally { rmSync(isolated, { recursive: true, force: true }); }
  }
}
