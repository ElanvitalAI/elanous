// 판정 집사 — helpers (fed-sim: 2 per agent = collector graph LLM 0 ⊕ capsule slot).
//   ① collector: for the merged PRs that yellow cells cite → landed head ⊕ files ⊕ same-head receipt ⊕ focused ⊕ Terra security.
//      Merged PRs never change, so head/files are cached per PR under the butler home (one gh call per PR, ever).
//      JUDGE-GREEN-PR-BINDING: ⊕ title · body · head branch (same call · same cache) → the PR's own binding to cells
//      (src/land-graph/cell-link.ts prCellBinding) ⊕ its post-merge sweep cells. A cache row from before (no body) is read
//      again, at most `metaFetchPerTick` per call; until then the PR is unbound (never signs a cell).
//      JUDGE-GREEN-PR-BINDING-LEGACY: the binding is built by the kit's bindingOf (src/land-graph/pr-binding.ts) — the same
//      function green-triage uses — ⊕ the cells' evidence trail (`trail`) for a legacy PR's own-evidence basis.
//   ② capsule slot: a leased sub-agent that would PRODUCE missing evidence («영수 칸 → 영수 생성 판»). The capsule runner is not
//      on main yet → the default slot leases nothing and the cell stays «missing» with its exact step (the ✋ answer names it).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CellTrail, OwnCell } from '../land-graph/cell-link.js';
import { bindingOf, type PrBindingPolicy } from '../land-graph/pr-binding.js';
import type { PrFacts, ReceiptFacts } from './done-when.js';
import { scenesNamed, simSceneIndex } from '../kit/requirement-judge/sim-evidence.js';

/** `body` absent = a cache row from before JUDGE-GREEN-PR-BINDING (re-read) · null = the PR has no body. */
export interface PrMeta { readonly head: string | null; readonly files: readonly string[] | null; readonly title?: string; readonly body?: string | null; readonly headRef?: string | null;
  /** SIM-SCENES-OWN-DIFF: the registered scene ids in the PR-own change lines of `ownScenesHead` (cached · a merged head never changes). */
  readonly ownScenes?: readonly string[]; readonly ownScenesHead?: string }
export type ReceiptIn = ReceiptFacts;
export interface CollectorDeps {
  /** PRs merged on origin/main (number → merge sha). */
  readonly merged: ReadonlyMap<number, string>;
  /** The head that landed per the land-graph ledger («landed» rows). */
  readonly landedHead: (pr: number) => string | null;
  /** gh pr view — head + files (cached by the collector). */
  readonly prMeta: (pr: number) => PrMeta | null;
  /** A receipt that counts for `head`: same head, or an older head reused by patch-id (land-graph-cli receipt · #40358). */
  readonly receipt: (pr: number, head: string) => ReceiptIn | null;
  /** The newest GREEN receipt head ≠ `head` (only read when no receipt counts — names the refusal). */
  readonly olderReceiptHead?: (pr: number, head: string) => string | null;
  readonly security: (pr: number, head: string) => string[];
  readonly cacheDir?: string;
  /** JUDGE-GREEN-PR-BINDING: the release's cells (ids for the «칸»/title/branch match · `source` «PR #N» = registered from it). Absent → every PR unbound. */
  readonly cells?: ReadonlyArray<OwnCell & { readonly source?: string }>;
  /** JUDGE-GREEN-PR-BINDING-LEGACY: a cell's evidence writes ⊕ the seats that held it (features.sqlite) · absent → no own-evidence basis. */
  readonly trail?: (cellId: string) => CellTrail | undefined;
  readonly policy?: PrBindingPolicy;
  /** Cells the PR's own post-merge sweep bound it to (land-graph cell-link.jsonl · pipelineCellsByPr). */
  readonly pipelineCells?: (pr: number) => readonly string[];
  /** SIM-SCENES-OWN-DIFF: the PR-own change lines of `head` (src/git-smart/delta.ts prDelta → ownChangeLines) · null = unreadable
   *  (the body's scenes stay required) · absent = the body's scenes as named. */
  readonly ownChange?: (pr: number, head: string) => string | null;
  /** PR metas fetched per call (goal.yaml green_rules.pr_meta_fetch_per_tick) · absent = no cap. */
  readonly metaFetchPerTick?: number;
}

export function collectPrFacts(prs: Iterable<number>, d: CollectorDeps): Map<number, PrFacts> {
  const cachePath = d.cacheDir ? join(d.cacheDir, 'pr-meta.json') : null;
  let cache: Record<string, PrMeta> = {};
  try { if (cachePath && existsSync(cachePath)) cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, PrMeta>; } catch { cache = {}; }
  let dirty = false; let fetches = 0;
  const out = new Map<number, PrFacts>();
  for (const pr of new Set(prs)) {
    if (!d.merged.has(pr)) { out.set(pr, { pr, merged: false, landedHead: null, receipt: null, files: null, securityFindings: [], binding: null }); continue; }
    let meta: PrMeta | undefined = cache[String(pr)];
    const needHead = !meta?.head || !meta.files;
    if ((needHead || meta?.body === undefined) && (needHead || d.metaFetchPerTick === undefined || fetches < d.metaFetchPerTick)) {
      fetches++;
      const fetched = (() => { try { return d.prMeta(pr); } catch { return null; } })();
      if (fetched?.head && fetched.files) { meta = fetched; cache[String(pr)] = fetched; dirty = true; } else meta = needHead ? (fetched ?? { head: null, files: null }) : meta;
    }
    meta ??= { head: null, files: null };
    const own = !d.cells ? null : bindingOf(pr, meta, { cells: d.cells, ...(d.pipelineCells ? { pipeline: d.pipelineCells } : {}), ...(d.trail ? { trail: d.trail } : {}), ...(d.policy ? { policy: d.policy } : {}) });
    const landedHead = d.landedHead(pr) ?? meta.head;
    const receipt = landedHead ? (() => { try { return d.receipt(pr, landedHead); } catch { return null; } })() : null;
    const securityFindings = landedHead ? (() => { try { return d.security(pr, landedHead); } catch { return []; } })() : [];
    const olderReceiptHead = landedHead && !receipt && d.olderReceiptHead ? (() => { try { return d.olderReceiptHead!(pr, landedHead); } catch { return null; } })() : null;
    // JUDGE-SIM-RECEIPT: the PR body's scene table · SIM-SCENES-OWN-DIFF (11-28 11:44Z): only the scenes the PR's OWN change
    // touches — a body that names other PRs' scenes in prose (a status line · a projection · a copied body) bound them too
    // («GRD-FUEL-ALL-DRY · JB-SIM-CARRY-MERGE 영수 없음» on #40715 · «C4·C6·GRD…» on SIM-RECEIPT-CARRY).
    const index = simSceneIndex();
    let scenes = meta.body ? scenesNamed(meta.body, index) : [];
    if (scenes.length && landedHead && d.ownChange) {
      const row = cache[String(pr)];
      let own: readonly string[] | null = row?.ownScenesHead === landedHead && Array.isArray(row.ownScenes) ? row.ownScenes : null;
      if (!own) {
        const text = (() => { try { return d.ownChange!(pr, landedHead); } catch { return null; } })();
        if (text !== null) { own = scenesNamed(text, index); if (row) { cache[String(pr)] = { ...row, ownScenes: own, ownScenesHead: landedHead }; dirty = true; } }
      }
      if (own) { const mine = new Set(own); scenes = scenes.filter(s => mine.has(s)); }
    }
    out.set(pr, { pr, merged: true, landedHead, receipt, files: meta.files, securityFindings, binding: own, ...(olderReceiptHead ? { olderReceiptHead } : {}), ...(scenes.length ? { scenes } : {}) });
  }
  if (dirty && cachePath) { try { mkdirSync(d.cacheDir!, { recursive: true }); writeFileSync(cachePath, JSON.stringify(cache)); } catch { /* cache only */ } }
  return out;
}

export interface CapsuleTask { readonly kind: 'produce-evidence'; readonly cell: string; readonly missing: readonly string[]; readonly ttlMs: number }
export interface CapsuleSlot { lease(task: CapsuleTask): Promise<{ evidenceRef: string } | null> }
/** The capsule runner is not on main — the slot leases nothing (the body names the missing step instead). */
export const NO_CAPSULE: CapsuleSlot = { lease: async () => null };
