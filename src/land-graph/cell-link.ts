/**
 * LAND-CELL-LINK (OP 11-27): 3 of the last 5 lands cited no current-release cell, so landing never turned a cell green.
 * The land tick links every ready PR to its cell of the release in play (`release.graph.version`) before the merge:
 *   already  — some cell's evidence already cites #PR
 *   cell-line / title-strong — the landed-but-yellow matcher (body «칸: ID» line · title starting with the id)
 *   branch   — the cell id appears in the head branch name (ids ≥ 6 chars · case-insensitive · word-bounded)
 *   cell-ref — LAND-CELL-LINK-ALWAYS (11-27 11:13 · 13 of 16 lands cited no cell): the «칸» line as hands really write it —
 *              «칸: 닫음: ID (…)» · «칸: **ID** 후속» · «칸: A · B · C 후속 (…)» · «Closes: ID» — every token before the first «(» that
 *              is a checklist id (or the unique id it is a «-»-prefix of: «LAND-STEWARD» → LAND-STEWARD-LOOP-AGENT)
 *   title    — a checklist id appears as a whole token anywhere in the title («fix(x): ID — …» · «… (ID)»)
 *   branch   — the cell id appears in the head branch name (ids ≥ 6 chars · case-insensitive · word-bounded)
 *   files    — exactly one open cell's evidence names one of the PR's non-test files
 * No match → the plan lists the PR as «landed-no-cell» (it still lands: the cell link never blocks a land).
 * A mere body mention is never a link (a PR that discusses three cells closes none of them).
 */
import type { ChecklistItem } from '../release-loop/checklist.js';
import { landedButYellow } from '../release-loop/landed-but-yellow.js';
import type { PrInfo } from './land-graph.js';

export type CellBasis = 'already' | 'cell-line' | 'title-strong' | 'cell-ref' | 'title' | 'branch' | 'files';
export interface CellMatch { id: string; basis: CellBasis }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isTest = (f: string) => /\.(test|spec|e2e)\.[cm]?[jt]sx?$/.test(f) || f.startsWith('test/') || /(^|\/)fixtures?\//.test(f);

export function matchCell(pr: PrInfo, items: readonly ChecklistItem[]): CellMatch | null {
  const ref = new RegExp(`(?<![A-Za-z0-9_#])#${pr.number}(?![A-Za-z0-9_])`);
  const cited = items.find(i => ref.test(i.evidence ?? ''));
  if (cited) return { id: cited.id, basis: 'already' };
  const open = items.filter(i => i.status === 'yellow' || i.status === 'red');
  const rows = landedButYellow(open, [{ number: pr.number, title: pr.title, body: pr.body ?? '', mergedAt: '' }]);
  for (const basis of ['cell-line', 'title-strong'] as const) {
    const hit = rows.find(r => r.prs.some(p => p.basis === basis));
    if (hit) return { id: hit.id, basis };
  }
  const refs = cellRefs(pr, items);
  const refOpen = refs.found.find(r => open.some(i => i.id === r.id));
  if (refOpen) return { id: refOpen.id, basis: refOpen.basis };
  if (pr.headRef) {
    const br = open.filter(i => i.id.length >= 6 && new RegExp(`(?<![a-z0-9])${esc(i.id.toLowerCase())}(?![a-z0-9])`).test(pr.headRef!.toLowerCase()));
    if (br.length === 1) return { id: br[0]!.id, basis: 'branch' };
  }
  const code = pr.files.filter(f => !isTest(f) && !f.endsWith('.md'));
  if (code.length) {
    const byFiles = open.filter(i => code.some(f => (i.evidence ?? '').includes(f)));
    if (byFiles.length === 1) return { id: byFiles[0]!.id, basis: 'files' };
  }
  return null;
}

/** Uppercase cell-id-shaped tokens (≥ 1 «-»): THROTTLE-AUDIT · TSC-AFFECTED-ROOTS-1. */
const ID_TOKEN = /(?<![A-Za-z0-9_-])[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+(?![A-Za-z0-9_-])/gu;
/** A «칸» line as written in PR bodies: «칸: …» · «- **칸**: …» · «닫음: …» · «Cell(s): …» · «Closes: …». */
const REF_LINE = /^[ \t]*(?:[-*][ \t]*)?(?:\*\*)?(?:칸|닫음|cells?|closes?)(?:\*\*)?(?:[ \t]*[:：]|[ \t]+)(.*)$/iu;

export interface CellRefs {
  /** Checklist cells the PR names (deduped · in order). */
  found: Array<{ id: string; basis: 'cell-ref' | 'title' }>;
  /** Id-shaped tokens on a «칸» line that are not cells of this release (unregistered or misspelled). */
  unknown: string[];
}

/** Cells a PR names on its «칸» lines (strong) and in its title (whole token). Pure. */
export function cellRefs(pr: Pick<PrInfo, 'title' | 'body'>, items: readonly Pick<ChecklistItem, 'id'>[]): CellRefs {
  const ids = new Set(items.map(i => i.id));
  const found: CellRefs['found'] = []; const unknown: string[] = [];
  const add = (id: string, basis: 'cell-ref' | 'title') => { if (!found.some(f => f.id === id)) found.push({ id, basis }); };
  for (const line of (pr.body ?? '').split(/\r?\n/u)) {
    const m = REF_LINE.exec(line);
    if (!m) continue;
    const head = m[1]!.split(/[(（]/u)[0]!.replace(/\*\*/gu, ' ');
    // «닫음:» may follow «칸:» on the same line — the head is scanned whole, so both forms read the same.
    for (const tok of head.match(ID_TOKEN) ?? []) {
      if (ids.has(tok)) { add(tok, 'cell-ref'); continue; }
      const pre = [...ids].filter(id => id.startsWith(`${tok}-`));
      if (pre.length === 1) add(pre[0]!, 'cell-ref');
      else if (!unknown.includes(tok)) unknown.push(tok);
    }
  }
  for (const tok of pr.title.match(ID_TOKEN) ?? []) if (ids.has(tok)) add(tok, 'title');
  return { found, unknown: unknown.filter(u => !found.some(f => f.id === u)) };
}

export type MergedLinkAction = 'linked' | 'attach' | 'already-green' | 'unregistered' | 'unmatched';
export interface MergedLink {
  action: MergedLinkAction;
  /** Cells this merge belongs to: `attach` = open cells to cite it on · `cited` = already cite it · `green` = green, not citing. */
  attach: Array<{ id: string; basis: CellBasis }>;
  cited: string[];
  green: string[];
  unknown: string[];
}

/** Every cell a MERGED PR belongs to (a PR may close several) — the post-merge sweep's matcher. Pure. */
export function matchMerged(pr: PrInfo, items: readonly ChecklistItem[]): MergedLink {
  const ref = new RegExp(`(?<![A-Za-z0-9_#])#${pr.number}(?![A-Za-z0-9_])`);
  const cited = items.filter(i => ref.test(i.evidence ?? '')).map(i => i.id);
  const byId = new Map(items.map(i => [i.id, i] as const));
  const isOpen = (id: string) => { const s = byId.get(id)?.status; return s === 'yellow' || s === 'red'; };
  const refs = cellRefs(pr, items);
  const attach: MergedLink['attach'] = []; const green: string[] = [];
  const take = (id: string, basis: CellBasis) => {
    if (cited.includes(id) || attach.some(a => a.id === id) || green.includes(id)) return;
    if (isOpen(id)) attach.push({ id, basis }); else if (byId.has(id)) green.push(id);
  };
  // «칸» lines name the cells outright (all of them); the title only when no «칸» line named one.
  const strong = refs.found.filter(f => f.basis === 'cell-ref');
  for (const f of strong.length ? strong : refs.found) take(f.id, f.basis);
  if (!attach.length && !cited.length && !green.length) {
    const m = matchCell(pr, items);
    if (m && m.basis !== 'already') take(m.id, m.basis);
  }
  const action: MergedLinkAction = attach.length ? 'attach' : cited.length ? 'linked' : green.length ? 'already-green' : refs.unknown.length ? 'unregistered' : 'unmatched';
  return { action, attach, cited, green, unknown: refs.unknown };
}
