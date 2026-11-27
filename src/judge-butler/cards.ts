// 판정 집사 — goal card ⊕ soul card (graphs/loop-agents/judge-butler/{goal.yaml,soul.md}). Fail-open to built-in defaults.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

export interface GoalCard {
  kpi: { greens_per_hour_min: number; judge_queue_median_wait_max_min: number; frozen_hands_max: number; hand_answer_sla_min: number };
  voice: { per_hour_max: number; role: string };
  report: { digest_every_min: number };
}
export const DEFAULT_GOAL: GoalCard = {
  kpi: { greens_per_hour_min: 10, judge_queue_median_wait_max_min: 15, frozen_hands_max: 0, hand_answer_sla_min: 10 },
  voice: { per_hour_max: 12, role: 'coordinator' },
  report: { digest_every_min: 30 },
};

export const cardsDir = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'loop-agents', 'judge-butler');

export function loadCards(dir = cardsDir()): { goal: GoalCard; goalText: string; soulText: string } {
  const goalPath = join(dir, 'goal.yaml'); const soulPath = join(dir, 'soul.md');
  const goalText = existsSync(goalPath) ? readFileSync(goalPath, 'utf8') : '';
  const soulText = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : '판정 집사 (judge-butler) — 서브 조율자 급 · L0 = JUD · 증거로 초록을 닫고 HOLD 는 ID·범위·만료로만 다룬다.';
  let goal = DEFAULT_GOAL;
  try {
    const j = parse(goalText) as Partial<GoalCard> | null;
    if (j) goal = { kpi: { ...DEFAULT_GOAL.kpi, ...(j.kpi ?? {}) }, voice: { ...DEFAULT_GOAL.voice, ...(j.voice ?? {}) }, report: { ...DEFAULT_GOAL.report, ...(j.report ?? {}) } };
  } catch { /* defaults */ }
  return { goal, goalText, soulText };
}

/** BUTLER-SIGN-MERGED-PATCHID: the receipt rules of done-when (goal.yaml `green_rules`) — which receipt counts for the landed
 *  head and which focused results count as «focused exit 0». Unknown names are ignored; a missing/empty list → the default. */
export type SameHeadRule = 'exact' | 'patch-id';
export type FocusedOkRule = 'pass' | 'step-exit-0' | 'preexisting-on-main' | 'doc-only-L0';
export interface GreenRules { readonly sameHead: readonly SameHeadRule[]; readonly focusedOk: readonly FocusedOkRule[] }
export const DEFAULT_GREEN_RULES: GreenRules = { sameHead: ['exact', 'patch-id'], focusedOk: ['pass', 'step-exit-0', 'preexisting-on-main', 'doc-only-L0'] };
const SAME_HEAD: readonly string[] = ['exact', 'patch-id'];
const FOCUSED_OK: readonly string[] = ['pass', 'step-exit-0', 'preexisting-on-main', 'doc-only-L0'];

/** Pure: the goal.yaml text → green rules (fail-open to the default per list). */
export function parseGreenRules(goalText: string): GreenRules {
  type GoalYaml = { green_rules?: { same_head?: unknown; focused_ok?: unknown } } | null;
  let y: GoalYaml;
  try { y = parse(goalText) as GoalYaml; } catch { return DEFAULT_GREEN_RULES; }
  const pick = <T extends string>(v: unknown, allowed: readonly string[], dflt: readonly T[]): readonly T[] => {
    const l = Array.isArray(v) ? v.filter((x): x is T => typeof x === 'string' && allowed.includes(x)) : [];
    return l.length ? l : dflt;
  };
  return { sameHead: pick<SameHeadRule>(y?.green_rules?.same_head, SAME_HEAD, DEFAULT_GREEN_RULES.sameHead),
    focusedOk: pick<FocusedOkRule>(y?.green_rules?.focused_ok, FOCUSED_OK, DEFAULT_GREEN_RULES.focusedOk) };
}

export function loadGreenRules(dir = cardsDir()): GreenRules {
  const p = join(dir, 'goal.yaml');
  try { return existsSync(p) ? parseGreenRules(readFileSync(p, 'utf8')) : DEFAULT_GREEN_RULES; } catch { return DEFAULT_GREEN_RULES; }
}
