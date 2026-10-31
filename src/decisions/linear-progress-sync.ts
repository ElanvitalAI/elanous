import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { commentLinearIssue } from '../connectors/linear.js';
import { debug } from '../debug/log.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { DecisionLedger } from './decision-ledger.js';
import { buildLinearProgressSummaries, type LinearProgressSummary } from './linear-progress-summary.js';
import { checklistHistory, listChecklist } from '../release-loop/checklist.js';

type SentState = Record<string, true>;
type IssueLookup = { issue?: { id?: string; team?: { key?: string }; comments?: { nodes?: Array<{ body?: string }> } } };

export interface LinearProgressSyncResult {
  day: string;
  planned: number;
  posted: number;
  skipped: number;
  failed: number;
  plan: Array<{ issue: string; body: string; action: 'post' | 'already-posted' | 'team-mismatch' }>;
}

function readState(path: string): SentState {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const invalid = !value || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([key, row]) => !/^\d{4}-\d{2}-\d{2}:ELA-[A-Z0-9]+$/.test(key)
      || (row !== true && (!row || typeof row !== 'object' || Array.isArray(row))));
  if (invalid) {
    throw new Error('invalid Linear progress sync state');
  }
  // Older entries stored write-only fingerprint/postedAt metadata. Normalize them to the marker that skip logic reads.
  return Object.fromEntries(Object.keys(value).map(key => [key, true]));
}

function saveState(path: string, state: SentState): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, path);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

async function lookupIssue(apiKey: string, identifier: string, fetchFn: typeof fetch): Promise<IssueLookup['issue']> {
  const response = await fetchFn('https://api.linear.app/graphql', {
    method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query ProgressIssue($id: String!) { issue(id: $id) { id team { key } comments(first: 100) { nodes { body } } } }', variables: { id: identifier } }),
  });
  if (!response.ok) throw new Error(`Linear GraphQL HTTP ${response.status}`);
  const body = await response.json() as { data?: IssueLookup; errors?: unknown[] };
  if (body.errors?.length || !body.data) throw new Error('Linear GraphQL issue lookup failed');
  return body.data.issue;
}

function marker(summary: LinearProgressSummary): string { return `progress-sync:${summary.day}:${summary.issue}`; }

function summaries(version: string, now: Date): LinearProgressSummary[] {
  const checklist = listChecklist(version);
  const history = [...new Set(checklist.items.map(item => item.id))].flatMap(id => checklistHistory(id));
  const since = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  return buildLinearProgressSummaries({ checklist, history, decisions: new DecisionLedger().list({ status: 'all' }), since, now });
}

/** Plan is read-only by default. `live` sends at most one marked comment per issue per UTC day. */
export async function syncLinearProgress(options: {
  version: string;
  live?: boolean;
  now?: Date;
  fetch?: typeof fetch;
  getSecret?: (name: string) => Promise<string | undefined>;
  ledgerRoot?: string;
  /** Injection seam for deterministic sync tests; normal callers use the local ledgers. */
  buildSummaries?: (version: string, now: Date) => LinearProgressSummary[];
}): Promise<LinearProgressSyncResult> {
  const now = options.now ?? new Date();
  const plans = (options.buildSummaries ?? summaries)(options.version, now);
  const result: LinearProgressSyncResult = { day: now.toISOString().slice(0, 10), planned: plans.length, posted: 0, skipped: 0, failed: 0,
    plan: plans.map(summary => ({ issue: summary.issue, body: summary.body, action: 'post' })) };
  if (!options.live) {
    for (const item of result.plan) debug.log('linear.progress-sync', 'planned', { issue: item.issue, day: result.day });
    return result;
  }

  const apiKey = await (options.getSecret ?? getSecretAsync)('connector.linear.apiKey');
  if (!apiKey) throw new Error('Linear credential missing');
  const ledgerRoot = options.ledgerRoot ?? releaseLedgerRoot();
  const directory = join(ledgerRoot, 'release');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'linear-progress-sync.json');
  const lockPath = `${path}.lock`;
  let lock: number | undefined;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { lock = openSync(lockPath, 'wx', 0o600); writeSync(lock, `${process.pid}`); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const pid = Number(readFileSync(lockPath, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0 && Date.now() - statSync(lockPath).mtimeMs > 30_000) {
          try { process.kill(pid, 0); }
          catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(lockPath); continue; } }
        }
      } catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ENOENT') continue; }
      if (Date.now() >= deadline) throw new Error('Linear progress sync lock timeout');
      await Bun.sleep(25);
    }
  }
  try {
    const state = readState(path);
    const fetchFn = options.fetch ?? fetch;
    for (const summary of plans) {
      const key = `${summary.day}:${summary.issue}`;
      if (state[key]) {
        result.skipped++;
        result.plan.find(item => item.issue === summary.issue)!.action = 'already-posted';
        debug.log('linear.progress-sync', 'skipped', { issue: summary.issue, day: summary.day, reason: 'already-posted' });
        continue;
      }
      try {
        const issue = await lookupIssue(apiKey, summary.issue, fetchFn);
        if (!issue?.id) throw new Error('Linear issue not found');
        if (issue.team?.key !== 'DEMO') {
          result.skipped++;
          result.plan.find(item => item.issue === summary.issue)!.action = 'team-mismatch';
          debug.log('linear.progress-sync', 'skipped', { issue: summary.issue, day: summary.day, reason: 'team-not-allowed' });
          continue;
        }
        if ((issue.comments?.nodes ?? []).some(comment => comment.body?.includes(marker(summary)))) {
          state[key] = true;
          saveState(path, state);
          result.skipped++;
          result.plan.find(item => item.issue === summary.issue)!.action = 'already-posted';
          debug.log('linear.progress-sync', 'skipped', { issue: summary.issue, day: summary.day, reason: 'remote-marker-found' });
          continue;
        }
        const body = `${summary.body}\n\n_${marker(summary)}_`;
        await commentLinearIssue({ apiKey, issueId: issue.id, body, fetch: fetchFn });
        state[key] = true;
        saveState(path, state);
        result.posted++;
        debug.log('linear.progress-sync', 'posted', { issue: summary.issue, day: summary.day });
      } catch (error) {
        result.failed++;
        const reason = error instanceof Error ? (/^Linear GraphQL HTTP \d{3}$/.test(error.message) ? error.message : error.name) : 'unknown';
        debug.log('linear.progress-sync', 'failed', { issue: summary.issue, day: summary.day, reason });
      }
    }
    return result;
  } finally {
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}
