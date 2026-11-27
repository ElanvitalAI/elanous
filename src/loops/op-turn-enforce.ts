// OP turn-end enforcement (OP-STRUCTURAL item 1 · CEO 11-26 21:5x «구조적 문제도 고쳐주세요»).
//
// S: on build 2126 eln OP still ended pulse/idle turns with «21:57에 확인 / 21:58에 확인» and request mails — no state
//    change — although the turn opened with «NEXT ACTION (do it)» and the «did X (evidence)» contract.
// C: a prompt cannot make a model act. The planner already knows which actions a machine can do (assign · land tick ·
//    release run · goals · split request) and which need OP; the turn's opening plan is in op-next-action.jsonl.
// Q: when a turn ends having changed nothing, who does the pending work?
// A: decideEnforce() compares the turn's opening plan with a fresh plan at turn end. If OP changed no state in the turn
//    (fed-state facts by OP since the turn start, or the TUI's own progress flag), then:
//      • planner-owned actions still pending and unchanged → the ENGINE executes them now (live) and records
//        «engine did X because OP turn changed nothing»;
//      • OP-owned actions still pending → written to op-forced-next.json; the next plan puts them first as FORCED;
//      • the turn is recorded as a no-op (promise-only when it ended with «HH:MM에 확인»-style text) for the retro.
//    A turn that changed something is left alone (OP may be mid-way).
//
// 세 얼굴: 관측 = {stateRoot}/loops/op-turn-enforce.jsonl (one row per enforced turn) ⊕ the retro «턴 결과» lines ·
// 판단 근거 = opening keys vs fresh keys ⊕ OP state facts in the turn · 수복과 인계 = engine-run actuators now ⊕ the
// FORCED first action in the next pulse/idle turn.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NextAction } from './op-next-action.js';

/** A row of the opening plan (op-next-action.jsonl `actions[]`). */
export interface OpeningAction { readonly rule: string; readonly actor: string; readonly key: string; readonly status: string; readonly what?: string }
export interface ForcedNext { readonly key: string; readonly what: string; readonly reason: string; readonly at: string }

// 출처: 11-26 21:57/21:58 OP turn endings «21:57에 확인», «21:58에 확인» — a clock time followed by a check verb, Korean
// or English. A label for the retro only; the enforcement itself keys on state change, never on this text.
const PROMISE = /(?:\b\d{1,2}:\d{2}\s*(?:에|쯤|경|까지)?\s*(?:다시\s*)?(?:확인|점검|체크|보겠|볼게|재확인))|(?:\b(?:check|look|verify)\s+(?:again\s+)?(?:at|by)\s+\d{1,2}:\d{2})/iu;

/** Does the turn's reply end on a «I'll check at HH:MM» promise? */
export function promiseOnly(replyText: string): boolean {
  const tail = replyText.trim().split('\n').filter(l => l.trim()).slice(-3).join('\n');
  return PROMISE.test(tail);
}

const PENDING = new Set(['todo', 'failed', 'would']);

export interface EnforceDecision {
  readonly noop: boolean;
  /** Planner-owned actions pending since the turn opened, still in the fresh plan — the engine runs them now. */
  readonly execute: readonly NextAction[];
  /** OP/CEO-owned actions pending since the turn opened — the next plan opens with them. */
  readonly forced: readonly ForcedNext[];
}

/**
 * Pure. `opening` = the plan row the turn opened with (null = no plan was shown → only the no-op record). A turn with any
 * OP state change (`opStateChanges > 0` or the TUI's `tuiProgress`) is not enforced.
 */
export function decideEnforce(input: { opening: readonly OpeningAction[] | null; fresh: readonly NextAction[]; opStateChanges: number; tuiProgress: boolean;
  promise: boolean; now: Date }): EnforceDecision {
  const noop = input.opStateChanges === 0 && !input.tuiProgress;
  if (!noop || !input.opening) return { noop, execute: [], forced: [] };
  const pending = new Set(input.opening.filter(a => PENDING.has(a.status)).map(a => a.key));
  const still = input.fresh.filter(a => pending.has(a.key));
  const why = input.promise ? 'previous turn ended on «HH:MM에 확인» and changed nothing' : 'previous turn changed nothing';
  return {
    noop,
    execute: still.filter(a => a.actor === 'planner'),
    forced: still.filter(a => a.actor !== 'planner').map(a => ({ key: a.key, what: a.what, reason: why, at: input.now.toISOString() })),
  };
}

export const enforcePaths = (stateRoot: string) => ({
  ledger: join(stateRoot, 'loops', 'op-turn-enforce.jsonl'),
  forced: join(stateRoot, 'loops', 'op-forced-next.json'),
  plans: join(stateRoot, 'loops', 'op-next-action.jsonl'),
});

/** The plan row the turn opened with: the newest row written up to 2 min after the turn start, not older than 90 min. */
export function openingPlan(plansPath: string, turnStart: Date): OpeningAction[] | null {
  const hi = turnStart.getTime() + 2 * 60_000; const lo = turnStart.getTime() - 90 * 60_000;
  let best: { at: number; actions: OpeningAction[] } | null = null;
  try {
    for (const l of readFileSync(plansPath, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        const r = JSON.parse(l) as { at?: string; actions?: OpeningAction[] };
        const t = Date.parse(r.at ?? '');
        if (Array.isArray(r.actions) && t >= lo && t <= hi && (!best || t >= best.at)) best = { at: t, actions: r.actions };
      } catch { /* skip */ }
    }
  } catch { return null; }
  return best?.actions ?? null;
}

// 출처: one working stretch — a forced action older than this was overtaken by later plans and is dropped.
export const FORCED_TTL_MS = 6 * 3_600_000;

export function readForced(path: string, now: Date): ForcedNext[] {
  try {
    const rows = JSON.parse(readFileSync(path, 'utf8')) as ForcedNext[];
    return Array.isArray(rows) ? rows.filter(r => typeof r?.key === 'string' && now.getTime() - Date.parse(r.at) <= FORCED_TTL_MS) : [];
  } catch { return []; }
}

export function writeForced(path: string, rows: readonly ForcedNext[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, `${JSON.stringify(rows)}\n`); renameSync(tmp, path);
}

export function appendEnforce(path: string, row: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${JSON.stringify(row)}\n`);
}

/** Retro lines from the enforcement ledger for [since, until). */
export function enforceRetroLines(path: string, since: Date, until: Date): string[] {
  if (!existsSync(path)) return [];
  const rows: Array<{ at?: string; noop?: boolean; promise?: boolean; did?: string[]; forced?: string[] }> = [];
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l) as (typeof rows)[number]; const t = Date.parse(r.at ?? ''); if (t >= since.getTime() && t < until.getTime()) rows.push(r); } catch { /* skip */ }
  }
  const noop = rows.filter(r => r.noop);
  if (!noop.length) return [];
  const did = noop.flatMap(r => r.did ?? []); const forced = noop.flatMap(r => r.forced ?? []);
  return [`- 무동작 턴(엔진 판정): ${noop.length} · 약속만(«HH:MM에 확인») ${noop.filter(r => r.promise).length} · 엔진이 대신 한 일 ${did.length} · 다음 턴 강제 ${forced.length}`,
    ...did.slice(0, 5).map(d => `  engine did ${d}`)];
}
