import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecretText } from '../debug/log.js';

export type StewardStage = 'sync' | 'triage' | 'schedule' | 'report';
export interface FailureStreak {
  consecutive: number;
  lastStage: StewardStage;
  lastReason: string;
  lastAt: string;
  alertedAt?: string;
  open?: { stage: StewardStage; startedAt: string };
}

const stages: readonly string[] = ['sync', 'triage', 'schedule', 'report'];
const empty = (): FailureStreak => ({ consecutive: 0, lastStage: 'sync', lastReason: '', lastAt: '' });
const pathFor = (root: string): string => join(root, 'steward', 'streak.json');

export function readFailureStreak(root: string): FailureStreak {
  try {
    const value: unknown = JSON.parse(readFileSync(pathFor(root), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return empty();
    const s = value as Record<string, unknown>;
    if (!Number.isSafeInteger(s.consecutive) || (s.consecutive as number) < 0 ||
        !stages.includes(s.lastStage as string) || typeof s.lastReason !== 'string' || typeof s.lastAt !== 'string' ||
        (s.alertedAt !== undefined && typeof s.alertedAt !== 'string')) return empty();
    if (s.open !== undefined && (!s.open || typeof s.open !== 'object' || Array.isArray(s.open) ||
        !stages.includes((s.open as Record<string, unknown>).stage as string) ||
        typeof (s.open as Record<string, unknown>).startedAt !== 'string')) return empty();
    return s as unknown as FailureStreak;
  } catch { return empty(); }
}

export function writeFailureStreak(root: string, state: FailureStreak): void {
  const dir = join(root, 'steward');
  mkdirSync(dir, { recursive: true });
  const path = pathFor(root);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}

export function markStageStart(root: string, stage: StewardStage, now: Date = new Date()): FailureStreak {
  const state = readFailureStreak(root);
  if (state.open) {
    state.consecutive += 1;
    state.lastStage = state.open.stage;
    state.lastReason = `killed or timed out: ${state.open.stage}`;
    state.lastAt = now.toISOString();
  }
  state.open = { stage, startedAt: now.toISOString() };
  writeFailureStreak(root, state);
  return state;
}

export function markStageEnd(root: string, stage: StewardStage, ok: boolean, reason = '', now: Date = new Date()): FailureStreak {
  const state = readFailureStreak(root);
  delete state.open;
  if (ok) {
    state.consecutive = 0;
    delete state.alertedAt;
  } else {
    state.consecutive += 1;
  }
  state.lastStage = stage;
  state.lastReason = ok ? '' : redactSecretText(reason);
  state.lastAt = now.toISOString();
  writeFailureStreak(root, state);
  return state;
}

export function shouldAlert(state: FailureStreak, threshold: number): boolean {
  return state.consecutive >= threshold && !state.alertedAt;
}

export function failureAlertText(state: FailureStreak): string {
  return `스튜어드 연속 실패 ${state.consecutive}회 · 마지막 ${state.lastStage} · ${redactSecretText(state.lastReason).slice(0, 120)} · 로그 /tmp/elanous-loop-steward.log`;
}
