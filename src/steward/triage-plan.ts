import { resolveRoleModel } from '../user-config.js';
import type { HitlReason, Rung, TriageIssue } from './triage.js';

export type StewardAsk = (prompt: string, role: 'classify' | 'planning') => Promise<unknown>;
export interface ClassifiedIssue { issue: string; rung: Rung; why: string; hitlReason?: HitlReason; duplicateOf?: string }
export interface IssuePlan { issue: string; priority: number; dependsOn: string[]; owner?: string }

const unsafe: Array<[HitlReason, RegExp]> = [
  ['money', /돈|유료|결제|구매|판매|송금|환불|크레딧\s*(?:추가|구매)|paid|payment|purchase/i],
  ['public', /공개|발행|외부\s*게시|publish|public\s*release/i],
  ['security', /보안|(?:API|보안|인증|접근)\s*키|(?:키|자격|권한|secret|credential|permission)\s*(?:변경|교체|발급|삭제|공유|노출)|키체인|\b(?:api[ -]?key|secret[ -]?key|access[ -]?token)\b/i],
  ['irreversible', /비가역|강제\s*푸시|force.push|영구\s*삭제|리셋권\s*소비|drop\s*table|초기화/i],
];

export function unsafeReason(issue: TriageIssue): HitlReason | undefined {
  return unsafe.find(([, pattern]) => pattern.test(`${issue.title}\n${issue.body}`))?.[0];
}

function parsed(raw: unknown): Record<string, unknown> {
  const value: unknown = typeof raw === 'string'
    ? JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()) : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid steward response');
  return value as Record<string, unknown>;
}

export function ruleJudgment(issue: TriageIssue, issues: TriageIssue[]): ClassifiedIssue | undefined {
  const normalize = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const title = normalize(issue.title);
  const index = issues.findIndex(item => item.identifier === issue.identifier);
  const prior = index < 0 ? issues.filter(item => item.identifier !== issue.identifier) : issues.slice(0, index);
  // Same title alone is not proof: two different tasks can share a title. Only same title AND same body is a
  // rule duplicate; anything else goes to classification.
  const body = normalize(issue.body ?? '');
  const duplicate = title && prior.find(item => normalize(item.title) === title && normalize(item.body ?? '') === body);
  if (duplicate) return { issue: issue.identifier, rung: 0, duplicateOf: duplicate.identifier, why: `duplicate of ${duplicate.identifier}` };
  return undefined;
}

export async function askSteward(prompt: string, role: 'classify' | 'planning'): Promise<unknown> {
  const { streamLLM } = await import('../llm.js');
  const result = await streamLLM([{ role: 'user', content: prompt }], () => {}, { model: resolveRoleModel(role).model });
  return parsed(result);
}

export async function classifyIssue(issue: TriageIssue, ask: StewardAsk = askSteward): Promise<ClassifiedIssue> {
  const candidate = unsafeReason(issue);
  const response = parsed(await ask(`스튜어드 분류. JSON 객체만: {"rung":0|1|2|3|4|5|"hitl","hitlReason":null,"why":"한 문장"}. 0=이미됨, 1=셸, 2=CLI, 3=조사, 4=하니스 골, 5=외부 에이전트. 돈·공개·보안·비가역은 hitl; 그 외 사람 확인은 other. 확인되지 않은 완료를 추측하지 마라. ${candidate ? `안전 후보 ${candidate}: 이유를 확인하라.` : ''}\n이슈: ${JSON.stringify(issue)}`, 'classify'));
  if (![0, 1, 2, 3, 4, 5, 'hitl'].includes(response.rung as Rung) || typeof response.why !== 'string' || !response.why.trim()) throw new Error(`Invalid steward classification: ${issue.identifier}`);
  const reason = candidate ?? (unsafe.some(([name]) => name === response.hitlReason) ? response.hitlReason as HitlReason : undefined)
    ?? (response.rung === 'hitl' ? 'other' : undefined);
  return { issue: issue.identifier, rung: reason ? 'hitl' : response.rung as Rung,
    ...(reason ? { hitlReason: reason } : {}), why: response.why.trim().replace(/\s+/g, ' ') };
}

/** One request for the current batch, never one request per issue. */
export async function planIssues(classified: ClassifiedIssue[], ask: StewardAsk = askSteward, tracks?: Record<string, string>, issues: TriageIssue[] = []): Promise<IssuePlan[]> {
  if (!classified.length) return [];
  const keys = Object.keys(tracks ?? {});
  const byId = new Map(issues.map(issue => [issue.identifier, issue]));
  const response = parsed(await ask(`스튜어드 계획. 새로 분류한 이슈마다 priority(숫자), dependsOn(제공된 이슈 키 배열), owner(담당 트랙 키 또는 null)를 정해 JSON {"plans":[{"issue":"키","priority":1,"dependsOn":[],"owner":null}]} 만 출력. 새로 분류한 이슈만 한 번씩 포함하라. 다른 키를 의존으로 넣지 마라. 담당 트랙: ${JSON.stringify(tracks ?? {})}\n제공된 이슈 키: ${JSON.stringify(issues.map(row => ({ key: row.identifier, title: row.title })))}\n새로 분류한 이슈: ${JSON.stringify(classified.map(row => ({ ...row, title: byId.get(row.issue)?.title ?? '', body: byId.get(row.issue)?.body ?? '' })))}`, 'planning'));
  const plans = response.plans;
  if (!Array.isArray(plans) || plans.length !== classified.length) throw new Error('Invalid steward plan');
  const allowed = new Set(issues.length ? issues.map(row => row.identifier) : classified.map(row => row.issue));
  const planned = new Set(classified.map(row => row.issue));
  const seen = new Set<string>();
  return plans.map((raw: unknown) => {
    const row = parsed(raw);
    if (typeof row.issue !== 'string' || !planned.has(row.issue) || seen.has(row.issue) ||
      typeof row.priority !== 'number' || !Number.isFinite(row.priority) ||
      !Array.isArray(row.dependsOn) || !row.dependsOn.every((dep: unknown) => typeof dep === 'string' && allowed.has(dep) && dep !== row.issue)) throw new Error('Invalid steward plan');
    seen.add(row.issue);
    return { issue: row.issue, priority: row.priority, dependsOn: row.dependsOn as string[],
      ...(typeof row.owner === 'string' && keys.includes(row.owner) ? { owner: row.owner } : {}) };
  });
}
