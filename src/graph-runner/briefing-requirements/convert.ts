export interface BriefTopic {
  summary: string;
  sourceScrapIds: string[];
}

export interface BriefInput {
  briefing: { id: string; owner: string; topics: BriefTopic[] };
  acceptance: { suggestionId: string; owner: string; accepted: true; service: string };
  capacityAssumption?: { concurrentUsers: number; rationale: string };
}

/** Scene 2/3 graph outputs, with no invented topics or acceptance record. */
export interface AbsorbBriefInput {
  memberId: string;
  briefing: { id: string; memberId?: string; groups: Array<{ title?: string; summary?: string; points?: string[]; scrapId?: string; scrapIds?: string[] }>; scrapIds: string[]; todos?: string[] };
  suggestion: { id: string; appId: string; change: string; evidenceScrapIds: string[] };
  build: { status: 'done' | 'failed'; suggestionId: string; memberId?: string };
  capacityAssumption?: { concurrentUsers: number; rationale: string };
}

export interface RequirementsReceipt {
  schemaVersion: 1;
  briefingId: string;
  suggestionId: string;
  sourceScrapIds: string[];
  assumptions: string[];
  lines: [string, string, string];
  prompt: string;
  assumptionSource: 'explicit' | 'scene4-demo-default';
}

const singleLine = (value: string): string => value.replace(/\s+/gu, ' ').trim();

function normalizeAbsorb(input: AbsorbBriefInput): BriefInput {
  const { memberId, briefing, suggestion, build } = input;
  if (!memberId || !briefing?.id || !briefing.memberId || briefing.memberId !== memberId)
    throw new Error('same-owner briefing and build required');
  if (!suggestion?.id || !suggestion.appId || !singleLine(suggestion.change ?? '') || !Array.isArray(suggestion.evidenceScrapIds)
    || !suggestion.evidenceScrapIds.length || !Array.isArray(briefing.scrapIds)
    || suggestion.evidenceScrapIds.some(id => !briefing.scrapIds.includes(id))) throw new Error('suggestion needs briefing source scrap IDs');
  if (build?.status !== 'done' || build.suggestionId !== suggestion.id) throw new Error('accepted suggestion build receipt required');
  if (!build.memberId || build.memberId !== memberId) throw new Error('same-owner briefing and build required');
  const topics = briefing.groups?.map(group => ({
    summary: singleLine([group.summary || group.title, ...(group.points ?? [])].filter(Boolean).join(' ')),
    sourceScrapIds: group.scrapIds ?? (group.scrapId ? [group.scrapId] : []),
  })) ?? [];
  if (topics.some(topic => topic.sourceScrapIds.some(id => !briefing.scrapIds.includes(id))))
    throw new Error('group source scrap IDs must belong to briefing');
  const linkedTopics = topics.filter(topic => topic.sourceScrapIds.some(id => suggestion.evidenceScrapIds.includes(id)));
  if (!linkedTopics.length) throw new Error('suggestion evidence must link to a briefing group');
  const changeIntent = singleLine(suggestion.change).replace(/\s*(?:만들기|구현하기|만들어\s*줘|구현해\s*줘)$/u, '').trim();
  const appIntent = /^app[-_][\da-f-]+$/iu.test(suggestion.appId) ? '' : suggestion.appId.replace(/[-_]/gu, ' ');
  const service = singleLine([appIntent, changeIntent].filter(Boolean).join(' · '));
  return { briefing: { id: briefing.id, owner: memberId, topics: linkedTopics },
    acceptance: { suggestionId: suggestion.id, owner: memberId, accepted: true, service },
    capacityAssumption: input.capacityAssumption ?? { concurrentUsers: 100_000, rationale: '장면 4 피크 부하 검증을 위한 데모 가정; 원문 기사 수치가 아님' } };
}

export function convertBriefToRequirements(input: BriefInput | AbsorbBriefInput): RequirementsReceipt {
  const fromAbsorb = 'suggestion' in input;
  const normalized = fromAbsorb ? normalizeAbsorb(input) : input;
  const { briefing, acceptance } = normalized;
  if (!briefing?.id || !briefing.owner || !Array.isArray(briefing.topics) || briefing.topics.length === 0) throw new Error('briefing id, owner and topics required');
  if (!acceptance?.accepted || !acceptance.suggestionId || !acceptance.service || acceptance.owner !== briefing.owner) throw new Error('accepted same-owner suggestion required');
  if (briefing.topics.some(topic => !singleLine(topic.summary ?? '') || !Array.isArray(topic.sourceScrapIds) || !topic.sourceScrapIds.length || topic.sourceScrapIds.some(id => !id))) throw new Error('each topic needs summary and source scrap IDs');
  const evidence = briefing.topics.map(topic => singleLine(topic.summary)).join(' · ');
  const sources = [...new Set(briefing.topics.flatMap(topic => topic.sourceScrapIds))];
  const assumption = normalized.capacityAssumption;
  if (!assumption || !Number.isSafeInteger(assumption.concurrentUsers) || assumption.concurrentUsers <= 0 || !singleLine(assumption.rationale ?? '')) throw new Error('explicit capacity assumption and rationale required');
  const service = singleLine(acceptance.service);
  const lines: [string, string, string] = [
    `${service} 시스템 아키텍처를 설계해줘.`,
    `규모: 동시 ${assumption.concurrentUsers.toLocaleString('ko-KR')}명(설계 가정: ${singleLine(assumption.rationale)}).`,
    `핵심 제약: ${evidence}. 미정책은 가정으로 명시하고 질문 없이 초안을 완성해줘.`,
  ];
  return { schemaVersion: 1, briefingId: briefing.id, suggestionId: acceptance.suggestionId, sourceScrapIds: sources,
    assumptions: [`동시 사용자 ${assumption.concurrentUsers}명: ${singleLine(assumption.rationale)}`], lines, prompt: lines.join('\n'),
    assumptionSource: fromAbsorb && !input.capacityAssumption ? 'scene4-demo-default' : 'explicit' };
}
