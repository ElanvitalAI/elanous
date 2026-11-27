// 판정 집사 — helpers (fed-sim: 2 per agent = collector graph LLM 0 ⊕ capsule slot).
//   ① collector: for the merged PRs that yellow cells cite → landed head ⊕ files ⊕ same-head receipt ⊕ focused ⊕ Terra security.
//      Merged PRs never change, so head/files are cached per PR under the butler home (one gh call per PR, ever).
//   ② capsule slot: a leased sub-agent that would PRODUCE missing evidence («영수 칸 → 영수 생성 판»). The capsule runner is not
//      on main yet → the default slot leases nothing and the cell stays «missing» with its exact step (the ✋ answer names it).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrFacts, ReceiptFacts } from './done-when.js';

export interface PrMeta { readonly head: string | null; readonly files: readonly string[] | null }
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
}

export function collectPrFacts(prs: Iterable<number>, d: CollectorDeps): Map<number, PrFacts> {
  const cachePath = d.cacheDir ? join(d.cacheDir, 'pr-meta.json') : null;
  let cache: Record<string, PrMeta> = {};
  try { if (cachePath && existsSync(cachePath)) cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, PrMeta>; } catch { cache = {}; }
  let dirty = false;
  const out = new Map<number, PrFacts>();
  for (const pr of new Set(prs)) {
    if (!d.merged.has(pr)) { out.set(pr, { pr, merged: false, landedHead: null, receipt: null, files: null, securityFindings: [] }); continue; }
    let meta = cache[String(pr)];
    if (!meta?.head || !meta.files) {
      const fetched = (() => { try { return d.prMeta(pr); } catch { return null; } })();
      if (fetched?.head && fetched.files) { meta = fetched; cache[String(pr)] = fetched; dirty = true; } else meta = fetched ?? { head: null, files: null };
    }
    const landedHead = d.landedHead(pr) ?? meta.head;
    const receipt = landedHead ? (() => { try { return d.receipt(pr, landedHead); } catch { return null; } })() : null;
    const securityFindings = landedHead ? (() => { try { return d.security(pr, landedHead); } catch { return []; } })() : [];
    const olderReceiptHead = landedHead && !receipt && d.olderReceiptHead ? (() => { try { return d.olderReceiptHead!(pr, landedHead); } catch { return null; } })() : null;
    out.set(pr, { pr, merged: true, landedHead, receipt, files: meta.files, securityFindings, ...(olderReceiptHead ? { olderReceiptHead } : {}) });
  }
  if (dirty && cachePath) { try { mkdirSync(d.cacheDir!, { recursive: true }); writeFileSync(cachePath, JSON.stringify(cache)); } catch { /* cache only */ } }
  return out;
}

export interface CapsuleTask { readonly kind: 'produce-evidence'; readonly cell: string; readonly missing: readonly string[]; readonly ttlMs: number }
export interface CapsuleSlot { lease(task: CapsuleTask): Promise<{ evidenceRef: string } | null> }
/** The capsule runner is not on main — the slot leases nothing (the body names the missing step instead). */
export const NO_CAPSULE: CapsuleSlot = { lease: async () => null };
