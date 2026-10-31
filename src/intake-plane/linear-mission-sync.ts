import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchLinearMissionIssueIdentity, transitionLinearIssueStateType } from '../connectors/linear.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { debug } from '../debug/log.js';
import { acquireLockAsync } from '../storage/file-lock.js';

export interface LinearMissionLink {
  teamKey: 'DEMO';
  issueId: string;
  parentIssueId: string;
}

/** Resolve model-supplied input once and persist only a verified DEMO child link. */
export async function resolveDemoLinearMissionLink(issueId: string, deps: {
  getApiKey?: (id: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
} = {}): Promise<LinearMissionLink> {
  const id = issueId.trim();
  if (!id || id.length > 128) throw new Error('Linear 하위 이슈 식별자가 올바르지 않습니다');
  const apiKey = await (deps.getApiKey ?? getSecretAsync)('connector.linear.apiKey');
  if (!apiKey?.trim()) throw new Error('Linear 키가 없습니다');
  const identity = await fetchLinearMissionIssueIdentity({ apiKey, issueId: id, fetch: deps.fetch });
  if (identity.teamKey !== 'DEMO' || !identity.parentId) throw new Error('DEMO 팀의 하위 이슈만 미션에 연결할 수 있습니다');
  return { teamKey: 'DEMO', issueId: identity.id, parentIssueId: identity.parentId };
}

/** Synchronize only accepted progress/final events; API failures never undo the durable mission reply. */
export async function syncLinearMissionProgress(input: {
  link?: LinearMissionLink;
  lineType?: string;
  sequence?: number;
  latestLine?: { lineType: string; sequence: number };
}, deps: {
  getApiKey?: (id: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  lockRoot: string;
  getLatestLine?: () => Promise<{ lineType: string; sequence: number } | undefined>;
}): Promise<void> {
  const { link } = input;
  const latest = input.latestLine && input.latestLine.sequence >= (input.sequence ?? 0) ? input.latestLine : undefined;
  const lineType = latest?.lineType ?? input.lineType;
  if (!link || link.teamKey !== 'DEMO' || !link.parentIssueId || !['progress', 'final'].includes(lineType ?? '')) return;
  let release: (() => void) | undefined;
  try {
    const dir = join(deps.lockRoot, 'agent-missions');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const issueKey = createHash('sha256').update(link.issueId).digest('hex');
    const lock = await acquireLockAsync(join(dir, `linear-sync-${issueKey}.lock`), { staleMs: 120_000, maxTries: 4_800 });
    release = lock.release;
    // Another accepted event may have been persisted while this caller waited.
    let effectiveSequence = input.sequence ?? 0;
    let effectiveLineType = input.lineType;
    const afterLockLatest = (await deps.getLatestLine?.()) ?? input.latestLine;
    if (afterLockLatest && afterLockLatest.sequence >= effectiveSequence) {
      effectiveSequence = afterLockLatest.sequence;
      effectiveLineType = afterLockLatest.lineType;
    }
    if (!['progress', 'final'].includes(effectiveLineType ?? '')) return;
    const apiKey = await (deps.getApiKey ?? getSecretAsync)('connector.linear.apiKey');
    if (!apiKey?.trim()) throw new Error('Linear key unavailable');
    const newest = await deps.getLatestLine?.();
    if (newest && newest.sequence > effectiveSequence) effectiveLineType = newest.lineType;
    if (!lock.stillHeld()) throw new Error('Linear mission sync lock lost before issue update');
    await transitionLinearIssueStateType({
      apiKey, issueId: link.issueId,
      type: effectiveLineType === 'final' ? 'completed' : 'started',
      ...(effectiveLineType === 'progress' ? { fromTypes: ['unstarted'] } : {}),
      fetch: deps.fetch,
    });
    return;
  } catch (error) {
    debug.log('agent-mission', 'linear-progress-sync-failed', {
      issueId: link.issueId, lineType, error: String(error).replace(/\b(?:lin_api_)?[A-Za-z0-9_-]{24,}\b/g, '[redacted]'),
    }, { level: 'warn' });
  } finally {
    release?.();
  }
}
