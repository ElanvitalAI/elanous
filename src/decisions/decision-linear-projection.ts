import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { createLinearIssue, commentLinearIssue, findLinearDecisionIssue, moveLinearIssueToStateType, resolveLinearProjectId } from '../connectors/linear.js';
import { debug } from '../debug/log.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { getUserConfig, type UserConfig } from '../user-config.js';
import { DecisionLedger, type DecisionEntry } from './decision-ledger.js';

interface ProjectionRecord { issue: string; closedAt?: string; commentPosted?: boolean }
type ProjectionState = Record<string, ProjectionRecord>;
export interface DecisionLinearProjectionDeps {
  stateDir?: string;
  ledger?: Pick<DecisionLedger, 'list'>;
  config?: Pick<UserConfig, 'decisions' | 'coo'>;
  getSecret?: (id: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  dryRun?: boolean;
}
export interface DecisionLinearProjectionResult {
  created: number; closed: number; skipped: number; failed: number;
  reason?: string;
  plan?: Array<{ decisionId: string; action: 'create' | 'close'; issue?: string }>;
}

function readState(path: string): ProjectionState {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([id, row]) =>
    !/^D-\d{8}-\d+$/.test(id) || !row || typeof row !== 'object' || Array.isArray(row) ||
    typeof (row as ProjectionRecord).issue !== 'string' || !(row as ProjectionRecord).issue ||
    ((row as ProjectionRecord).closedAt !== undefined && typeof (row as ProjectionRecord).closedAt !== 'string') ||
    ((row as ProjectionRecord).commentPosted !== undefined && typeof (row as ProjectionRecord).commentPosted !== 'boolean'))) {
    throw new Error('invalid decision Linear projection state');
  }
  return value as ProjectionState;
}

function saveState(path: string, state: ProjectionState): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, path);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

function description(entry: DecisionEntry): string {
  return [`카테고리: ${entry.category}`, ...(entry.dueAt ? [`기한: ${entry.dueAt}`] : []),
    `결정 id: ${entry.id}`, '텔레그램/디스코드 카드에서 정한다',
    ...(entry.refs ?? []).filter(ref => ref.startsWith('http'))].join('\n');
}

/** A single writer holds the file lock across remote creation and local persistence. */
export async function projectDecisionsToLinear(deps: DecisionLinearProjectionDeps = {}): Promise<DecisionLinearProjectionResult> {
  const result: DecisionLinearProjectionResult = { created: 0, closed: 0, skipped: 0, failed: 0 };
  const config = deps.config ?? getUserConfig();
  if (config.decisions?.linearProjection?.enabled !== true) {
    result.reason = 'decisions.linearProjection.enabled 꺼짐';
    debug.log('decisions.linear', 'skipped', { decisionId: null, issue: null, reason: 'disabled' });
    return result;
  }
  // A dry run only reads the local ledger and state — it must work before a key is set.
  const apiKey = (deps.dryRun ? '' : await (deps.getSecret ?? getSecretAsync)('connector.linear.apiKey')) ?? '';
  if (!deps.dryRun && !apiKey) {
    result.reason = 'Linear 키가 없습니다 — `elanous connector linear set-key`';
    debug.log('decisions.linear', 'skipped', { decisionId: null, issue: null, reason: 'missing-key' });
    return result;
  }
  const stateDir = deps.stateDir ?? elanousStateRoot();
  const path = join(stateDir, 'decisions', 'linear-projection.json');
  const ledger = deps.ledger ?? new DecisionLedger({ stateDir });
  const entries = ledger.list({ status: 'all' });
  const fetchFn = deps.fetch ?? fetch;
  const lockPath = `${path}.lock`;
  let lock: number | undefined;
  if (!deps.dryRun) {
    mkdirSync(join(path, '..'), { recursive: true });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { lock = openSync(lockPath, 'wx', 0o600); writeSync(lock, `${process.pid}`); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const pid = Number(readFileSync(lockPath, 'utf8'));
          if (Number.isSafeInteger(pid) && pid > 0 && Date.now() - statSync(lockPath).mtimeMs > 30_000) {
            try { process.kill(pid, 0); }
            catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(lockPath); continue; } }
          }
        } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; }
        if (Date.now() >= deadline) throw new Error('decision Linear projection lock timeout');
        await Bun.sleep(25);
      }
    }
  }
  try {
    const state = readState(path);
    if (deps.dryRun) result.plan = [];
    let projectId: string | undefined;
    for (const entry of entries) {
      let issue = state[entry.id]?.issue;
      try {
        const record = state[entry.id];
        if (entry.status === 'open' && !record) {
          if (deps.dryRun) {
            result.plan!.push({ decisionId: entry.id, action: 'create' });
            result.created++;
          } else {
            projectId ??= await resolveLinearProjectId({ apiKey, project: config.coo?.linearProject ?? '외부 행정·큰 일 (COO)', fetch: fetchFn });
            const existing = await findLinearDecisionIssue({ apiKey, projectId, decisionId: entry.id, fetch: fetchFn });
            issue = existing ?? await createLinearIssue({ apiKey, projectId, title: `[결정] ${entry.title}`, description: description(entry),
              ...(entry.dueAt ? { dueDate: entry.dueAt.slice(0, 10) } : {}), fetch: fetchFn });
            state[entry.id] = { issue };
            saveState(path, state);
            if (existing) {
              result.skipped++;
              debug.log('decisions.linear', 'skipped', { decisionId: entry.id, issue, reason: 'recovered' });
              continue;
            }
            result.created++;
          }
          debug.log('decisions.linear', 'created', { decisionId: entry.id, issue: issue ?? null, reason: deps.dryRun ? 'dry-run' : 'created' });
        } else if (entry.status !== 'open' && record && !record.closedAt) {
          if (deps.dryRun) {
            result.plan!.push({ decisionId: entry.id, action: 'close', issue: record.issue });
          } else {
            if (!record.commentPosted) {
              const body = entry.status === 'withdrawn' ? '철회됨'
                : `결정됨: ${entry.choice ?? '선택 키 미상'} · ${entry.decidedBy?.kind ?? '주체 미상'} · ${entry.decidedAt ?? '시각 미상'}`;
              await commentLinearIssue({ apiKey, issueId: record.issue, body, fetch: fetchFn });
              record.commentPosted = true;
              saveState(path, state);
            }
            await moveLinearIssueToStateType({ apiKey, issueId: record.issue, type: entry.status === 'decided' ? 'completed' : 'canceled', fetch: fetchFn });
            record.closedAt = new Date().toISOString();
            saveState(path, state);
          }
          result.closed++;
          debug.log('decisions.linear', 'closed', { decisionId: entry.id, issue: record.issue, reason: deps.dryRun ? 'dry-run' : entry.status });
        } else {
          result.skipped++;
          debug.log('decisions.linear', 'skipped', { decisionId: entry.id, issue: issue ?? null, reason: record?.closedAt ? 'already-closed' : record ? 'already-created' : 'not-projected' });
        }
      } catch (error) {
        result.failed++;
        const reason = error instanceof Error
          ? (error as NodeJS.ErrnoException).code ?? (/^Linear GraphQL HTTP \d{3}$/.test(error.message) ? error.message : error.name)
          : 'unknown';
        debug.log('decisions.linear', 'failed', { decisionId: entry.id, issue: issue ?? null, reason });
      }
    }
    return result;
  } finally {
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}
