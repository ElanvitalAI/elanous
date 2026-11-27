/**
 * LAND-CELL-LINK-ALWAYS (0.3.38 P0 · OP 11-27 11:13 fed analysis): 13 of 16 lands in an hour cited no 0.3.38 cell, three
 * cycles in a row → greens 3/h while lands 16/h.
 * S: the cell link (#40350) lived only inside the land graph's own land branch, so lands by op-direct-land-v2 / coach-land /
 *    `pr land` / TA never linked (20 of 46 merges on 11-27 morning) — and its «칸» matcher wanted a line holding only ids,
 *    while hands write «칸: 닫음: ID (…)» / «칸: **ID** 후속».
 * C: green stays ONE definition (판정 집사 · GREEN-DEFINITION-ONE): this step only cites the PR on the cell; the butler signs on
 *    its next wake (it wakes on a checklist change). No new gate: nothing here refuses or delays a land.
 * Q: how does every merge to main reach its cell, whatever path merged it?
 * A: one post-merge sweep over main (the land steward's tick runs it after the body tick; `eln land steward cell-link` runs it
 *    by hand / as a backfill): merged PRs since the cursor → {@link matchMerged} → `evidence add #PR` on each open cell →
 *    the butler's done-when for that cell: met → nothing to say (the butler signs) · not met → ONE line to the cell owner
 *    naming what is missing · no cell → ONE line to OP (land-graph is a machine sender: it folds into the 30-min OP digest).
 *    CELLLESS-PR-AUTO-CELL (0.3.38 P1): with a `register` port the no-cell merge first gets an auto-registered cell
 *    (src/land-graph/auto-cell.ts · policy graphs/loop-agents/land-steward/cell-auto.yaml) → evidence #PR → one OP digest line;
 *    the plain «no cell» line stays only for a skipped / refused auto-cell.
 *
 * 세 얼굴: 관측 = <stateRoot>/land-graph/cell-link.jsonl (one row per merged PR: action · cells · basis) ⊕ the steward report's
 * `cellLink` summary · 판단 근거 = {@link matchMerged} (structured: «칸» line ids · title token · branch · files) ·
 * 수복과 인계 = unmatched → OP digest line «register the cell or add a 칸: line»; missing done-when → the owner's line.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChecklistAddInput, ChecklistItem } from '../release-loop/checklist.js';
import { planAutoCell, type AutoCellPolicy } from './auto-cell.js';
import { matchMerged, type MergedLink } from './cell-link.js';
import { landHome, type PrInfo } from './land-graph.js';

export interface MergedPr extends PrInfo { mergedAt: string }
export type DoneWhen = { kind: 'sign' } | { kind: 'security' } | { kind: 'missing'; missing: readonly string[] } | null;

export interface SweepDeps {
  now(): Date;
  stateRoot: string;
  /** PRs merged into main at or after `sinceIso` (oldest first is not required). */
  listMerged(sinceIso: string): MergedPr[] | Promise<MergedPr[]>;
  /** The release in play and its cells · null = no release.graph.version (the sweep skips, it never guesses). */
  checklist(): { version: string; items: ChecklistItem[] } | null;
  attach(version: string, cell: string, pr: number): void;
  /** The butler's done-when for a cell right after the attach (null = unknown → no owner line). */
  doneWhen?(version: string, cell: string): DoneWhen;
  post(to: string, body: string): void;
  /** CELLLESS-PR-AUTO-CELL: register a cell in the release (throws when the ledger refuses the id). Absent = no auto-cell. */
  register?(version: string, input: ChecklistAddInput): void;
  /** The auto-cell policy (graphs/loop-agents/land-steward/cell-auto.yaml). Throws → the sweep falls back to the OP line. */
  autoCellPolicy?(): AutoCellPolicy;
  dry?: boolean;
  /** First run without a cursor looks back this far (default 60 min). */
  lookbackMin?: number;
  /** Explicit window start (backfill) — overrides the cursor. */
  since?: string;
}

export interface SweepRow { pr: number; mergedAt: string; action: MergedLink['action'] | 'attach-failed' | 'auto-cell'; cells: string[]; basis?: string; unknown?: string[]; why?: string; notified?: string[] }
export interface SweepReport { version: string | null; since: string; scanned: number; rows: SweepRow[]; counts: Record<string, number>; posted: string[]; error?: string }

interface SweepState { cursor?: string; done: Record<string, string> }
const statePath = (s: string) => join(landHome(s), 'cell-link-state.json');
const rowsPath = (s: string) => join(landHome(s), 'cell-link.jsonl');
/** Re-list a little before the cursor: GitHub's search index lags a merge by up to a few minutes. */
const OVERLAP_MS = 15 * 60_000;
const KEEP_DONE_MS = 3 * 86_400_000;

function readState(s: string): SweepState {
  try { const v = JSON.parse(readFileSync(statePath(s), 'utf8')) as SweepState; return { ...v, done: v.done ?? {} }; } catch { return { done: {} }; }
}
function writeState(s: string, st: SweepState): void {
  mkdirSync(landHome(s), { recursive: true });
  const tmp = `${statePath(s)}.tmp`;
  writeFileSync(tmp, JSON.stringify(st));
  renameSync(tmp, statePath(s));
}

export async function sweepMainCellLinks(d: SweepDeps): Promise<SweepReport> {
  const now = d.now();
  const st = readState(d.stateRoot);
  const since = d.since ?? (st.cursor ? new Date(Date.parse(st.cursor) - OVERLAP_MS).toISOString() : new Date(now.getTime() - (d.lookbackMin ?? 60) * 60_000).toISOString());
  const empty = (error?: string): SweepReport => ({ version: null, since, scanned: 0, rows: [], counts: {}, posted: [], ...(error ? { error } : {}) });
  const cl = (() => { try { return d.checklist(); } catch { return null; } })();
  if (!cl || !cl.items.length) return empty('no release.graph.version checklist');
  let merged: MergedPr[];
  try { merged = await d.listMerged(since); } catch (e) { return { ...empty(`list merged failed: ${String(e).slice(0, 160)}`), version: cl.version }; }
  merged = merged.filter(p => Date.parse(p.mergedAt) >= Date.parse(since)).sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  const rows: SweepRow[] = []; const posted: string[] = [];
  let items = cl.items;
  const unmatched: SweepRow[] = [];
  let policy: AutoCellPolicy | null = null; let policyError: string | undefined;
  if (d.register && d.autoCellPolicy) { try { policy = d.autoCellPolicy(); } catch (e) { policyError = String(e instanceof Error ? e.message : e).slice(0, 160); } }
  for (const pr of merged) {
    const seen = !!st.done[String(pr.number)];
    if (!d.since && seen) continue; // the cursor overlap re-lists: one row per PR, ever
    const m = matchMerged(pr, items);
    const row: SweepRow = { pr: pr.number, mergedAt: pr.mergedAt, action: m.action, cells: [...m.attach.map(a => a.id), ...m.cited, ...m.green] };
    if (m.attach.length) row.basis = [...new Set(m.attach.map(a => a.basis))].join(',');
    if (m.unknown.length) row.unknown = m.unknown;
    if (m.action === 'attach' && !d.dry) {
      const failed: string[] = []; const notified: string[] = [];
      for (const a of m.attach) {
        try { d.attach(cl.version, a.id, pr.number); } catch (e) { failed.push(`${a.id}: ${String(e).slice(0, 80)}`); continue; }
        const cell = items.find(i => i.id === a.id);
        items = items.map(i => (i.id === a.id ? { ...i, evidence: `${i.evidence ? `${i.evidence}\n` : ''}#${pr.number}` } : i));
        const v = (() => { try { return d.doneWhen?.(cl.version, a.id) ?? null; } catch { return null; } })();
        if (v?.kind === 'missing' && cell?.owner) {
          const line = `[land-graph · cell] #${pr.number} merged → ${a.id} cites it · not green yet: ${v.missing.join(' · ').slice(0, 220)} — fill it and 판정 집사 signs on its next wake`;
          d.post(cell.owner, line); posted.push(`${cell.owner} ${line}`); notified.push(cell.owner);
        }
      }
      if (failed.length) { row.action = 'attach-failed'; row.why = failed.join(' · '); }
      if (notified.length) row.notified = notified;
    }
    if ((m.action === 'unmatched' || m.action === 'unregistered') && policy && d.register) {
      // CELLLESS-PR-AUTO-CELL — idempotent on the PR number: a cell this PR already auto-registered (source «PR #N») is reused.
      const mine = items.find(i => i.source === `PR #${pr.number}`);
      const plan = mine ? null : planAutoCell(pr, items, policy, m.unknown);
      if (mine || plan?.kind === 'register') {
        let id = mine?.id ?? (plan as Extract<typeof plan, { kind: 'register' }>).input.id;
        const why: string[] = [];
        if (!d.dry && !mine && plan?.kind === 'register') {
          try { d.register(cl.version, plan.input); } catch (e1) {
            try { d.register(cl.version, { ...plan.input, id: plan.fallbackId }); id = plan.fallbackId; } catch (e2) { why.push(`register refused: ${String(e1).slice(0, 80)} · ${String(e2).slice(0, 80)}`); }
          }
          if (!why.length) items = [...items, { ...plan.input, status: 'yellow', updatedAt: now.toISOString(), updatedBy: 'land-graph' } as ChecklistItem];
        }
        if (!why.length && !d.dry) { try { d.attach(cl.version, id, pr.number); } catch (e) { why.push(`attach: ${String(e).slice(0, 80)}`); } }
        if (!why.length) {
          row.action = 'auto-cell'; row.cells = [id];
          if (plan?.kind === 'register') row.basis = `${plan.idFrom},owner:${plan.ownerFrom}`;
          items = items.map(i => (i.id === id ? { ...i, evidence: `${i.evidence ? `${i.evidence}\n` : ''}#${pr.number}` } : i));
          if (!mine && plan?.kind === 'register') {
            const line = `[land-graph · auto-cell] #${pr.number} «${pr.title.slice(0, 70)}» had no ${cl.version} cell → registered ${id} (owner ${plan.input.owner} · ${plan.input.priority} · evidence #${pr.number}) — 판정 집사 signs it on its next wake`;
            if (!d.dry) d.post(policy.digest.to, line);
            posted.push(`${policy.digest.to} ${line}`);
          }
        } else if (!d.dry) { row.action = 'attach-failed'; row.why = why.join(' · '); }
      } else if (plan?.kind === 'skip') row.why = `auto-cell skipped: ${plan.why}`;
    } else if ((m.action === 'unmatched' || m.action === 'unregistered') && policyError) row.why = `auto-cell policy: ${policyError}`;
    if ((row.action === 'unmatched' || row.action === 'unregistered') && !seen) unmatched.push(row); // a backfill never re-posts
    rows.push(row);
    if (!d.dry && row.action !== 'attach-failed') st.done[String(pr.number)] = pr.mergedAt;
  }
  // One line per unmatched merge into the OP digest (land-graph is a machine sender → folded into the 30-min digest).
  for (const r of unmatched) {
    const pr = merged.find(p => p.number === r.pr)!;
    const line = r.action === 'unregistered'
      ? `[land-graph · no cell] #${r.pr} «${pr.title.slice(0, 70)}» names ${r.unknown!.slice(0, 3).join(', ')} — not a ${cl.version} cell: register it (eln release checklist add) or fix the 칸: line`
      : `[land-graph · no cell] #${r.pr} «${pr.title.slice(0, 70)}» merged with no ${cl.version} cell — add «칸: <ID>» or cite it: eln release checklist evidence add <ID> --version ${cl.version} '#${r.pr}'`;
    if (!d.dry) d.post('OP', line);
    posted.push(`OP ${line}`);
  }
  if (!d.dry) {
    const cut = now.getTime() - KEEP_DONE_MS;
    for (const [k, at] of Object.entries(st.done)) if (Date.parse(at) < cut) delete st.done[k];
    const last = merged.at(-1)?.mergedAt;
    if (!d.since && last && (!st.cursor || last > st.cursor)) st.cursor = last;
    else if (!d.since && !st.cursor) st.cursor = since;
    writeState(d.stateRoot, st);
    if (rows.length) {
      mkdirSync(landHome(d.stateRoot), { recursive: true });
      appendFileSync(rowsPath(d.stateRoot), rows.map(r => JSON.stringify({ at: now.toISOString(), version: cl.version, ...r })).join('\n') + '\n');
    }
  }
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.action] = (counts[r.action] ?? 0) + 1;
  return { version: cl.version, since, scanned: merged.length, rows, counts, posted };
}

export function readSweepRows(stateRoot: string): Array<SweepRow & { at: string; version: string }> {
  if (!existsSync(rowsPath(stateRoot))) return [];
  return readFileSync(rowsPath(stateRoot), 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}

export function formatSweep(r: SweepReport): string {
  if (r.error) return `cell-link: ${r.error}`;
  const c = Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(' · ') || 'nothing new';
  return [`cell-link ${r.version} since ${r.since.slice(0, 16)}Z · merged ${r.scanned} · ${c}`,
    ...r.rows.map(x => `  #${x.pr} ${x.action}${x.cells.length ? ` ${x.cells.join(',')}` : ''}${x.basis ? ` (${x.basis})` : ''}${x.unknown?.length ? ` unknown ${x.unknown.join(',')}` : ''}${x.why ? ` · ${x.why}` : ''}`)].join('\n');
}
