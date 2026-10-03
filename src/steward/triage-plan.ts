import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveRoleModel } from '../user-config.js';
import type { HitlReason, Rung, TriageIssue } from './triage.js';

export type StewardAsk = (prompt: string, role: 'classify' | 'planning') => Promise<unknown>;
export interface ClassifiedIssue { issue: string; rung: Rung; why: string; hitlReason?: HitlReason; duplicateOf?: string; capability?: 'new-capability' | 'existing-capability' }
export interface CapabilityInventory { graphs: readonly string[]; plugins: readonly string[]; commands: readonly string[] }

/** Read installed names, not promises in documentation. The caller can supply a test-instance root. */
export function installedCapabilities(root: string = resolve(import.meta.dir, '../..')): CapabilityInventory {
  const files = (dir: string): string[] => {
    try { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? files(join(dir, entry.name)) : entry.isFile() && /\.ya?ml$/.test(entry.name) ? [join(dir, entry.name)] : []); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const graphs = files(join(root, 'graphs')).flatMap(file => {
    const match = /^graph_id:\s*['"]?([^\s'"#]+)/m.exec(readFileSync(file, 'utf8'));
    return match ? [match[1]!] : [];
  });
  let plugins: string[];
  try { plugins = readdirSync(join(root, 'plugins'), { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== 'examples').map(entry => entry.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; plugins = []; }
  const help = spawnSync(process.execPath, [join(root, 'bin/elanous.mjs'), '--test', '--help'], { cwd: root, encoding: 'utf8', timeout: 15_000 });
  // An unconfigured test instance cannot start the CLI. Unknown commands must not be treated as installed.
  const commands = help.status === 0
    ? [...help.stdout.matchAll(/^\s{2}(?!-)([\w:-]+)(?:\s|$)/gm)].map(match => match[1]!) : [];
  return { graphs, plugins, commands };
}
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

export async function classifyIssue(issue: TriageIssue, ask: StewardAsk = askSteward, inventory: CapabilityInventory = installedCapabilities()): Promise<ClassifiedIssue> {
  const candidate = unsafeReason(issue);
  const response = parsed(await ask(`스튜어드 분류. JSON 객체만: {"rung":0|1|2|3|4|5|"hitl","hitlReason":null,"why":"한 문장","capability":"new-capability"|"existing-capability"}. 0=이미됨, 1=셸, 2=CLI, 3=조사, 4=하니스 골, 5=외부 에이전트. 돈·공개·보안·비가역은 hitl; 그 외 사람 확인은 other. 새 능력인지 기존 그래프·플러그인·명령으로 되는 일인지 판정하라. 존재만으로 그 기능이 소원을 충족한다고 추측하지 마라. 확인되지 않은 완료를 추측하지 마라. ${candidate ? `안전 후보 ${candidate}: 이유를 확인하라.` : ''}\n설치된 능력: ${JSON.stringify(inventory)}\n이슈: ${JSON.stringify(issue)}`, 'classify'));
  if (![0, 1, 2, 3, 4, 5, 'hitl'].includes(response.rung as Rung) || typeof response.why !== 'string' || !response.why.trim()) throw new Error(`Invalid steward classification: ${issue.identifier}`);
  const reason = candidate ?? (unsafe.some(([name]) => name === response.hitlReason) ? response.hitlReason as HitlReason : undefined)
    ?? (response.rung === 'hitl' ? 'other' : undefined);
  // A missing or unknown verdict does not block triage; working-backwards drafting is simply skipped for that issue.
  const capability = response.capability === 'new-capability' || response.capability === 'existing-capability' ? response.capability : undefined;
  return { issue: issue.identifier, rung: reason ? 'hitl' : response.rung as Rung,
    ...(reason ? { hitlReason: reason } : {}), why: response.why.trim().replace(/\s+/g, ' '),
    ...(capability ? { capability } : {}) };
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
