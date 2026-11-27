// FED-FACT-OP-ACTIONS (0.3.38 P1 · OP 11-27) — state-changing coordinator actions as fed facts, and the 6-axis «성과» reader.
//
// S: eln OP's assignments (seat assign), vetoes / reassigns (seat veto), decisions (msg hand resolve · decisions raise/decide)
//    left no fed fact — the ledger showed only mail:ack, so the 30-min analysis scored OP's 성과 1 three times in a row.
// C: one ledger (fed-state/ledger.ts · fail-open) · one reader · no new gate: a ledger fault never breaks the action.
// A: each CLI entry point appends one `by=<actor seat>` fact on success (`recordAction`) — cell:assign · cell:veto ·
//    cell:reassign · decision:<verb> · hold:* (the hold ledger already writes those) — and `seatAchievement` counts them
//    against graphs/policies/fed-rubric.yaml.
// 세 얼굴: 관측 = facts.jsonl rows (source seat-assign · seat-veto · msg-hand · decisions) ⊕ `eln fed kpi` «OP actions» line ·
// 판단 근거 = the YAML count list + steps (pure `seatAchievement`) · 수복과 인계 = fail-open writer; the analysis reads the line.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { type Fact, recordFact } from './ledger.js';

export type ActionKind = 'assign' | 'veto' | 'reassign' | 'decision';

/** One coordinator action → one fed fact (fail-open: false on any fault, never throws). */
export function recordAction(a: { kind: ActionKind; by: string; cell?: string; to?: string; ref?: string; verb?: string; why?: string; source: string; ts?: string }, path?: string): boolean {
  try {
    const by = a.by.trim().toUpperCase();
    if (!by) return false;
    const isCell = a.kind !== 'decision';
    return recordFact({
      type: isCell ? 'cell' : 'decision', state: isCell ? a.kind : (a.verb ?? 'decide'), seat: by, decidedBy: by,
      ...(a.cell ? { cell: a.cell } : {}), ...(a.to ? { to: a.to.trim().toUpperCase() } : {}), ...(a.ref ? { ref: a.ref } : {}),
      ...(a.why ? { kind: a.why.replace(/\s+/gu, ' ').slice(0, 120) } : {}), ...(a.ts ? { ts: a.ts } : {}), source: a.source,
    }, path);
  } catch { return false; }
}

export interface RubricPolicy { count: string[]; steps: number[] }

export const fedRubricPath = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'policies', 'fed-rubric.yaml');

/** Parse + validate (pure). A malformed policy throws — never silently defaulted. */
export function parseRubricPolicy(text: string): RubricPolicy {
  const y = (parse(text) ?? {}) as { achievement?: { count?: unknown; actions_per_hour_steps?: unknown } };
  const a = y.achievement ?? {};
  const count = a.count;
  if (!Array.isArray(count) || !count.length || count.some(c => typeof c !== 'string' || !/^[a-z]+:(\*|[a-z-]+)$/u.test(c))) throw new Error('fed-rubric: achievement.count must list «type:state» or «type:*»');
  const steps = a.actions_per_hour_steps;
  if (!Array.isArray(steps) || steps.length !== 4 || steps.some((s, i) => typeof s !== 'number' || s <= 0 || (i > 0 && s <= (steps[i - 1] as number)))) throw new Error('fed-rubric: achievement.actions_per_hour_steps must be 4 increasing positive numbers');
  return { count: count as string[], steps: steps as number[] };
}

export function loadRubricPolicy(path = fedRubricPath()): RubricPolicy {
  if (!existsSync(path)) throw new Error(`fed-rubric policy missing: ${path}`);
  return parseRubricPolicy(readFileSync(path, 'utf8'));
}

export interface SeatAchievement { seat: string; actions: number; perHour: number; byKind: Record<string, number>; score: number }

const round1 = (n: number) => Math.round(n * 10) / 10;

/** 성과 for one seat over [start, end): facts it decided that the policy counts (pure). */
export function seatAchievement(facts: readonly Fact[], seat: string, start: Date, end: Date, p: RubricPolicy): SeatAchievement {
  const s = seat.toUpperCase();
  const hours = Math.max((end.getTime() - start.getTime()) / 3_600_000, 1e-9);
  const counted = (f: Fact) => p.count.some(c => { const [t, st] = c.split(':'); return f.type === t && (st === '*' || f.state === st); });
  const byKind: Record<string, number> = {};
  let actions = 0;
  for (const f of facts) {
    const t = Date.parse(f.ts);
    if (!(t >= start.getTime() && t < end.getTime())) continue;
    if ((f.decidedBy ?? f.seat)?.toUpperCase() !== s || !counted(f)) continue;
    const k = `${f.type}:${f.state ?? '-'}`;
    byKind[k] = (byKind[k] ?? 0) + 1; actions++;
  }
  const perHour = actions / hours;
  return { seat: s, actions, perHour: round1(perHour), byKind, score: 1 + p.steps.filter(x => perHour >= x).length };
}
