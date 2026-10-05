import type { DecisionEntry } from './decision-ledger.js';
import type { ChecklistItem } from '../release-loop/checklist.js';
import type { ReleaseSchedule } from '../release-loop/release-schedule.js';
import type { DraftSweepResult, SweepDraft } from '../self-dev/draft-sweep.js';

type ProactLoop = { readonly name: string; readonly state: 'alive' | 'late' | 'failing' | 'off' | 'unknown'; readonly scope?: string };
type ProactYellow = { readonly version: string; readonly item: Pick<ChecklistItem, 'id' | 'title' | 'status'> };
type ProactDrafts = { readonly drafts: readonly Pick<SweepDraft, 'number' | 'title'>[]; readonly sweep: Pick<DraftSweepResult, 'complete' | 'entries'> };
export interface ProactSignals {
  /** A suspended run (resume) or an explicitly observed blocker, not merely an old open card. */
  readonly decisions?: readonly (Pick<DecisionEntry, 'id' | 'title' | 'status' | 'raisedAt' | 'importedAt' | 'resume'> & { readonly blocked?: boolean })[];
  readonly yellow?: readonly ProactYellow[];
  readonly schedules?: readonly Pick<ReleaseSchedule, 'version' | 'landBy'>[];
  readonly loops?: readonly ProactLoop[];
  /** Only a complete, read-only runDraftSweep({ apply: false }) assessment proves draft staleness. */
  readonly draftAssessment?: ProactDrafts;
}
type ProactSuggestion = {
  readonly key: string;
  readonly kind: 'decision' | 'yellow' | 'loop' | 'draft';
  readonly title: string;
  readonly reason: string;
  readonly source: string;
  readonly score: number;
};

const HOUR = 3_600_000;
const DECISION_AGE_HOURS = 24;
const LANDING_WINDOW_HOURS = 24;
const MAX_SUGGESTIONS = 3;

/** Rules-only, read-only selection. Missing/invalid observations are unknown, never evidence of urgency. */
export function selectProact1Lite(signals: ProactSignals, options: { now: Date; previouslySuggested?: ReadonlySet<string> }): ProactSuggestion[] {
  const now = options.now.getTime();
  if (!Number.isFinite(now)) throw new Error('valid now required');
  const candidates: ProactSuggestion[] = [];
  const elapsedHours = (iso: string | undefined): number => iso ? (now - Date.parse(iso)) / HOUR : NaN;
  const valid = (text: string): boolean => text.trim().length > 0;

  for (const card of signals.decisions ?? []) {
    if (card.status !== 'open' || (card.blocked !== true && !card.resume) || !valid(card.id) || !valid(card.title)) continue;
    // Imported historical cards have no known raise time; their import time is a lower bound on age.
    const age = elapsedHours(card.raisedAt ?? card.importedAt);
    if (!Number.isFinite(age) || age < DECISION_AGE_HOURS) continue;
    candidates.push({ key: `decision:${card.id}`, kind: 'decision', title: card.title,
      reason: `열린 결정 ${Math.floor(age)}시간 대기${card.raisedAt ? '' : ' (가져온 시각 기준)'}`,
      source: card.id, score: 400 + Math.min(100, Math.floor(age / 24)) });
  }

  const deadlines = new Map((signals.schedules ?? []).map(schedule => [schedule.version, schedule.landBy]));
  for (const { version, item } of signals.yellow ?? []) {
    if (item.status !== 'yellow' || !valid(item.id) || !valid(item.title) || !valid(version)) continue;
    const landBy = deadlines.get(version);
    const remaining = landBy ? (Date.parse(landBy) - now) / HOUR : NaN;
    if (!Number.isFinite(remaining) || remaining > LANDING_WINDOW_HOURS) continue;
    candidates.push({ key: `yellow:${version}:${item.id}`, kind: 'yellow', title: item.title,
      reason: remaining < 0 ? `착지 마감 ${Math.ceil(-remaining)}시간 경과` : `착지 마감 ${Math.ceil(remaining)}시간 전`,
      source: `${version}/${item.id} · ${landBy}`, score: 500 + Math.min(100, Math.max(0, Math.ceil(-remaining))) });
  }

  for (const loop of signals.loops ?? []) {
    if (loop.state !== 'late' || !valid(loop.name)) continue;
    candidates.push({ key: `loop:${loop.scope ?? ''}:${loop.name}`, kind: 'loop', title: loop.name,
      reason: '루프 실행 지연 관측', source: `${loop.scope ?? 'loop'}/${loop.name}`, score: 300 });
  }

  const assessment = signals.draftAssessment;
  if (assessment?.sweep.complete) {
    const drafts = new Map(assessment.drafts.map(draft => [draft.number, draft]));
    for (const entry of assessment.sweep.entries) {
      // A stale assessment is not a request to close: only surface the already-verified signal.
      if (entry.action !== 'close' || entry.applied || !['stale-unobserved', 'claim-expired', 'claim-expired (self-implement.result final; worktree is not live)'].includes(entry.reason)) continue;
      const draft = drafts.get(entry.number);
      if (!draft || !valid(draft.title)) continue;
      candidates.push({ key: `draft:${entry.number}`, kind: 'draft', title: draft.title,
        reason: `draft PR 정체 (${entry.reason})`, source: `#${entry.number}`, score: 200 });
    }
  }

  const selected = new Map<string, ProactSuggestion>();
  for (const candidate of candidates) {
    if (options.previouslySuggested?.has(candidate.key)) continue;
    if (!selected.has(candidate.key) || selected.get(candidate.key)!.score < candidate.score) selected.set(candidate.key, candidate);
  }
  return [...selected.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, MAX_SUGGESTIONS);
}
