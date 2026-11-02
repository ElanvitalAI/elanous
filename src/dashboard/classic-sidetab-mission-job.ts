import type { PendingTaskNotification } from '../agent/task-notification.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { debug } from '../debug/log.js';
import { redactMissionResultPath, type StartedClassicMissionCliJob } from './mission-cli-consumer.js';
import type { ClassicSidetabMissionResult } from './classic-sidetab-mission.js';
import { runVisibleAgentMission, type VisibleMissionDeps } from '../sidetab-core/visible-agent-mission.js';

export type ClassicMissionNotificationEnqueue = (notification: PendingTaskNotification) => void;
export const CLASSIC_SIDETAB_MISSION_LABEL = 'sidetab mission';
const CLASSIC_SIDETAB_PAIR_TIMEOUT_MS = 60 * 60 * 1_000;

/** Ensure visible agents can create their requested result file on first run. */
export function prepareClassicSidetabMissionOutputDirectory(outputPath: string): void {
  if (!outputPath.trim()) throw new Error('sidetab mission output path is required');
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
}

/** Prepare the production result path before the visible agent can write to it. */
export async function runPreparedClassicSidetabVisibleMission(
  deps: Omit<VisibleMissionDeps, 'outputPath'> & { outputPath: string },
) {
  prepareClassicSidetabMissionOutputDirectory(deps.outputPath);
  return runVisibleAgentMission(deps);
}

export interface ClassicSidetabMissionPairCompletionResult {
  codex: ClassicSidetabMissionResult;
  claude: ClassicSidetabMissionResult;
  status: 'done' | 'error';
  finishedAt: number;
}
type ClassicSidetabPairOutcome = ClassicSidetabMissionResult;
interface ClassicSidetabMissionPairJob {
  missionId?: string;
  taskId: string;
  parentSessionId?: string;
  startedAt: number;
  mission: string;
  workspaceDir: string;
  completion: Promise<ClassicSidetabPairOutcome>;
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'pair';
}

function resultFileLabel(workspaceDir: string, result: ClassicSidetabPairOutcome): string {
  if (!result.path) return '없음';
  const rel = relative(workspaceDir, result.path);
  return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) ? rel : basename(result.path);
}

function buildPairSynthesis(
  pair: { codex: ClassicSidetabMissionPairJob; claude: ClassicSidetabMissionPairJob },
  codex: ClassicSidetabPairOutcome,
  claude: ClassicSidetabPairOutcome,
): string {
  const rows = [
    { agent: 'Codex', job: pair.codex, result: codex },
    { agent: 'Claude Code', job: pair.claude, result: claude },
  ];
  const cell = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim().replaceAll('\\', '&#92;').replaceAll('|', '&#124;');
  const table = rows.map(({ agent, job, result }) => {
    const accepted = result.ok && Boolean(result.content?.trim());
    const decision = accepted
      ? '채택 — 별도 기여로 보존; 두 결과 간 우열을 임의 판정하지 않음'
      : `미채택 — ${result.error ?? (result.ok ? '빈 결과' : '실패')}`;
    const task = job.mission.length > 240 ? `${job.mission.slice(0, 240)}…` : job.mission;
    return `| ${cell(agent)} | ${cell(task)} | ${cell(resultFileLabel(job.workspaceDir, result))} | ${accepted ? '성공' : '실패/빈 결과'} | ${cell(decision)} |`;
  }).join('\n');
  const contributions = rows.flatMap(({ agent, result }) => {
    const content = result.ok ? result.content?.trim() : '';
    if (!content) return [];
    return [`## ${agent} 기여`, redactMissionResultPath(content, result.path)];
  });
  return [
    '# Codex + Claude mission pair synthesis', '',
    `- Codex mission: ${pair.codex.missionId ?? 'unavailable'}`,
    `- Claude mission: ${pair.claude.missionId ?? 'unavailable'}`, '',
    '## 비교·채택 표', '',
    '| 손 | 맡은 작업 | 결과 파일 | 판정 | 채택 근거 |',
    '|---|---|---|---|---|', table, '',
    '채택 기준: 성공하고 비어 있지 않은 결과를 각자 독립 기여로 보존한다. 두 손의 답이 서로 다른 작업 분담에서 나온 경우 품질 순위를 추정하지 않으며, 실패·빈 결과는 채택하지 않고 사유를 남긴다.', '',
    ...contributions.flatMap((section) => [section, '']),
  ].join('\n').trimEnd() + '\n';
}

function persistPairSynthesis(
  pair: { codex: ClassicSidetabMissionPairJob; claude: ClassicSidetabMissionPairJob },
  taskId: string,
  codex: ClassicSidetabPairOutcome,
  claude: ClassicSidetabPairOutcome,
): string {
  if (typeof pair.codex.workspaceDir !== 'string' || !pair.codex.workspaceDir.trim()
    || pair.codex.workspaceDir !== pair.claude.workspaceDir) {
    throw new Error('pair members must share a workspace to persist one synthesis artifact');
  }
  const dir = join(pair.codex.workspaceDir, '.elanous', 'mission-results');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `classic-pair-synthesis-${safeFilePart(taskId)}-${randomUUID()}.md`);
  writeFileSync(path, buildPairSynthesis(pair, codex, claude), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return path;
}

function compactPairNotification(status: 'done' | 'error', body: string, id: string): string {
  const clean = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const payload = { status, body: clean(body), id: clean(id).slice(0, 80) || 'pair' };
  let serialized = JSON.stringify(payload);
  while (serialized.length > 500 && payload.body.length > 0) {
    payload.body = payload.body.slice(0, -1);
    serialized = JSON.stringify(payload);
  }
  return serialized;
}

function pairFailurePreview(name: string, result: ClassicSidetabPairOutcome): string {
  const value = result.ok ? result.content?.trim() ?? '' : result.error ?? 'no result returned';
  const redacted = redactMissionResultPath(value, result.path);
  const clean = redacted.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${name}: ${clean.slice(0, 110)}${clean.length > 110 ? '…' : ''}`;
}

/** Deliver one eventual sidetab result through the parent's existing task-notification input path. */
export function enqueueClassicSidetabMissionCompletion(
  job: StartedClassicMissionCliJob,
  agent: 'codex' | 'claude',
  enqueue: ClassicMissionNotificationEnqueue,
  now: () => number = Date.now,
): void {
  let deliveryAttempted = false;
  const enqueueOnce = (notification: PendingTaskNotification): void => {
    if (deliveryAttempted) return;
    deliveryAttempted = true;
    try {
      enqueue(notification);
    } catch {
      debug.log('classic-sidetab.mission', 'completion-enqueue-failed', {
        interactionId: job.interactionId,
        retry: false,
      });
    }
  };
  const deliver = (result: Awaited<StartedClassicMissionCliJob['completion']>): void => {
    const finishedAt = now();
    const state = result.ok ? 'done' : result.status === 'cancelled' ? 'aborted' : 'error';
    const body = result.ok
      ? redactMissionResultPath(result.content ?? '', result.path)
      : redactMissionResultPath(result.error ?? 'Sidetab mission failed; no result was returned', result.path);
    enqueueOnce({
      taskId: job.interactionId,
      agentName: agent === 'codex' ? 'Codex' : 'Claude Code',
      label: CLASSIC_SIDETAB_MISSION_LABEL,
      state,
      output: JSON.stringify({ status: state, body, artifacts: [], id: job.interactionId }),
      truncated: false,
      durationMs: Math.max(0, finishedAt - job.startedAt),
      finishedAt,
    });
  };
  void job.completion.then(deliver).catch(() => {
    const finishedAt = now();
    enqueueOnce({
      taskId: job.interactionId,
      agentName: agent === 'codex' ? 'Codex' : 'Claude Code',
      label: CLASSIC_SIDETAB_MISSION_LABEL,
      state: 'error',
      output: JSON.stringify({ status: 'error', body: 'Sidetab mission failed before a result was available', artifacts: [], id: job.interactionId }),
      truncated: false,
      durationMs: Math.max(0, finishedAt - job.startedAt),
      finishedAt,
    });
  });
}

/** Deliver a single combined parent notification after both parallel agents finish. */
export function enqueueClassicSidetabMissionPairCompletion(
  pair: { codex: ClassicSidetabMissionPairJob; claude: ClassicSidetabMissionPairJob },
  enqueue: ClassicMissionNotificationEnqueue,
  now: () => number = Date.now,
  options: { timeoutMs?: number; onTimeout?: () => void; onComplete?: (result: ClassicSidetabMissionPairCompletionResult) => void } = {},
): Promise<ClassicSidetabMissionPairCompletionResult> {
  const taskId = pair.codex.taskId;
  const startedAt = Math.min(pair.codex.startedAt, pair.claude.startedAt);
  const timeoutMs = options.timeoutMs ?? CLASSIC_SIDETAB_PAIR_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<[ClassicSidetabPairOutcome, ClassicSidetabPairOutcome]>((resolve) => {
    timeout = setTimeout(() => {
      try { options.onTimeout?.(); } catch { /* timeout cleanup cannot suppress the receipt */ }
      const failure = (member: string): ClassicSidetabPairOutcome => ({ ok: false, status: 'failed', error: `${member} sidetab mission exceeded the one-hour safety timeout` });
      resolve([failure('Codex'), failure('Claude')]);
    }, Math.max(1, timeoutMs));
  });
  const rejected = (name: string) => (error: unknown): ClassicSidetabPairOutcome => ({
    ok: false,
    status: 'failed',
    error: `${name} sidetab mission rejected: ${error instanceof Error ? error.message : String(error)}`,
  });
  return Promise.race([
    Promise.all([pair.codex.completion.catch(rejected('Codex')), pair.claude.completion.catch(rejected('Claude'))]),
    timedOut,
  ]).then(([codex, claude]) => {
    const finishedAt = now();
    const bothSucceeded = codex.ok && claude.ok && Boolean(codex.content?.trim()) && Boolean(claude.content?.trim());
    let synthesisPath: string | undefined;
    let synthesisError: string | undefined;
    try { synthesisPath = persistPairSynthesis(pair, taskId, codex, claude); }
    catch (error) {
      synthesisError = error instanceof Error ? error.message : String(error);
      debug.log('classic-sidetab.mission-pair', 'synthesis-write-failed', { taskId, reason: synthesisError }, { level: 'warn' });
    }
    const ok = bothSucceeded && Boolean(synthesisPath);
    const result: ClassicSidetabMissionPairCompletionResult = {
      codex, claude, status: ok ? 'done' : 'error', finishedAt,
    };
    try { options.onComplete?.(result); }
    catch { debug.log('classic-sidetab.mission-pair', 'completion-callback-failed', { taskId, retry: false }); }
    const summary = synthesisPath
      ? bothSucceeded ? 'Both missions completed. Full comparison attached.' : 'Pair completed with failures. Full comparison attached.'
      : `Synthesis save failed; ${pairFailurePreview('Codex', codex)}; ${pairFailurePreview('Claude', claude)}`;
    const output = compactPairNotification(ok ? 'done' : 'error', summary, pair.codex.missionId ?? pair.claude.missionId ?? taskId);
    try {
      enqueue({
        taskId,
        ...(pair.codex.parentSessionId ? { parentSessionId: pair.codex.parentSessionId } : {}),
        agentName: 'Codex + Claude',
        label: CLASSIC_SIDETAB_MISSION_LABEL,
        state: ok ? 'done' : 'error',
        output,
        truncated: !synthesisPath,
        ...(synthesisPath ? { resultPath: synthesisPath } : {}),
        durationMs: Math.max(0, finishedAt - startedAt),
        finishedAt,
      });
    } catch {
      debug.log('classic-sidetab.mission-pair', 'completion-enqueue-failed', { taskId, retry: false });
    }
    return result;
  }).catch(() => {
    const finishedAt = now();
    const failure = (error: string): ClassicSidetabMissionResult => ({ ok: false, status: 'failed', error });
    const result: ClassicSidetabMissionPairCompletionResult = {
      codex: failure('Codex/Claude pair failed before results were available'),
      claude: failure('Codex/Claude pair failed before results were available'),
      status: 'error', finishedAt,
    };
    try { options.onComplete?.(result); } catch { debug.log('classic-sidetab.mission-pair', 'completion-callback-failed', { taskId, retry: false }); }
    try {
      enqueue({
        taskId,
        ...(pair.codex.parentSessionId ? { parentSessionId: pair.codex.parentSessionId } : {}),
        agentName: 'Codex + Claude',
        label: CLASSIC_SIDETAB_MISSION_LABEL,
        state: 'error',
        output: compactPairNotification('error', 'Concurrent Codex/Claude missions failed before results were available', pair.codex.missionId ?? pair.claude.missionId ?? taskId),
        truncated: false,
        durationMs: Math.max(0, finishedAt - startedAt),
        finishedAt,
      });
    } catch {
      debug.log('classic-sidetab.mission-pair', 'completion-enqueue-failed', { taskId, retry: false });
    }
    return result;
  }).finally(() => { if (timeout) clearTimeout(timeout); });
}
