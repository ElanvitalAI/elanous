import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { debug } from '../debug/log.js';
import { listChecklist, checklistHistory, checklistDevVersion, type Checklist, type ChecklistHistory } from '../release-loop/checklist.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { commentLinearIssue } from './linear.js';

const ISSUE_REF = /\bELA-\d+\b/g;
const BODY_MARKER = '<!-- elanous-daily-progress:';
const WAIT = new Int32Array(new SharedArrayBuffer(4));

export interface LinearDailyProgressSummary {
  identifier: string;
  day: string;
  body: string;
  contentHash: string;
}
export interface LinearDailyProgressResult {
  posted: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  plan: Array<{ identifier: string; day: string; contentHash: string; body: string; status: 'dry-run' | 'posted' | 'duplicate' | 'failed' }>;
}
export interface LinearDailyProgressDeps {
  version?: string;
  checklist?: Checklist;
  history?: (id: string) => ChecklistHistory[];
  decisions?: DecisionEntry[];
  now?: Date;
  apiKey?: string;
  getSecret?: (id: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  stateDir?: string;
  dryRun?: boolean;
  log?: typeof debug.log;
}

function refsIn(...values: unknown[]): string[] {
  const found = new Set<string>();
  for (const value of values) {
    const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
    for (const match of text.matchAll(ISSUE_REF)) found.add(match[0]);
  }
  return [...found];
}

function cleanTitle(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function prLinks(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...new Set(value.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+|\bPR\s*#\d+\b/gi) ?? [])];
}

/** Build public-safe daily summaries from checklist and decision ledgers. Bodies contain titles, states and links only. */
export function buildLinearDailyProgressSummaries({ checklist, history = checklistHistory, decisions, now = new Date() }: {
  checklist?: Checklist; history?: (id: string) => ChecklistHistory[]; decisions: DecisionEntry[]; now?: Date;
}): LinearDailyProgressSummary[] {
  if (!checklist) throw new Error('checklist snapshot is required');
  if (!Number.isFinite(now.getTime())) throw new Error('valid summary date is required');
  const day = now.toISOString().slice(0, 10);
  const start = Date.parse(`${day}T00:00:00.000Z`);
  const end = start + 86_400_000;
  const issueIds = new Set<string>();
  const itemRefs = new Map<string, Set<string>>();
  const changed = new Map<string, ChecklistHistory[]>();
  for (const item of checklist.items) {
    const events = history(item.id);
    const refs = new Set(refsIn(item.id, item.title, item.evidence, item.refs, ...events.flatMap(event => [event.from, event.to])));
    itemRefs.set(item.id, refs);
    refs.forEach(id => issueIds.add(id));
    const today = events.filter(event => {
      const at = Date.parse(event.at);
      return Number.isFinite(at) && at >= start && at < end && ['status', 'evidence', 'title', 'move'].includes(event.field);
    });
    if (today.length) changed.set(item.id, today);
  }
  const decisionRefs = new Map<string, string[]>();
  for (const decision of decisions) {
    const refs = refsIn(decision.refs);
    decisionRefs.set(decision.id, refs);
    refs.forEach(id => issueIds.add(id));
  }
  const summaries: LinearDailyProgressSummary[] = [];
  for (const identifier of [...issueIds].sort()) {
    const lines = [`elanous 진행 요약 · ${day}`];
    const changes: string[] = [];
    for (const item of checklist.items) {
      if (!itemRefs.get(item.id)?.has(identifier)) continue;
      const events = changed.get(item.id) ?? [];
      if (!events.length) continue;
      const status = events.filter(event => event.field === 'status').at(-1);
      const value = status ? `${String(status.from ?? '미상')} → ${String(status.to ?? '미상')}`
        : events.some(event => event.field === 'evidence') ? '근거 갱신'
          : events.some(event => event.field === 'title') ? '제목 변경' : '칸 이동';
      changes.push(`- 칸 ${item.id}: ${cleanTitle(item.title)} · ${value}`);
      const landedToday = events.some(event => event.field === 'status' && (event.to === 'green' || event.to === 'done'));
      for (const event of events.filter(event => event.field === 'evidence' && landedToday)) {
        for (const link of prLinks(event.to)) changes.push(`  착지 PR: ${link}`);
      }
    }
    lines.push('칸 변화');
    lines.push(...(changes.length ? [...new Set(changes)] : ['- 오늘 기록된 칸 변화 없음']));
    const issueDecisions = decisions.filter(decision => decisionRefs.get(decision.id)?.includes(identifier) &&
      (decision.history.some(event => event.at && Date.parse(event.at) >= start && Date.parse(event.at) < end) ||
        (decision.decidedAt && Date.parse(decision.decidedAt) >= start && Date.parse(decision.decidedAt) < end)));
    lines.push('결정');
    lines.push(...(issueDecisions.length ? issueDecisions.map(decision => `- ${cleanTitle(decision.title)} · ${decision.status}`) : ['- 오늘 기록된 결정 없음']));
    const next = checklist.items.filter(item => item.status !== 'green' && item.status !== 'done' && itemRefs.get(item.id)?.has(identifier));
    lines.push('다음 할 일');
    lines.push(...(next.length ? next.slice(0, 8).map(item => `- ${item.id}: ${cleanTitle(item.title)}`) : ['- 연결된 미완료 칸 없음']));
    const content = lines.join('\n');
    const contentHash = createHash('sha256').update(content).digest('hex');
    summaries.push({ identifier, day, body: `${content}\n\n${BODY_MARKER}${day} -->`, contentHash });
  }
  return summaries;
}

async function findIssueAndDuplicate({ apiKey, identifier, day, body, fetch: fetchFn }: { apiKey: string; identifier: string; day: string; body: string; fetch: typeof fetch }): Promise<{ issueId: string; duplicate: boolean }> {
  // Linear's GraphQL quickstart explicitly queries issue(id: "BLA-123"): https://linear.app/developers/graphql
  const query = `query DailyProgressIssue($identifier: String!, $after: String) {
    issue(id: $identifier) { id comments(first: 100, after: $after) { nodes { body } pageInfo { hasNextPage endCursor } } }
  }`;
  let after: string | null = null;
  const cursors = new Set<string>();
  let issueId: string | undefined;
  let duplicate = false;
  do {
    let response: Response;
    try {
      response = await fetchFn('https://api.linear.app/graphql', { method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { identifier, after } }) });
    } catch { throw new Error('linear-request-failed'); }
    if (!response.ok) throw new Error(`linear-http-${response.status}`);
    let result: { data?: { issue?: { id?: string; comments?: { nodes?: Array<{ body?: string }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } | null } }; errors?: unknown[] };
    try { result = await response.json() as typeof result; } catch { throw new Error('linear-invalid-json'); }
    if (result.errors?.length || !result.data?.issue?.id) throw new Error('linear-issue-not-found-or-query-failed');
    issueId = result.data.issue.id;
    const comments = result.data.issue.comments;
    if (comments?.nodes?.some(comment => comment.body?.includes(`${BODY_MARKER}${day} -->`))) duplicate = true;
    const page = comments?.pageInfo;
    if (page?.hasNextPage && (!page.endCursor || cursors.has(page.endCursor))) throw new Error('linear-comment-pagination-invalid');
    after = page?.hasNextPage ? page.endCursor! : null;
    if (after) cursors.add(after);
  } while (after && !duplicate);
  return { issueId, duplicate };
}

function withDailyLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  const path = join(stateDir, 'linear-daily-progress', 'send.lock');
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + 30_000;
  let fd: number | undefined;
  for (;;) {
    try {
      fd = openSync(path, 'wx', 0o600);
      try { writeSync(fd, `${process.pid}`); }
      catch (error) { closeSync(fd); fd = undefined; unlinkSync(path); throw error; }
      break;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const pid = Number(readFileSync(path, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0 && Date.now() - statSync(path).mtimeMs > 30_000) {
          try { process.kill(pid, 0); } catch (inner) { if ((inner as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(path); continue; } }
        }
      } catch (inner) { if ((inner as NodeJS.ErrnoException).code === 'ENOENT') continue; }
      if (Date.now() >= deadline) throw new Error('linear daily progress lock timeout');
      Atomics.wait(WAIT, 0, 0, 25);
    }
  }
  return fn().finally(() => {
    if (fd === undefined) return;
    try { closeSync(fd); }
    finally {
      try { unlinkSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  });
}

/** Dry-run by default at the CLI; live delivery checks Linear first so a retry after a crash cannot duplicate a comment. */
export async function syncLinearDailyProgress(deps: LinearDailyProgressDeps = {}): Promise<LinearDailyProgressResult> {
  const checklist = deps.checklist ?? listChecklist(deps.version ?? checklistDevVersion());
  const decisions = deps.decisions ?? new DecisionLedger({ stateDir: deps.stateDir }).list({ status: 'all' });
  const summaries = buildLinearDailyProgressSummaries({ checklist, history: deps.history ?? checklistHistory, decisions, now: deps.now });
  const result: LinearDailyProgressResult = { posted: 0, skipped: 0, failed: 0, dryRun: deps.dryRun !== false, plan: [] };
  if (!summaries.length) return result;
  const log = deps.log ?? debug.log.bind(debug);
  const stateDir = deps.stateDir ?? elanousStateRoot();
  if (result.dryRun) {
    result.plan = summaries.map(({ identifier, day, contentHash, body }) => ({ identifier, day, contentHash, body, status: 'dry-run' }));
    return result;
  }
  const apiKey = deps.apiKey ?? await (deps.getSecret ?? getSecretAsync)('connector.linear.apiKey');
  if (!apiKey) throw new Error('connector.linear.apiKey missing');
  return withDailyLock(stateDir, async () => {
    for (const summary of summaries) {
      const fields = { traceId: randomUUID(), identifier: summary.identifier, day: summary.day, contentHash: summary.contentHash };
      try {
        const issue = await findIssueAndDuplicate({ apiKey, identifier: summary.identifier, day: summary.day, body: summary.body, fetch: deps.fetch ?? fetch });
        if (issue.duplicate) {
          result.skipped++;
          result.plan.push({ identifier: summary.identifier, day: summary.day, contentHash: summary.contentHash, body: summary.body, status: 'duplicate' });
          log('connector.linear.daily-progress', 'skipped', { ...fields, reason: 'duplicate-content' });
          continue;
        }
        await commentLinearIssue({ apiKey, issueId: issue.issueId, body: summary.body, fetch: deps.fetch ?? fetch });
        result.posted++;
        result.plan.push({ identifier: summary.identifier, day: summary.day, contentHash: summary.contentHash, body: summary.body, status: 'posted' });
        log('connector.linear.daily-progress', 'posted', fields);
      } catch (error) {
        result.failed++;
        result.plan.push({ identifier: summary.identifier, day: summary.day, contentHash: summary.contentHash, body: summary.body, status: 'failed' });
        const reason = error instanceof Error && /^linear-(?:request-failed|http-\d{3}|invalid-json|issue-not-found-or-query-failed|comment-pagination-invalid)$/.test(error.message)
          ? error.message : 'linear-operation-failed';
        log('connector.linear.daily-progress', 'failed', { ...fields, reason });
      }
    }
    return result;
  });
}
