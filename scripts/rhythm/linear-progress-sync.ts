import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getSecretAsync } from '../../src/nexus/config/secrets/index.js';
import { commentLinearIssue } from '../../src/connectors/linear.js';
import { listChecklist, type Checklist, type ChecklistItem } from '../../src/release-loop/checklist.js';
import { DecisionLedger, type DecisionEntry } from '../../src/decisions/decision-ledger.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { debug } from '../../src/debug/log.js';
import { acquireLockAsync } from '../../src/storage/file-lock.js';

export type ProgressIssue = {
  id: string; identifier: string; title: string; url: string; description: string; state: string;
};
export type ProgressLink = { issue: ProgressIssue; cells: ChecklistItem[]; decisions: DecisionEntry[]; sources: Array<{ cellId: string; field: string }> };
export type ProgressPreview = { identifier: string; body: string; sources: Array<{ cellId: string; field: string }> };
export type ProgressSyncResult = {
  day: string; candidates: ProgressPreview[]; posted: string[]; alreadyPresent: string[];
  skipped: string[]; failures: Array<{ identifier: string; reason: string }>;
};

const kstDay = (date: Date) => new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function exactReference(source: string, token: string): boolean {
  return new RegExp(`(^|[^A-Z0-9_-])${escapeRegExp(token)}($|[^A-Z0-9_-])`).test(source);
}

function declaredIssueRefs(source: string): string[] {
  const refs: string[] = [];
  for (const declaration of source.matchAll(/\blinear-ref\s*[:=]\s*([^\r\n]+)/gi)) {
    refs.push(...[...(declaration[1] ?? '').matchAll(/\b[A-Z]{2,8}-\d+\b/g)].map(match => match[0]!));
  }
  return [...new Set(refs)];
}

/** Only `linear-ref:` declarations in checklist fields and exact checklist IDs in issue descriptions create a link. */
export function resolveExplicitProgressLinks(issues: readonly ProgressIssue[], checklist: Checklist, decisions: readonly DecisionEntry[] = []): ProgressLink[] {
  const links: ProgressLink[] = [];
  for (const issue of issues) {
    const cells = new Map<string, ChecklistItem>();
    const sources: Array<{ cellId: string; field: string }> = [];
    for (const cell of checklist.items) {
      const declared: Array<[string, string]> = [
        ['title', cell.title], ['evidence', cell.evidence ?? ''], ['refs', (cell.refs ?? []).join('\n')],
      ];
      for (const [field, value] of declared) {
        if (declaredIssueRefs(value).includes(issue.identifier)) {
          cells.set(cell.id, cell);
          sources.push({ cellId: cell.id, field: `checklist.${field}` });
        }
      }
      if (exactReference(issue.description, cell.id)) {
        cells.set(cell.id, cell);
        sources.push({ cellId: cell.id, field: 'issue.description' });
      }
    }
    const linkedDecisions = decisions.filter(decision => decision.refs?.some(ref => ref === issue.identifier || ref === issue.url));
    for (const decision of linkedDecisions) sources.push({ cellId: decision.id, field: 'decision.refs' });
    if (cells.size || linkedDecisions.length) links.push({ issue, cells: [...cells.values()], decisions: linkedDecisions, sources });
  }
  return links;
}

function changedStatuses(checklist: Checklist, cellIds: ReadonlySet<string>, day: string): Array<{ id: string; from: string; to: string }> {
  return checklist.history.flatMap(entry => {
    if (!cellIds.has(entry.id) || entry.field !== 'status' || !entry.at || kstDay(new Date(entry.at)) !== day) return [];
    return [{ id: entry.id, from: String(entry.from ?? 'unknown'), to: String(entry.to ?? 'unknown') }];
  });
}

export function renderProgressPreview(link: ProgressLink, checklist: Checklist, day: string): ProgressPreview {
  const ids = new Set(link.cells.map(cell => cell.id));
  const transitions = changedStatuses(checklist, ids, day);
  const statusLines = link.cells.map(cell => {
    const evidence = cell.evidence ?? '';
    const simulated = cell.status === 'green' && /green\(sim\)/i.test(evidence);
    const e4Pending = simulated && /(?:설치본|installed)(?: CLI)?[^\n.]{0,24}E4[^\n.]{0,24}(?:미완|incomplete|not complete|not done)/i.test(evidence);
    return `- 연결 칸: ${cell.id} — ${simulated ? `green(sim)${e4Pending ? ' · 설치본 E4 미완' : ''}` : cell.status}`;
  });
  const transitionLines = transitions.map(change => `- 오늘 상태 변화: ${change.id} ${change.from} → ${change.to}`);
  const decisionLines = link.decisions.filter(decision => {
    const timestamp = decision.decidedAt ?? decision.withdrawnAt ?? decision.raisedAt;
    return !!timestamp && kstDay(new Date(timestamp)) === day;
  })
    .map(decision => `- 연결 결정: ${decision.id} — ${decision.status}`);
  const landedPrs = [...new Set(link.cells.flatMap(cell => {
    const text = cell.evidence ?? '';
    return [...text.matchAll(/\bPR\s*#(\d+)\b[^\n]{0,120}\bmerged\b/gi)].map(match => `#${match[1]}`);
  }))];
  const nextCell = link.cells.find(cell => cell.status !== 'green' && cell.status !== 'done');
  const simulatedCell = link.cells.find(cell => cell.status === 'green' && /green\(sim\)/i.test(cell.evidence ?? ''));
  const simulatedEvidence = simulatedCell?.evidence ?? '';
  const simulatedE4Pending = !!simulatedCell && /(?:설치본|installed)(?: CLI)?[^\n.]{0,24}E4[^\n.]{0,24}(?:미완|incomplete|not complete|not done)/i.test(simulatedEvidence);
  const next = nextCell ? `연결 칸 ${nextCell.id}의 남은 완료 경계 진행`
    : simulatedCell ? `연결 칸 ${simulatedCell.id}의 ${simulatedE4Pending ? '설치본 E4 실물 증거 확보' : '설치본 실물 증거 확인'}` : '연결된 칸은 현재 green/done';
  const body = [
    `${day} 진행 요약`,
    `- 상태: ${link.issue.state} — ${link.issue.url}`,
    ...statusLines,
    ...transitionLines,
    ...decisionLines,
    ...(landedPrs.length ? [`- 연결 착지 PR: ${landedPrs.join(', ')}`] : []),
    `- 다음: ${next}`,
    `<!-- elanous-linear-progress:${day}:${link.issue.identifier} -->`,
  ].join('\n');
  return { identifier: link.issue.identifier, body, sources: link.sources };
}

async function fetchTeamIssues(apiKey: string, teamKey: string): Promise<ProgressIssue[]> {
  const query = `query LinearProgressIssues($teamKey: String!, $after: String) {
    issues(filter: { team: { key: { eq: $teamKey } } }, first: 100, after: $after) {
      nodes { id identifier title url description state { name } }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  const issues: ProgressIssue[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  do {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { teamKey, after } }),
    });
    if (!response.ok) throw new Error(`Linear GraphQL HTTP ${response.status}`);
    const result = await response.json() as { errors?: unknown[]; data?: { issues?: { nodes?: Array<Record<string, unknown>>; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } } };
    const page = result.data?.issues;
    if (result.errors?.length || !Array.isArray(page?.nodes)) throw new Error(`Linear ${teamKey} issue query failed`);
    for (const node of page.nodes) {
      if (typeof node.id !== 'string' || typeof node.identifier !== 'string' || typeof node.title !== 'string' || typeof node.url !== 'string') continue;
      const state = node.state && typeof node.state === 'object' ? (node.state as { name?: unknown }).name : undefined;
      issues.push({ id: node.id, identifier: node.identifier, title: node.title, url: node.url,
        description: typeof node.description === 'string' ? node.description : '', state: typeof state === 'string' ? state : 'unknown' });
    }
    const info = page.pageInfo;
    if (info?.hasNextPage && (!info.endCursor || cursors.has(info.endCursor))) throw new Error(`Linear ${teamKey} cursor missing or repeated`);
    after = info?.hasNextPage ? info.endCursor : null;
    if (after) cursors.add(after);
  } while (after);
  return issues;
}

async function fetchAllowlistedIssue(apiKey: string, identifier: string): Promise<ProgressIssue | null> {
  const query = `query LinearAllowlistedProgressIssue($identifier: String!) {
    issue(id: $identifier) { id identifier title url description state { name } }
  }`;
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { identifier } }),
  });
  if (!response.ok) throw new Error(`Linear ${identifier} lookup HTTP ${response.status}`);
  const result = await response.json() as { errors?: unknown[]; data?: { issue?: Record<string, unknown> | null } };
  const node = result.data?.issue;
  if (result.errors?.length) throw new Error(`Linear ${identifier} lookup failed`);
  if (!node || typeof node.id !== 'string' || typeof node.identifier !== 'string' || typeof node.title !== 'string' || typeof node.url !== 'string') return null;
  const state = node.state && typeof node.state === 'object' ? (node.state as { name?: unknown }).name : undefined;
  return { id: node.id, identifier: node.identifier, title: node.title, url: node.url,
    description: typeof node.description === 'string' ? node.description : '', state: typeof state === 'string' ? state : 'unknown' };
}

async function countMarker(apiKey: string, issueId: string, marker: string): Promise<number> {
  const query = `query LinearProgressComments($id: String!, $after: String) {
    issue(id: $id) { comments(first: 100, after: $after) { nodes { body } pageInfo { hasNextPage endCursor } } }
  }`;
  const cursors = new Set<string>();
  let after: string | null = null;
  let count = 0;
  do {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { id: issueId, after } }),
    });
    if (!response.ok) throw new Error(`Linear comment lookup HTTP ${response.status}`);
    const result = await response.json() as { errors?: unknown[]; data?: { issue?: { comments?: { nodes?: Array<{ body?: unknown }>; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } } } };
    const comments = result.data?.issue?.comments;
    if (result.errors?.length || !Array.isArray(comments?.nodes)) throw new Error('Linear comment lookup failed');
    count += comments.nodes.filter(comment => typeof comment.body === 'string' && comment.body.includes(marker)).length;
    const info = comments.pageInfo;
    if (info?.hasNextPage && (!info.endCursor || cursors.has(info.endCursor))) throw new Error('Linear comment cursor missing or repeated');
    after = info?.hasNextPage ? info.endCursor : null;
    if (after) cursors.add(after);
  } while (after);
  return count;
}

export async function runLinearProgressSync(options: {
  version: string; now?: Date; root?: string; apply?: boolean;
  allowIssueIdentifiers?: readonly string[];
  checklist?: Checklist; issues?: readonly ProgressIssue[]; decisions?: readonly DecisionEntry[];
  getApiKey?: (id: string) => Promise<string | undefined>;
  countMarker?: (issue: ProgressIssue, marker: string) => Promise<number>;
  postComment?: (issue: ProgressIssue, body: string) => Promise<void>;
  log?: (event: string, data: Record<string, unknown>) => void;
}): Promise<ProgressSyncResult> {
  const now = options.now ?? new Date();
  const day = kstDay(now);
  const root = options.root ?? effectiveInstanceRoot();
  const checklist = options.checklist ?? listChecklist(options.version, root);
  const decisions = options.decisions ?? new DecisionLedger({ stateDir: root }).list({ status: 'all' });
  const apiKey = (options.getApiKey ?? getSecretAsync)('connector.linear.apiKey');
  const resolvedKey = await apiKey;
  if (!resolvedKey) throw new Error('connector.linear.apiKey missing');
  const allowedIdentifiers = [...new Set(options.allowIssueIdentifiers ?? [])];
  const lookupFailures: Array<{ identifier: string; reason: string }> = [];
  let issues: ProgressIssue[];
  if (options.issues) issues = [...options.issues];
  else if (options.apply) {
    const lookups = await Promise.all(allowedIdentifiers.map(async identifier => {
      try {
        const issue = await fetchAllowlistedIssue(resolvedKey, identifier);
        if (!issue) lookupFailures.push({ identifier, reason: 'allowlisted issue not found' });
        return issue;
      } catch (error) {
        lookupFailures.push({ identifier, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
        return null;
      }
    }));
    issues = lookups.filter((issue): issue is ProgressIssue => issue !== null);
  } else issues = (await Promise.all(['ELA', 'DEMO'].map(key => fetchTeamIssues(resolvedKey, key)))).flat();
  const links = resolveExplicitProgressLinks(issues, checklist, decisions);
  const previews = links.map(link => renderProgressPreview(link, checklist, day));
  const linkedIdentifiers = new Set(links.map(link => link.issue.identifier));
  const fetchedIdentifiers = new Set(issues.map(issue => issue.identifier));
  const lookupFailureIdentifiers = new Set(lookupFailures.map(failure => failure.identifier));
  const missingApproved = options.apply ? allowedIdentifiers.filter(identifier => !fetchedIdentifiers.has(identifier) && !lookupFailureIdentifiers.has(identifier))
    .map(identifier => ({ identifier, reason: 'allowlisted issue not found' })) : [];
  const unlinkedApproved = options.apply ? allowedIdentifiers.filter(identifier => issues.some(issue => issue.identifier === identifier) && !linkedIdentifiers.has(identifier))
    .map(identifier => ({ identifier, reason: 'allowlisted issue has no explicit checklist/decision link' })) : [];
  const unresolvedApproved = [...lookupFailures, ...missingApproved, ...unlinkedApproved];
  const result: ProgressSyncResult = { day, candidates: previews, posted: [], alreadyPresent: [], skipped: [], failures: unresolvedApproved };
  const log = (event: string, data: Record<string, unknown>) => {
    const enriched = { day, ...data };
    if (options.log) options.log(event, enriched);
    else debug.log('loop.rhythm-daily.linear-progress', event, enriched);
  };
  const check = options.countMarker ?? ((issue: ProgressIssue, marker: string) => countMarker(resolvedKey, issue.id, marker));
  const post = options.postComment ?? ((issue: ProgressIssue, body: string) => commentLinearIssue({ apiKey: resolvedKey, issueId: issue.id, body }));
  for (const failure of unresolvedApproved) log('approved-issue-unresolved', failure);
  for (const preview of previews) {
    const issue = links.find(link => link.issue.identifier === preview.identifier)!.issue;
    const marker = `<!-- elanous-linear-progress:${day}:${issue.identifier} -->`;
    let release: (() => void) | undefined;
    let stillHeld: (() => boolean) | undefined;
    try {
      if (options.apply && !options.allowIssueIdentifiers?.includes(issue.identifier)) {
        result.skipped.push(issue.identifier);
        log('not-approved', { identifier: issue.identifier, sources: preview.sources });
        continue;
      }
      if (options.apply) {
        const lockDir = join(root, 'rhythm', 'linear-progress-sync');
        mkdirSync(lockDir, { recursive: true, mode: 0o700 });
        const lockName = createHash('sha256').update(`${day}:${issue.id}`).digest('hex');
        const lock = await acquireLockAsync(join(lockDir, `${lockName}.lock`), { staleMs: 120_000, maxTries: 240 });
        release = lock.release;
        stillHeld = lock.stillHeld;
        if (!stillHeld()) throw new Error('Linear progress lock lost before marker check');
      }
      const existing = await check(issue, marker);
      if (existing > 1) {
        result.failures.push({ identifier: issue.identifier, reason: `duplicate-marker-count=${existing}` });
        log('duplicate-marker', { identifier: issue.identifier, markerCount: existing, sources: preview.sources });
        continue;
      }
      if (existing === 1) {
        result.alreadyPresent.push(issue.identifier);
        log('already-present', { identifier: issue.identifier, markerCount: 1, sources: preview.sources });
        continue;
      }
      if (!options.apply) {
        result.skipped.push(issue.identifier);
        log('dry-run', { identifier: issue.identifier, markerCount: 0, sources: preview.sources });
        continue;
      }
      if (!release || !stillHeld?.()) throw new Error('Linear progress write lock unavailable or lost');
      await post(issue, preview.body);
      const verified = await check(issue, marker);
      if (verified !== 1) throw new Error(`post-verification-marker-count=${verified}`);
      result.posted.push(issue.identifier);
      log('posted', { identifier: issue.identifier, markerCount: verified, sources: preview.sources });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result.failures.push({ identifier: issue.identifier, reason: reason.slice(0, 200) });
      log('failed', { identifier: issue.identifier, reason: reason.slice(0, 200), sources: preview.sources });
    } finally {
      release?.();
    }
  }
  return result;
}

if (import.meta.main) {
  const version = process.argv.find((arg, index) => process.argv[index - 1] === '--version');
  if (!version) throw new Error('--version required');
  if (process.argv.includes('--apply')) throw new Error('live posting requires the approved scheduled daily path');
  const result = await runLinearProgressSync({ version, apply: false });
  console.log(JSON.stringify(result));
}
