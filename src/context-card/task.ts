import type { RunLedgerEntry } from '../self-implement/run-ledger.js';
import type { ContextCard } from './index.js';

/** An injected, read-only view of the JSONL run ledger. No writer or store mutation is available. */
export interface TaskLedgerReader {
  readRuns(): readonly { readonly runId: string; readonly entries: readonly RunLedgerEntry[] }[];
  /** Returns the verbatim original ask from the goal document named by start.goalFile. */
  readOriginalAsk?(goalFile: string): string | null;
  /** Returns must-fix text from the review artifact named by reviewed.artifactPath. */
  readReviewMustFix?(artifactPath: string): readonly string[] | null;
}

export interface TaskContextCard extends ContextCard {
  readonly kind: 'task';
  readonly originalAsk: string;
  readonly authoredGoal: { readonly path: string; readonly sha256: string } | null;
  readonly runIds: readonly string[];
  readonly mustFix: readonly string[];
  readonly decisionCards: readonly string[];
  readonly nextAction: string;
}

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const strings = (value: unknown): string[] | null => Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : null;

/** Produce a task card from source events, not from the previous card or wall-clock time. */
export function buildTaskCard(taskId: string, reader: TaskLedgerReader): TaskContextCard {
  const runs = reader.readRuns().filter((run) => run.entries.some((entry) => entry.event === 'start' && entry.goalId === taskId))
    .map((run) => ({ runId: run.runId, entries: run.entries.filter((entry) => entry.runId === run.runId && (entry.goalId === undefined || entry.goalId === taskId)) }))
    .sort((a, b) => a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);
  if (!runs.length) throw new Error(`no run-ledger start for task: ${taskId}`);
  const events = runs.flatMap(({ entries }) => entries).sort((a, b) =>
    (a.timestamp ?? '').localeCompare(b.timestamp ?? '') || a.runId.localeCompare(b.runId));
  const start = events.find((event) => event.event === 'start')!;
  const goalFile = text(start.data.goalFile);
  const originalAsk = text(start.data.originalAsk)
    ?? (goalFile ? reader.readOriginalAsk?.(goalFile) ?? null : null);
  if (!originalAsk) throw new Error(`original ask unavailable for task: ${taskId}`);

  const authored = [...events].reverse().find((event) => event.event === 'goal-authored'
    && text(event.data.path) !== null && /^[a-f0-9]{64}$/i.test(text(event.data.sha256) ?? ''));
  const authoredGoal = authored ? { path: text(authored.data.path)!, sha256: text(authored.data.sha256)! } : null;
  const reviews = events.filter((event) => event.event === 'reviewed' && event.data.reviewed === true);
  const review = reviews.at(-1);
  const artifactPath = review ? text(review.data.artifactPath) : null;
  const mustFix = review
    ? strings(review.data.mustFix) ?? (artifactPath ? reader.readReviewMustFix?.(artifactPath) ?? null : null)
    : [];
  if (mustFix === null && review?.data.mustFix !== 0) throw new Error(`review must-fix unavailable for task: ${taskId}`);
  const findings = mustFix ?? [];
  const decisionCards = events.filter((event) => event.event === 'decision-card')
    .flatMap((event) => {
      const cardId = text(event.data.cardId);
      return cardId ? [cardId] : [];
    });
  const nextAction = [...events].reverse().map((event) => text(event.data.nextAction)).find((value): value is string => value !== null)
    ?? findings[0] ?? null;
  if (!nextAction) throw new Error(`next action unavailable for task: ${taskId}`);
  const updatedAt = events.at(-1)?.timestamp;
  if (!updatedAt) throw new Error(`timestamp unavailable for task: ${taskId}`);
  const pointers = [
    ...(goalFile ? [goalFile] : []),
    ...(authoredGoal ? [`${authoredGoal.path}#sha256=${authoredGoal.sha256}`] : []),
    ...runs.map(({ runId }) => `run:${runId}`),
    ...(artifactPath ? [artifactPath] : []),
    ...decisionCards,
  ];
  return {
    id: `task:${taskId}`, kind: 'task', conclusion: nextAction,
    why: findings.length ? `최근 리뷰 must-fix ${findings.length}개` : '원문과 런 원장에 따른 다음 행동',
    verdict: text(review?.data.verdict) ?? '리뷰 판정 없음',
    remaining: [...findings], pointers,
    source: `run-ledger:${runs.map(({ runId }) => runId).join(',')}`, updatedAt,
    originalAsk, authoredGoal, runIds: runs.map(({ runId }) => runId), mustFix: [...findings], decisionCards, nextAction,
  };
}
