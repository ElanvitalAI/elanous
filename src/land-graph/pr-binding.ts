/**
 * JUDGE-GREEN-PR-BINDING — the ONE «which merged PR counts for a cell» for both green lanes (kit · plugin-first):
 *   green-triage (src/release-loop/green-triage.ts — every live lane) and the judge butler (src/judge-butler/done-when.ts).
 * Both build a PR's binding with {@link bindingOf} from the same facts — the PR's cached title/body/branch (the butler's
 * merged-PR cache · gh pr view once per PR), its post-merge sweep rows (land-graph cell-link.jsonl), the cells' evidence
 * trail (features.sqlite events) — and split a cell's cited PRs with {@link boundPrs}. Words and bases:
 * graphs/policies/pr-binding.yaml ({@link loadPrBindingPolicy} · built-in fallback below, kept in step).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ChecklistItem } from '../release-loop/checklist.js';
import { BINDING_BASES, bindsCell, ownEvidenceCite, prCellBinding, type BindingBasis, type CellTrail, type OwnAuthorRole, type OwnCell, type OwnEvidencePolicy, type PrCellBinding } from './cell-link.js';

export interface PrBindingPolicy { readonly bases: readonly BindingBasis[]; readonly ownEvidence: OwnEvidencePolicy }
const AUTHOR_ROLES: readonly OwnAuthorRole[] = ['owner', 'writer', 'claimant', 'owner-hand', 'unattributed'];

/** Built-in fallback — used only when graphs/policies/pr-binding.yaml is missing or malformed. Keep in step with the YAML. */
export const PR_BINDING_FALLBACK: PrBindingPolicy = {
  bases: BINDING_BASES,
  ownEvidence: {
    authors: AUTHOR_ROLES, pipelineAuthors: ['land-graph'], neverAuthors: ['JUDGE-BUTLER', 'JUD', 'JUD-*'], excludeCells: ['*-E4'],
    implementation: ['merged', '병합', '착지', 'landed', 'implementing', 'implements', 'implemented', '구현', '수리 PR', 'fix PR'],
    negation: ['무관', '미병합', 'not merged', 'unmerged', 'unrelated', 'not proof', 'irrelevant', '관련 없', '아님', '아니다', '아니며', '아니라', '아니고', '아닌',
      'not this cell', 'not the fix', '선행', 'precursor', 'predecessor', '대상 PR', 'subject PR', '겹침', 'overlap', '별개', '출처'],
  },
};
export const prBindingPolicyPath = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'policies', 'pr-binding.yaml');

const strList = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || !v.length || !v.every(x => typeof x === 'string' && x.trim())) throw new Error(`pr-binding policy: ${what} must be a non-empty list of strings`);
  return v.map(x => (x as string).trim());
};
/** Parse + validate (pure). Throws on a malformed policy (the caller falls back). */
export function parsePrBindingPolicy(text: string): PrBindingPolicy {
  const y = (parseYaml(text) ?? {}) as { bases?: unknown; own_evidence?: Record<string, unknown> };
  const bases = strList(y.bases, 'bases');
  const bad = bases.filter(b => !BINDING_BASES.includes(b as BindingBasis));
  if (bad.length) throw new Error(`pr-binding policy: unknown bases ${bad.join(', ')}`);
  const o = y.own_evidence ?? {};
  const authors = strList(o.authors, 'own_evidence.authors');
  const badA = authors.filter(a => !AUTHOR_ROLES.includes(a as OwnAuthorRole));
  if (badA.length) throw new Error(`pr-binding policy: unknown own_evidence.authors ${badA.join(', ')}`);
  return { bases: bases as BindingBasis[], ownEvidence: {
    authors: authors as OwnAuthorRole[], pipelineAuthors: Array.isArray(o.pipeline_authors) ? strList(o.pipeline_authors, 'own_evidence.pipeline_authors') : [],
    neverAuthors: strList(o.never_authors, 'own_evidence.never_authors'),
    excludeCells: Array.isArray(o.exclude_cells) ? strList(o.exclude_cells, 'own_evidence.exclude_cells') : [], implementation: strList(o.implementation, 'own_evidence.implementation'),
    negation: strList(o.negation, 'own_evidence.negation') } };
}
/** The ONE policy (graphs/policies/pr-binding.yaml); unreadable/malformed → the built-in fallback. */
export function loadPrBindingPolicy(path = prBindingPolicyPath()): PrBindingPolicy {
  try { return parsePrBindingPolicy(readFileSync(path, 'utf8')); } catch { return PR_BINDING_FALLBACK; }
}
export const PR_BINDING_POLICY: PrBindingPolicy = loadPrBindingPolicy();

/** What a PR's binding is built from. `body` undefined = not read yet (→ binding unknown) · null = the PR has no body. */
export interface PrMetaIn { readonly title?: string; readonly body?: string | null; readonly headRef?: string | null }
export interface BindingContext {
  /** The release's cells (ids for «칸»/title/branch · `source` «PR #N» = registered from it · evidence/owner for own-evidence). */
  readonly cells: ReadonlyArray<OwnCell & { readonly source?: string }>;
  /** Cells the PR's own post-merge sweep bound it to (cell-link.jsonl · pipelineCellsByPr). */
  readonly pipeline?: (pr: number) => readonly string[];
  /** Evidence writes ⊕ the seats that held a cell (features.sqlite · every release). Absent → no own-evidence basis. */
  readonly trail?: (cellId: string) => CellTrail | undefined;
  readonly policy?: PrBindingPolicy;
}

/** The PR's binding to the release's cells, or null when its body was not read yet. Pure (over the context). */
export function bindingOf(pr: number, meta: PrMetaIn | null | undefined, ctx: BindingContext): PrCellBinding | null {
  if (!meta || meta.body === undefined) return null;
  const policy = ctx.policy ?? PR_BINDING_POLICY;
  const evidence: string[] = [];
  if (policy.bases.includes('own-evidence') && ctx.trail) {
    for (const c of ctx.cells) {
      if (!(c.evidence ?? '').includes(String(pr))) continue;
      const v = ownEvidenceCite(c, pr, ctx.trail(c.id), policy.ownEvidence);
      if (v.kind === 'cites') evidence.push(c.id);
    }
  }
  return prCellBinding({ title: meta.title ?? '', body: meta.body, headRef: meta.headRef ?? null }, ctx.cells,
    [...(ctx.pipeline?.(pr) ?? []), ...ctx.cells.filter(c => c.source === `PR #${pr}`).map(c => c.id)], evidence);
}

export interface BoundPrs { readonly bound: number[]; readonly notMine: string[] }
/** Split the merged PRs a cell cites: bound (judged) · not this cell's (named with the reason, never judged). Pure. */
export function boundPrs(cellId: string, prs: readonly number[], binding: (pr: number) => PrCellBinding | null, accept: readonly BindingBasis[] = PR_BINDING_POLICY.bases): BoundPrs {
  const out: { bound: number[]; notMine: string[] } = { bound: [], notMine: [] };
  for (const pr of prs) {
    const b = binding(pr);
    const v = b ? bindsCell(b, cellId, accept) : { ok: false as const, why: 'PR body not read yet (binding unknown · next tick)' };
    if (v.ok) out.bound.push(pr); else out.notMine.push(`#${pr} ${v.why}`);
  }
  return out;
}

/** JUDGE-SIM-RECEIPT (대표 11-28 15:2x): a receipt named «<pr>-<head12>…» (the pregate receipt dir form · a sim world `--run-id`)
 *  belongs to PR `pr` at `head` — `pattern` is judging.yaml sim_evidence.run_id_binding («{pr}-{head12}»). Pure. */
export function receiptNameBindsPrHead(name: string, pr: number, head: string | null, pattern = '{pr}-{head12}'): boolean {
  if (!head || !/^[0-9a-f]{12,40}$/iu.test(head)) return false;
  const prefix = pattern.replaceAll('{pr}', String(pr)).replaceAll('{head12}', head.slice(0, 12).toLowerCase());
  return name === prefix || name.startsWith(`${prefix}-`);
}

/** SIM-RECEIPT-CARRY: the PR and head12 a receipt name carries («<pr>-<head12>…» per `pattern`) — null when it is not that
 *  shape. The head may differ from the landed head; whether that receipt still stands for it is the carry rule's
 *  (src/git-smart/delta.ts carryProof), never this parser's. Pure. */
export function receiptNameParts(name: string, pattern = '{pr}-{head12}'): { readonly pr: number; readonly head12: string } | null {
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const parts = pattern.split(/(\{pr\}|\{head12\})/u);
  const order: Array<'pr' | 'head12'> = [];
  const re = parts.map(t => (t === '{pr}' ? (order.push('pr'), '(\\d+)') : t === '{head12}' ? (order.push('head12'), '([0-9a-f]{12})') : esc(t))).join('');
  const m = new RegExp(`^${re}(?:-|$)`, 'iu').exec(name);
  if (!m || order.length !== 2) return null;
  const pr = Number(m[order.indexOf('pr') + 1]); const head12 = m[order.indexOf('head12') + 1]!.toLowerCase();
  return Number.isSafeInteger(pr) && pr > 0 ? { pr, head12 } : null;
}

// ── live facts (read-only) — the same files the butler reads ────────────────────────────────────────────────────────────
/** The butler's merged-PR cache (src/judge-butler/collector.ts writes it · one gh pr view per merged PR, ever). */
export const prMetaCachePath = (stateRoot: string): string => join(stateRoot, 'loop-agents', 'judge-butler', 'pr-meta.json');
export function readPrMetaCache(stateRoot: string): Record<string, PrMetaIn> {
  try { const p = prMetaCachePath(stateRoot); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Record<string, PrMetaIn> : {}; } catch { return {}; }
}
/** Live binding context for a release's cells: sweep rows ⊕ evidence trails (one ledger read) — fails open to «no facts». */
export function liveBindingContext(stateRoot: string, items: readonly ChecklistItem[], policy: PrBindingPolicy = PR_BINDING_POLICY): BindingContext {
  const sweep = require('./main-cell-link.js') as typeof import('./main-cell-link.js');
  const pipeline = (() => { try { return sweep.pipelineCellsByPr(sweep.readSweepRows(stateRoot)); } catch { return new Map<number, string[]>(); } })();
  const ids = items.filter(i => i.status === 'yellow' && /#\d{3,7}/u.test(i.evidence ?? '')).map(i => i.id);
  const trails = (() => {
    try { return (require('../release-loop/checklist.js') as typeof import('../release-loop/checklist.js')).checklistTrails(ids); } catch { return new Map<string, CellTrail>(); }
  })();
  return { cells: items, pipeline: pr => pipeline.get(pr) ?? [], trail: id => trails.get(id), policy };
}
