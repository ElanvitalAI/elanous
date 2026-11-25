// SESSION-AUTOPILOT goal stack (대표 11-24 15:3x «what the person decides is the GOALS»).
//
// S: autopilot drives toward a goal, but the goals that matter to the person sit at three heights — the release
//    schedule (short), milestones like demos (mid), month/quarter plans (long) — and none of them was structured.
// C: autopilot must never invent a mid/long goal; it may only PROPOSE one (decision card). The person sets, edits and
//    removes goals in any phrasing (the model calls autopilot_goal_set / autopilot_goal_remove in a HUMAN turn).
// A: `<memory store>/.autopilot/goals.json` beside the autopilot state (same resolver → survives restarts; other
//    sessions of the store read it). An autonomous turn's set is refused and becomes one proposal card.
//    Near due (mid ≤ 48 h · long ≤ 7 d) → one progress card per goal and the goal rides first in the turn paragraph.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type AutopilotGoalLevel = 'short' | 'mid' | 'long';
export interface AutopilotGoal {
  id: string;
  level: AutopilotGoalLevel;
  title: string;
  /** ISO timestamp. */
  due?: string;
  owner: 'person';
  status: 'active' | 'done' | 'dropped';
  measure?: string;
  /** 'seed' = imported facts the person may delete · 'person' = set by the person. */
  source: 'seed' | 'person';
  /** When the one near-due progress card was posted. */
  progressCardAt?: string;
}

export const GOAL_NEAR_MS: Record<AutopilotGoalLevel, number> = { short: 0, mid: 48 * 60 * 60_000, long: 7 * 24 * 60 * 60_000 };

/** OP first-start seed (read-only import of standing facts · source=seed so the person can delete them). */
export const OP_GOAL_SEED: ReadonlyArray<Omit<AutopilotGoal, 'id' | 'owner' | 'status' | 'source'>> = [
  { level: 'mid', title: '11-26 20:00 AI&B demo', due: '2026-11-26T20:00:00+09:00' },
  { level: 'mid', title: 'Free membership opens December', due: '2026-12-01T00:00:00+09:00' },
  { level: 'long', title: '2027 Q1 paid launch prep', due: '2027-03-31T23:59:00+09:00' },
  { level: 'long', title: 'Paid launch in April', due: '2027-04-01T00:00:00+09:00' },
];

export const autopilotGoalsFile = (stateFile: string): string => join(dirname(stateFile), 'goals.json');

export function readGoals(file: string): AutopilotGoal[] | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as AutopilotGoal[]).filter((g) => g && typeof g.id === 'string' && typeof g.title === 'string') : null;
  } catch { return null; }
}

export function writeGoals(file: string, goals: readonly AutopilotGoal[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(goals, null, 2)}\n`);
  renameSync(temp, file);
}

const slug = (title: string): string => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'goal';

/** Seed once when the store has no goals file yet (an emptied file stays empty). */
export function seedGoalsIfMissing(file: string, seed: typeof OP_GOAL_SEED): AutopilotGoal[] {
  const existing = readGoals(file);
  if (existing) return existing;
  const goals = seed.map((g): AutopilotGoal => ({ ...g, id: slug(g.title), owner: 'person', status: 'active', source: 'seed' }));
  writeGoals(file, goals);
  return goals;
}

export interface GoalSetInput { id?: string; level?: string; title?: string; due?: string; status?: string; measure?: string }
export type GoalWriteResult = { ok: true; goal?: AutopilotGoal; text: string } | { ok: false; text: string; proposal?: boolean };

/**
 * Set / edit a goal. `by` = who opened the turn: only a person's turn writes; an autonomous turn's call is refused and
 * handed to `propose` (one decision card) — autopilot never invents a goal.
 */
export function setGoal(file: string, input: GoalSetInput, by: 'person' | 'autopilot', propose?: (input: GoalSetInput) => void): GoalWriteResult {
  if (by !== 'person') {
    try { propose?.(input); } catch { /* the refusal stands either way */ }
    return { ok: false, proposal: true, text: '목표는 사람이 정한다 — 자율 턴에서는 제안 카드로만 올렸다' };
  }
  const goals = readGoals(file) ?? [];
  const id = input.id?.trim() || (input.title ? slug(input.title) : '');
  const prior = goals.find((g) => g.id === id);
  if (!prior && (!input.title?.trim() || !['short', 'mid', 'long'].includes(input.level ?? ''))) {
    return { ok: false, text: '새 목표에는 title 과 level(short|mid|long)이 필요하다' };
  }
  if (input.due !== undefined && input.due !== '' && !Number.isFinite(Date.parse(input.due))) return { ok: false, text: `due 는 ISO 시각 — 받은 값 ${JSON.stringify(input.due)}` };
  if (input.status !== undefined && !['active', 'done', 'dropped'].includes(input.status)) return { ok: false, text: 'status 는 active|done|dropped' };
  const base: AutopilotGoal = prior ?? { id, level: input.level as AutopilotGoalLevel, title: input.title!.trim(), owner: 'person', status: 'active', source: 'person' };
  const dueChanged = input.due !== undefined && input.due !== prior?.due;
  const goal: AutopilotGoal = {
    ...base,
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    ...(input.level && ['short', 'mid', 'long'].includes(input.level) ? { level: input.level as AutopilotGoalLevel } : {}),
    ...(input.due ? { due: input.due } : {}),
    ...(input.status ? { status: input.status as AutopilotGoal['status'] } : {}),
    ...(input.measure?.trim() ? { measure: input.measure.trim() } : {}),
    source: 'person',
  };
  if (dueChanged) delete goal.progressCardAt;
  writeGoals(file, [...goals.filter((g) => g.id !== id), goal]);
  return { ok: true, goal, text: `목표 ${prior ? '수정' : '추가'}: [${goal.level}] ${goal.title}${goal.due ? ` · ${goal.due}` : ''}` };
}

export function removeGoal(file: string, id: string, by: 'person' | 'autopilot'): GoalWriteResult {
  if (by !== 'person') return { ok: false, text: '목표는 사람이 지운다 — 자율 턴에서는 지우지 않는다' };
  const goals = readGoals(file) ?? [];
  if (!goals.some((g) => g.id === id)) return { ok: false, text: `없는 목표 id ${JSON.stringify(id)}` };
  writeGoals(file, goals.filter((g) => g.id !== id));
  return { ok: true, text: `목표 삭제: ${id}` };
}

export const activeGoals = (goals: readonly AutopilotGoal[]): AutopilotGoal[] =>
  goals.filter((g) => g.status === 'active').sort((a, b) => (Date.parse(a.due ?? '') || Infinity) - (Date.parse(b.due ?? '') || Infinity));

/** «D-2» · «D-0 5h» · «지남» — time to due. */
export function timeToDue(due: string | undefined, now: number): string {
  const at = Date.parse(due ?? '');
  if (!Number.isFinite(at)) return 'no due date';
  const ms = at - now;
  if (ms < 0) return 'overdue';
  const days = Math.floor(ms / 86_400_000);
  return days > 0 ? `D-${days}` : `D-0 ${Math.max(1, Math.round(ms / 3_600_000))}h`;
}

export const isNearDue = (g: AutopilotGoal, now: number): boolean => {
  const at = Date.parse(g.due ?? '');
  return g.status === 'active' && g.level !== 'short' && Number.isFinite(at) && at >= now && at - now <= GOAL_NEAR_MS[g.level];
};

/** Near-due goals that have not had their progress card yet; marks them (one card per goal per due). */
export function takeProgressCardsDue(file: string, now: number): AutopilotGoal[] {
  const goals = readGoals(file);
  if (!goals) return [];
  const due = goals.filter((g) => isNearDue(g, now) && !g.progressCardAt);
  if (due.length === 0) return [];
  const stamp = new Date(now).toISOString();
  writeGoals(file, goals.map((g) => (due.some((d) => d.id === g.id) ? { ...g, progressCardAt: stamp } : g)));
  return due;
}

/** Status-line tail: the nearest due mid/long goal — «데모 D-2». */
export function nearestGoalChip(goals: readonly AutopilotGoal[], now: number): string {
  const next = activeGoals(goals).find((g) => g.level !== 'short' && Number.isFinite(Date.parse(g.due ?? '')) && Date.parse(g.due!) >= now);
  if (!next) return '';
  const words = next.title.replace(/^\d{1,2}-\d{1,2}\s+(\d{1,2}:\d{2}\s+)?/, '').split(/\s+/);
  return `${words.at(-1) ?? next.title} ${timeToDue(next.due, now)}`;
}

/** Lines for the autopilot paragraph — near-due goals first (priority up), then the rest by due. */
export function goalLines(goals: readonly AutopilotGoal[], now: number): string[] {
  const active = activeGoals(goals);
  const near = active.filter((g) => isNearDue(g, now));
  const rest = active.filter((g) => !isNearDue(g, now));
  return [...near.map((g) => `- ⚠ [${g.level}] ${g.title} · ${timeToDue(g.due, now)} — 기한 임박: 관련 일을 먼저 한다`),
    ...rest.map((g) => `- [${g.level}] ${g.title} · ${timeToDue(g.due, now)}${g.measure ? ` · 측정 ${g.measure}` : ''}`)];
}
