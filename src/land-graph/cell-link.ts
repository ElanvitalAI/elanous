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
 * JUDGE-GREEN-PR-BINDING: the green side of the same rule — {@link prCellBinding} ⊕ {@link bindsCell} (below).
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
  const br = branchCellIds(pr.headRef, open.map(i => i.id));
  if (br.length === 1) return { id: br[0]!, basis: 'branch' };
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

/** Cell ids that appear in a head branch name (ids ≥ 6 chars · case-insensitive · word-bounded). Pure. */
export function branchCellIds(headRef: string | null | undefined, ids: Iterable<string>): string[] {
  if (!headRef) return [];
  const ref = headRef.toLowerCase();
  return [...ids].filter(id => id.length >= 6 && new RegExp(`(?<![a-z0-9])${esc(id.toLowerCase())}(?![a-z0-9])`).test(ref));
}

// ── JUDGE-GREEN-PR-BINDING (11-28 · eln OP caught 2 wrong greens · the day scan found 12 more) ─────────────────────────
// A cell's evidence that merely mentions «#N» never binds the PR to the cell: «#40622 is unrelated, NOT proof», the
// defect's own subject PR («#40606 merged without a receipt»), a sibling's PR. A PR counts for a cell on the PR's own
// word — its «칸» line · its title · its head branch · or the row its own post-merge sweep wrote (cell-link.jsonl attach /
// auto-cell · a cell registered from it, source «PR #N»). A «칸» line that names C while the title/branch name only other
// cells is a mislabelled PR (#40630: «칸: CONTEXT-BUS-FEDERATION», title/branch CURRENT-RELEASE-ONE-SOURCE) → not bound.
// JUDGE-GREEN-PR-BINDING-LEGACY (11-28 · butler greens 13/h → 2/h after #40647): a PR older than the «칸» convention says
// nothing about any cell (#40348 family · #40270 · #40268 · #38969) — for such a SILENT PR only, the cell's own evidence may
// bind it (`own-evidence`: {@link ownEvidenceCite}). An umbrella PR's labelled body list («등록 칸: A · B») binds the cells
// it lists (cell-line). Which bases count and the words: graphs/policies/pr-binding.yaml (src/land-graph/pr-binding.ts).
export type BindingBasis = 'cell-line' | 'title' | 'branch' | 'pipeline' | 'own-evidence';
export const BINDING_BASES: readonly BindingBasis[] = ['cell-line', 'title', 'branch', 'pipeline', 'own-evidence'];
export interface PrCellBinding {
  /** Cells on the PR body's «칸» lines (⊕ an umbrella's labelled list «등록 칸: A · B»). */
  readonly declared: readonly string[];
  /** Cells named as a whole token in the PR title. */
  readonly title: readonly string[];
  /** Cells in the head branch name. */
  readonly branch: readonly string[];
  /** Cells the PR's own post-merge pipeline attached it to / registered from it. */
  readonly pipeline: readonly string[];
  /** The PR body has a «칸» line at all (cells of any release, known or not) — the PR spoke for itself. */
  readonly selfDeclared: boolean;
  /** Cells whose own evidence cites the PR as its implementation (counts only while the PR is silent). */
  readonly evidence: readonly string[];
}
export type BindsCell = { readonly ok: true; readonly basis: BindingBasis } | { readonly ok: false; readonly why: string };

/** An umbrella PR's own list of the cells it covers — «- 등록 칸: A · B» · «하위 칸: …» · «자식 칸: …» · «포함 칸: …». Other
 *  labels («다음 칸» · «선행 칸» · «후속 칸») name cells the PR is NOT, so they never bind. */
const LIST_LINE = /^[ \t]*(?:[-*][ \t]*)?(?:\*\*)?(?:등록|하위|자식|포함)[ \t]+칸(?:\*\*)?[ \t]*[:：](.*)$/u;

/** What a PR says about itself, against the release's cell ids. Pure. */
export function prCellBinding(pr: { readonly title: string; readonly body?: string | null; readonly headRef?: string | null }, items: readonly Pick<ChecklistItem, 'id'>[], pipeline: readonly string[] = [],
  evidence: readonly string[] = []): PrCellBinding {
  const ids = new Set(items.map(i => i.id));
  const body = (pr.body ?? '').split(/\r?\n/u).map(l => { const m = LIST_LINE.exec(l); return m ? `칸: ${m[1]}` : l; }).join('\n');
  const refs = cellRefs({ title: '', body }, items);
  const declared = refs.found.map(f => f.id);
  const title = [...new Set((pr.title.match(ID_TOKEN) ?? []).filter(t => ids.has(t)))];
  return { declared, title, branch: branchCellIds(pr.headRef, ids), pipeline: [...new Set(pipeline)],
    selfDeclared: declared.length > 0 || refs.unknown.length > 0, evidence: [...new Set(evidence)] };
}

/** The PR said nothing about any cell — no «칸» line, no cell of the release in its title/branch/sweep (a legacy PR). */
export const silentPr = (b: PrCellBinding): boolean => !b.selfDeclared && !b.title.length && !b.branch.length && !b.pipeline.length;

/** Does the PR count for `cell`? Only the bases in `accept` count; a «칸» line that contradicts the title/branch never does. Pure. */
export function bindsCell(b: PrCellBinding, cell: string, accept: readonly BindingBasis[] = BINDING_BASES): BindsCell {
  const on = (basis: BindingBasis, list: readonly string[]) => accept.includes(basis) && list.includes(cell);
  if (on('title', b.title)) return { ok: true, basis: 'title' };
  if (on('branch', b.branch)) return { ok: true, basis: 'branch' };
  if (on('pipeline', b.pipeline)) return { ok: true, basis: 'pipeline' };
  const named = [...new Set([...b.title, ...b.branch])];
  if (on('cell-line', b.declared)) {
    if (named.length && !named.some(n => b.declared.includes(n))) return { ok: false, why: `«칸: ${cell}» but its title/branch name ${named.slice(0, 3).join(', ')} — mislabelled PR (fix its 칸 line)` };
    return { ok: true, basis: 'cell-line' };
  }
  if (on('own-evidence', b.evidence) && silentPr(b)) return { ok: true, basis: 'own-evidence' };
  const names = [...new Set([...b.declared, ...named, ...b.pipeline])];
  if (names.length) return { ok: false, why: `is ${names.slice(0, 3).join(', ')}'s PR` };
  if (b.selfDeclared) return { ok: false, why: 'declares a cell of another release (its «칸» line names no cell of this one)' };
  return { ok: false, why: 'declares no cell (no «칸:» line · title · branch)' };
}

// ── own-evidence (JUDGE-GREEN-PR-BINDING-LEGACY) ───────────────────────────────────────────────────────────────────────────
export type OwnAuthorRole = 'owner' | 'writer' | 'claimant' | 'owner-hand' | 'unattributed';
export interface OwnEvidencePolicy {
  readonly authors: readonly OwnAuthorRole[];
  /** Writers whose bare «#N» line is the post-merge sweep's own attach (land-graph). */
  readonly pipelineAuthors: readonly string[];
  /** Judges and anonymous writers: their clauses never bind (their denials still count). «X-*» = prefix. */
  readonly neverAuthors: readonly string[];
  /** Cells never bound by their evidence («*-E4»: an E4 cell closes on its own evidence run — its evidence cites the parent's PR). */
  readonly excludeCells: readonly string[];
  readonly implementation: readonly string[];
  readonly negation: readonly string[];
}
/** One evidence write of a cell (features.sqlite events · field evidence / evidence.add · every release, in time order). */
export interface EvidenceWrite { readonly at: string; readonly by: string; readonly text: string }
/** The cell's own seats from its history: claim/add targets and writer events (any release). */
export interface CellTrail { readonly writes: readonly EvidenceWrite[]; readonly claimants: readonly string[]; readonly writers: readonly string[] }
export interface OwnCell { readonly id: string; readonly title?: string; readonly owner?: string; readonly writer?: { readonly seat: string } | string; readonly evidence?: string }
export type OwnCite = { readonly kind: 'cites'; readonly by: string; readonly clause: string } | { readonly kind: 'none'; readonly why: string };

/** The writer of a checklist write made without ELANOUS_TRACK (src/release-loop/checklist.ts · release-checklist-set-cli). */
export const UNATTRIBUTED = 'cli';
const CLAUSE_SPLIT = /\s+·\s+|;\s*|。\s*|\.\s+/u;
/** Lines (newline · ⏎) → clauses (« · » · «;» · «. »). Pure. */
export const evidenceClauses = (text: string): string[] => text.split(/\r?\n|⏎/u).flatMap(l => l.split(CLAUSE_SPLIT)).map(c => c.trim()).filter(Boolean);
const prRe = (pr: number) => new RegExp(`(?<![A-Za-z0-9_&#/])#${pr}(?![0-9])|\\bpull/${pr}\\b|PREGATE-GREEN/${pr}-`, 'u');
const seatOf = (owner: string | undefined): string | null => { const s = (owner ?? '').split('/')[0]!.trim(); return s || null; };
/** «X-*» = prefix · «*-X» = suffix · else exact. */
const matchesSeat = (seat: string, pat: string): boolean => pat.endsWith('*') ? seat.startsWith(pat.slice(0, -1)) : pat.startsWith('*') ? seat.endsWith(pat.slice(1)) : seat === pat;
const has = (clause: string, words: readonly string[]): string | null => { const c = clause.toLowerCase(); return words.find(w => c.includes(w.toLowerCase())) ?? null; };

/** «cites the PR as its implementation»: a policy word, or a built-in shape — «#N <sha>» · «#N@<sha>» · «head <sha>» ·
 *  «PREGATE-GREEN/N-» · a bare «#N» / «PR #N» line. Pure. */
export function implementationClause(clause: string, pr: number, words: readonly string[]): boolean {
  if (has(clause, words)) return true;
  if (new RegExp(`^(?:PR\\s*)?#${pr}$`, 'iu').test(clause.replace(/[\s.,:;]+$/u, '').trim())) return true;
  if (new RegExp(`#${pr}(?:\\s+|@)[0-9a-f]{7,40}\\b`, 'u').test(clause) || new RegExp(`PREGATE-GREEN/${pr}-[0-9a-f]{12}`, 'u').test(clause)) return true;
  return /\bhead\s+[0-9a-f]{7,40}\b/iu.test(clause);
}

/** Does `cell`'s own evidence cite PR `pr` as its implementation? Every clause of the CURRENT evidence that cites the PR is
 *  attributed to the earliest write (any release) that carried it; a clause by an own seat that carries an implementation
 *  word/shape and no negation word cites it (a negation counts inside its own clause only — «#40622는 무관한 병합 PWA PR»). Pure. */
export function ownEvidenceCite(cell: OwnCell, pr: number, trail: CellTrail | undefined, policy: OwnEvidencePolicy): OwnCite {
  const ref = prRe(pr);
  if (policy.excludeCells.some(p => matchesSeat(cell.id, p))) return { kind: 'none', why: 'cell kind is never bound by its evidence (own_evidence.exclude_cells)' };
  if (cell.id.includes(String(pr)) || ref.test(cell.title ?? '')) return { kind: 'none', why: `#${pr} is the cell's subject (its id/title names it)` };
  const clauses = evidenceClauses(cell.evidence ?? '').filter(c => ref.test(c));
  if (!clauses.length) return { kind: 'none', why: 'evidence does not cite it' };
  if (!trail) return { kind: 'none', why: 'evidence authorship unknown (no history)' };
  const firstBy = new Map<string, string>();
  for (const w of trail.writes) for (const c of evidenceClauses(w.text)) if (!firstBy.has(c)) firstBy.set(c, w.by);
  const owner = seatOf(cell.owner);
  const writerSeat = typeof cell.writer === 'string' ? cell.writer : cell.writer?.seat;
  const own = (by: string): boolean => {
    if (policy.neverAuthors.some(p => matchesSeat(by, p))) return false;
    const a = policy.authors;
    return (a.includes('owner') && by === owner) || (a.includes('writer') && (by === writerSeat || trail.writers.includes(by)))
      || (a.includes('claimant') && trail.claimants.includes(by)) || (a.includes('owner-hand') && !!owner && by.startsWith(`${owner}-H-`))
      || (a.includes('unattributed') && by === UNATTRIBUTED);
  };
  let denied: { by: string; word: string } | null = null;
  for (const clause of clauses) {
    const by = firstBy.get(clause) ?? null;
    const word = has(clause, policy.negation);
    if (word) { denied ??= { by: by ?? '?', word }; continue; }
    if (!by) continue;
    const bare = new RegExp(`^(?:PR\\s*)?#${pr}$`, 'iu').test(clause.replace(/[\s.,:;]+$/u, '').trim());
    if ((own(by) || (bare && policy.pipelineAuthors.includes(by))) && implementationClause(clause, pr, policy.implementation)) return { kind: 'cites', by, clause };
  }
  return { kind: 'none', why: denied ? `every own clause citing it is negated («${denied.word}» · ${denied.by})` : 'no implementation clause by the cell\'s own seat' };
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
