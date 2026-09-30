import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchLinearIssues } from '../connectors/linear.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { getUserConfig } from '../user-config.js';
import { emitDecision } from '../live/detail-switch.js';
import { debug, redactSecretText } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { redactSecrets } from '../task-cards/card-store.js';
import { directiveHash } from './directive.js';
import { recordTriageOnCards, type StewardCardDeps } from './steward-cards.js';

export type Rung = 0 | 1 | 2 | 3 | 4 | 5 | 'hitl';
/** `other` = the judge chose human review for a reason outside the four named ones (kept as HITL, never downgraded). */
export type HitlReason = 'money' | 'public' | 'security' | 'irreversible' | 'other';
export interface TriageIssue { identifier: string; ref: string; title: string; body: string }
export interface TriageDecision {
  issue: string; rung: Rung; dependsOn: string[]; priority: number; duplicateOf?: string;
  hitlReason?: HitlReason; why: string; role?: string; cost?: number;
  /** Owner track from `loops.steward.tracks` (absent when no table is configured or the judge picked none of its keys). */
  owner?: string;
}
export interface ScheduledDecision extends TriageDecision { disposition: 'now' | 'wait' | 'hitl' }
export interface StewardSettings {
  mode?: 'observe' | 'act'; linearTeam?: string;
  roles?: Record<string, { maxConcurrent?: number }>;
  budget?: number;
  tracks?: Record<string, string>;
}
export interface StewardDeps {
  fetch?: typeof fetch;
  getSecret?: (id: string) => Promise<string | undefined>;
  judge?: (issue: TriageIssue, issues: TriageIssue[], tracks?: Record<string, string>) => Promise<unknown>;
  decide?: typeof emitDecision;
  sendDigest?: (text: string) => Promise<void>;
  now?: () => Date;
  root?: string;
  cardStore?: StewardCardDeps['store'];
  warn?: (message: string) => void;
}

export function stewardSettings(): StewardSettings {
  return getUserConfig().loops?.steward ?? {};
}

const unsafe: Array<[HitlReason, RegExp]> = [
  ['money', /돈|유료|결제|구매|판매|송금|환불|크레딧\s*(?:추가|구매)|paid|payment|purchase/i],
  ['public', /공개|발행|외부\s*게시|publish|public\s*release/i],
  ['security', /보안|(?:키|자격|권한|secret|credential|permission)\s*(?:변경|교체|발급|삭제|공유|노출)|키체인/i],
  ['irreversible', /비가역|강제\s*푸시|force.push|영구\s*삭제|리셋권\s*소비|drop\s*table|초기화/i],
];

function parseJudgment(issue: TriageIssue, raw: unknown, tracks?: Record<string, string>): TriageDecision {
  const value = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid triage judgment: ${issue.identifier}`);
  const d = value as Record<string, unknown>;
  if (![0, 1, 2, 3, 4, 5, 'hitl'].includes(d.rung as Rung) ||
      !Array.isArray(d.dependsOn) || !d.dependsOn.every(v => typeof v === 'string') ||
      typeof d.priority !== 'number' || !Number.isFinite(d.priority) || typeof d.why !== 'string' || !d.why.trim()) {
    throw new Error(`Invalid triage judgment: ${issue.identifier}`);
  }
  const forced = unsafe.find(([, pattern]) => pattern.test(`${issue.title}\n${issue.body}`))?.[0];
  const named = forced ?? (unsafe.some(([reason]) => reason === d.hitlReason) ? d.hitlReason as HitlReason : undefined);
  // A HITL judgment without one of the four named reasons stays HITL (`other`) — one issue must not stop the stage.
  const hitlReason = named ?? (d.rung === 'hitl' ? 'other' as const : undefined);
  return {
    issue: issue.identifier, rung: hitlReason ? 'hitl' : d.rung as Rung,
    dependsOn: d.dependsOn as string[], priority: d.priority as number,
    ...(typeof d.duplicateOf === 'string' ? { duplicateOf: d.duplicateOf } : {}),
    ...(hitlReason ? { hitlReason } : {}), why: (d.why as string).trim().replace(/\s+/g, ' '),
    ...(typeof d.role === 'string' ? { role: d.role } : {}),
    ...(typeof d.cost === 'number' && Number.isFinite(d.cost) && d.cost >= 0 ? { cost: d.cost } : {}),
    ...(tracks && typeof d.owner === 'string' && Object.hasOwn(tracks, d.owner) ? { owner: d.owner } : {}),
  };
}

/** The role table as prompt lines — read from config so a reorg edits one place. */
export function trackTablePrompt(tracks?: Record<string, string>): string {
  if (!tracks || !Object.keys(tracks).length) return '';
  const keys = Object.keys(tracks);
  return `\n담당 트랙(owner) — 아래 중 하나(${keys.map(k => JSON.stringify(k)).join('|')}) · 이슈가 어느 트랙 일인지:\n${keys.map(k => `- ${k}: ${tracks[k]}`).join('\n')}`;
}

async function judgeStewardIssue(issue: TriageIssue, issues: TriageIssue[], tracks?: Record<string, string>): Promise<unknown> {
  const ownerField = tracks && Object.keys(tracks).length ? `,"owner":${JSON.stringify(Object.keys(tracks)[0])}` : '';
  const prompt = `스튜어드 트리아지. JSON 객체만 출력: {"rung":0|1|2|3|4|5|"hitl","dependsOn":[],"priority":1,"duplicateOf":null,"hitlReason":null,"why":"한 문장","role":"builder","cost":0${ownerField}}.\n0=이미됨/중복, 1=셸, 2=CLI, 3=조사, 4=하니스 골, 5=외부 에이전트. 돈·공개·보안·비가역은 hitl(hitlReason = "money"|"public"|"security"|"irreversible" · 그 밖의 이유로 사람 확인이 필요하면 "other"). 확인되지 않은 완료/중복은 추측하지 마라. 의존은 제공된 이슈 키만 써라.${trackTablePrompt(tracks)}\n이슈 목록: ${JSON.stringify(issues.map(i => ({ key: i.identifier, title: i.title })))}\n판정 대상: ${JSON.stringify(issue)}`;
  const { streamLLM } = await import('../llm.js');
  const { tierModel } = await import('../llm/model-defaults.js');
  const result = await streamLLM([{ role: 'user', content: prompt }], () => {}, { model: tierModel('best') });
  return JSON.parse(result.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()) as unknown;
}

export async function triageIssues(issues: TriageIssue[], judge: NonNullable<StewardDeps['judge']> = judgeStewardIssue, decide: typeof emitDecision = emitDecision, tracks?: Record<string, string>): Promise<TriageDecision[]> {
  const decisions: TriageDecision[] = [];
  for (const issue of issues) {
    let result: TriageDecision;
    try {
      result = parseJudgment(issue, await judge(issue, issues, tracks), tracks);
    } catch (error) {
      // A malformed or failed judgment for one issue goes to a human; the other issues are still triaged.
      try { debug.log('steward.stage', 'judgment-invalid', { issue: issue.identifier, reason: redactSecrets(String(error)) }); } catch { /* fail-soft */ }
      result = { issue: issue.identifier, rung: 'hitl', hitlReason: 'other', dependsOn: [], priority: 0, why: 'triage judgment unavailable — human review' };
    }
    decisions.push(result);
    decide({ kind: result.rung === 'hitl' ? 'ESCALATE' : 'ROUTE', what: issue.identifier, reason: result.why,
      purpose: 'steward triage', target: result.owner ? `${result.rung} · ${result.owner}` : String(result.rung), refs: { issue: issue.identifier } });
  }
  return decisions;
}

/** Stable priority-ordered topological schedule; missing/cyclic dependencies wait, never auto-approve. */
export function scheduleTriage(decisions: TriageDecision[], settings: StewardSettings = {}, running: Record<string, number> = {}, completed: ReadonlySet<string> = new Set()): ScheduledDecision[] {
  const byId = new Map(decisions.map(d => [d.issue, d]));
  if (byId.size !== decisions.length) throw new Error('Duplicate issue identifier');
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: TriageDecision[] = [];
  const visit = (item: TriageDecision): void => {
    if (visited.has(item.issue) || visiting.has(item.issue)) return;
    visiting.add(item.issue);
    for (const dep of item.dependsOn) { const upstream = byId.get(dep); if (upstream) visit(upstream); }
    visiting.delete(item.issue); visited.add(item.issue); sorted.push(item);
  };
  for (const item of [...decisions].sort((a, b) => a.priority - b.priority || a.issue.localeCompare(b.issue))) visit(item);
  const slots = { ...running };
  let remaining = settings.budget ?? Infinity;
  return sorted.map(item => {
    const role = item.owner ?? item.role ?? String(item.rung);
    const max = settings.roles?.[role]?.maxConcurrent ?? Infinity;
    const blocked = item.dependsOn.some(dep => !completed.has(dep));
    const status: ScheduledDecision['disposition'] = item.rung === 'hitl' || item.hitlReason ? 'hitl' :
      item.rung === 0 || item.duplicateOf || blocked || (slots[role] ?? 0) >= max || (item.cost ?? 0) > remaining ? 'wait' : 'now';
    if (status === 'now') { slots[role] = (slots[role] ?? 0) + 1; remaining -= item.cost ?? 0; }
    return { ...item, disposition: status };
  });
}

async function linear<T>(key: string, query: string, variables: Record<string, unknown>, fetchFn: typeof fetch): Promise<T> {
  let response: Response;
  try { response = await fetchFn('https://api.linear.app/graphql', { method: 'POST', headers: { Authorization: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) }); }
  catch { throw new Error('Linear GraphQL request failed'); }
  if (!response.ok) throw new Error(`Linear GraphQL HTTP ${response.status}`);
  let body: { data?: T; errors?: unknown[] };
  try { body = await response.json() as typeof body; }
  catch { throw new Error('Linear GraphQL invalid JSON response'); }
  if (body.errors?.length || !body.data) throw new Error('Linear GraphQL returned errors or missing data');
  return body.data;
}

function reportPath(root: string): string { return join(root, 'steward', 'observe.json'); }
function readState(path: string): { issues: Record<string, string>; digestDay?: string } {
  try { return JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof readState>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { issues: {} }; throw error; }
}

/** Each command node invokes one stage. No stage can spawn, launch, merge or approve. */
export async function runStewardStage(stage: 'sync' | 'triage' | 'schedule' | 'report', deps: StewardDeps = {}): Promise<void> {
  const settings = stewardSettings();
  if ((settings.mode ?? 'observe') !== 'observe') throw new Error('steward act mode is out of scope');
  const key = await (deps.getSecret ?? getSecretAsync)('connector.linear.apiKey');
  if (!key) throw new Error('connector.linear.apiKey missing');
  const root = deps.root ?? effectiveInstanceRoot();
  const dir = join(root, 'steward');
  mkdirSync(dir, { recursive: true });
  const snapshot = join(dir, 'issues.json');
  const judgments = join(dir, 'triage.json');
  const schedule = join(dir, 'schedule.json');
  const fetchFn = deps.fetch ?? fetch;
  if (stage === 'sync') {
    const events = await fetchLinearIssues({ apiKey: key, teamKey: settings.linearTeam ?? 'ELA', fetch: fetchFn });
    writeFileSync(snapshot, JSON.stringify(events.map(e => ({ identifier: e.identifier, ref: e.ref, title: e.title, body: e.body }))));
  } else if (stage === 'triage') {
    const issues = JSON.parse(readFileSync(snapshot, 'utf8')) as TriageIssue[];
    const judge = deps.judge ?? judgeStewardIssue;
    writeFileSync(judgments, JSON.stringify(await triageIssues(issues, judge, deps.decide, settings.tracks)));
  } else if (stage === 'schedule') {
    const decisions = JSON.parse(readFileSync(judgments, 'utf8')) as TriageDecision[];
    const pending = new Set(decisions.flatMap(decision => decision.dependsOn));
    const completed = new Set<string>();
    for (const identifier of pending) {
      const data = await linear<{ issue: { identifier: string; state?: { type: string } } | null }>(key,
        'query($id:String!){issue(id:$id){identifier state{type}}}', { id: identifier }, fetchFn);
      if (data.issue?.identifier === identifier && data.issue.state?.type === 'completed') completed.add(identifier);
    }
    writeFileSync(schedule, JSON.stringify(scheduleTriage(decisions, settings, {}, completed)));
  } else {
    const rows = JSON.parse(readFileSync(schedule, 'utf8')) as ScheduledDecision[];
    const path = reportPath(root);
    const state = readState(path);
    const at = (deps.now ?? (() => new Date()))().toISOString();
    const issues = JSON.parse(readFileSync(snapshot, 'utf8')) as TriageIssue[];
    try {
      recordTriageOnCards(rows, issues, { root, store: deps.cardStore, now: deps.now });
    } catch (error) {
      const message = `steward report: card write failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`;
      debug.log('steward.cards', 'write-failed', { error: message });
      (deps.warn ?? console.warn)(message);
    }
    for (const row of rows) {
      const issue = issues.find(item => item.identifier === row.issue);
      if (!issue) throw new Error(`Missing issue ${row.issue}`);
      const body = `스튜어드 observe · ${row.disposition} · rung ${row.rung} · 우선순위 ${row.priority} · 의존 ${row.dependsOn.join(', ') || '없음'}${row.duplicateOf ? ` · 중복 ${row.duplicateOf}` : ''} · ${row.why}${row.hitlReason ? ` · HITL ${row.hitlReason}` : ''}`;
      const hash = directiveHash(body);
      if (state.issues[row.issue] === hash) continue;
      const result = await linear<{ commentCreate: { success: boolean } }>(key, 'mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}', { input: { issueId: issue.ref, body } }, fetchFn);
      if (!result.commentCreate?.success) throw new Error(`Linear comment failed: ${row.issue}`);
      state.issues[row.issue] = hash;
      writeFileSync(path, JSON.stringify(state));
    }
    const day = at.slice(0, 10);
    if (state.digestDay !== day) {
      const send = deps.sendDigest ?? sendStewardDigest;
      await send(`스튜어드 ${day}: ${rows.map(row => `${row.issue} ${row.disposition}`).join(' · ')}`);
      state.digestDay = day;
      writeFileSync(path, JSON.stringify(state));
    }
  }
}

async function sendStewardDigest(text: string): Promise<void> {
  const { deliver } = await import('../domains/outbound-alert.js');
  if (!deliver(text, 'digest')) throw new Error('steward digest delivery failed');
}

if (import.meta.main) {
  const stage = process.argv[2];
  if (!['sync', 'triage', 'schedule', 'report'].includes(stage ?? '')) {
    console.error('steward: expected sync|triage|schedule|report');
    process.exitCode = 2;
  } else {
    runStewardStage(stage as 'sync' | 'triage' | 'schedule' | 'report').catch((error: unknown) => {
      // Say why (secrets masked) — 09-29 the first resident run failed as a bare «stage failed» on a missing Linear key.
      const reason = redactSecretText(error instanceof Error ? error.message : String(error)).slice(0, 300);
      console.error(`steward ${stage}: stage failed — ${reason}`);
      debug.log('steward.stage', 'failed', { stage, reason });
      process.exitCode = 1;
    });
  }
}
