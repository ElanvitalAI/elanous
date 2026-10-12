// PLAN-model-intelligence-router-2026-07-10 · Part A / Phase A2 —
// Provider / news watch intake.
//
// The live change-detection layer is Firecrawl Monitors (run by the
// omni-crawl skill) polling the source pages in `PROVIDER_MODEL_SOURCES`.
// When a page changes, its text is handed here. This module is the
// elanous-side pipeline: classify each changed page (A3) → dedup candidates
// → merge into the loaded catalog as a PREVIEW (promote:false, so nothing
// is auto-approved) → return a proposal for the HITL step (A4).
//
// Pure orchestration over injected deps — no network, no live monitor
// registration (that's ops, in the skill). Never throws.

import { loadCatalog, type CatalogIoOpts } from './model-catalog.js';
import {
  classifyModelsFromTextDetailed,
  type DetailedClassifyResult,
  type ModelCandidate,
} from './model-classifier.js';
import { mergeCandidates, type MergeResult } from './catalog-merge.js';
import type { LlmRunner } from '../model-tier/preset-suggest-llm.js';

/** Canonical source pages the watcher monitors for new-model signals.
 *  Registered as Firecrawl Monitors on the ops side; listed here so the
 *  elanous-side intake, docs, and setup share one source of truth. */
export const PROVIDER_MODEL_SOURCES: ReadonlyArray<{ id: string; url: string; kind: 'provider' | 'news' }> = [
  // Replaces 745,101-char script-JSON-only input with 21,644-char Markdown (5 model names, 36 price markers).
  { id: 'openai-pricing', url: 'https://developers.openai.com/api/docs/pricing.md', kind: 'provider' },
  // Replaces 368,414-char script-JSON-only input with 11,874-char Markdown (3 model names).
  { id: 'openai-models', url: 'https://developers.openai.com/api/docs/models.md', kind: 'provider' },
  { id: 'anthropic-models', url: 'https://docs.anthropic.com/en/docs/about-claude/models', kind: 'provider' },
  { id: 'anthropic-pricing', url: 'https://www.anthropic.com/pricing', kind: 'provider' },
  { id: 'google-gemini-models', url: 'https://ai.google.dev/gemini-api/docs/models', kind: 'provider' },
  { id: 'xai-models', url: 'https://docs.x.ai/docs/models', kind: 'provider' },
];

export interface WatchPage {
  /** Source id (matches a PROVIDER_MODEL_SOURCES entry) or a news URL. */
  source: string;
  /** The changed page's text content. */
  text: string;
}

export interface WatchIntakeDeps {
  /** Classifier LLM. */
  runLlm: LlmRunner;
}

export interface WatchSourceResult extends DetailedClassifyResult {
  candidateCount: number;
}

export interface WatchIntakeResult {
  /** Deduped candidates across all pages (source:'auto'). */
  candidates: ModelCandidate[];
  /** Preview merge into the current catalog (NOT persisted, promote:false).
   *  `added`/`updated` tell the HITL step what would change. */
  proposal: MergeResult;
  /** Per-source candidates and classifier diagnosis for the mission log. */
  perSource: Record<string, WatchSourceResult>;
}

/** Run the intake over changed pages. Classifies, dedups by model id
 *  (first wins), and previews the catalog merge. Never throws — a failed
 *  page contributes nothing. */
export async function runModelWatchIntake(
  pages: readonly WatchPage[],
  deps: WatchIntakeDeps,
  opts: CatalogIoOpts & { now?: number; classifyTimeoutMs?: number } = {},
): Promise<WatchIntakeResult> {
  const perSource: Record<string, WatchSourceResult> = {};
  const byId = new Map<string, ModelCandidate>();

  for (const page of pages) {
    let classified: DetailedClassifyResult;
    try {
      classified = await classifyModelsFromTextDetailed(page.text, deps.runLlm, {
        ...(opts.classifyTimeoutMs !== undefined ? { timeoutMs: opts.classifyTimeoutMs } : {}),
        ...(opts.now !== undefined ? { at: new Date(opts.now).toISOString() } : {}),
      });
    } catch (error) {
      classified = {
        candidates: [],
        status: 'error',
        elapsedMs: 0,
        contentLength: typeof page.text === 'string' ? page.text.length : 0,
        error: errorMessage(error),
      };
    }
    perSource[page.source] = { ...classified, candidateCount: classified.candidates.length };
    for (const candidate of classified.candidates) {
      if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
    }
  }

  const candidates = [...byId.values()];
  const { catalog } = loadCatalog(opts);
  const proposal = mergeCandidates(catalog, candidates, {
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    promote: false,
  });

  return { candidates, proposal, perSource };
}

export type PriceField = 'inputPerMtok' | 'outputPerMtok';

export interface PriceChange {
  id: string;
  field: PriceField;
  /** Price currently in the catalog (USD per 1M tokens). */
  before: number;
  /** Price the watched page reports. */
  after: number;
}

const PRICE_FIELDS: readonly PriceField[] = ['inputPerMtok', 'outputPerMtok'];

/** Price differences between the catalog and the watched pages. The merge
 *  only fills undefined fields, so a repriced model shows up in
 *  `proposal.updated` with no trace of the new price — this reports it.
 *  A catalog price of 0 means "not priced yet" and is not a change. */
export function detectPriceChanges(result: Pick<WatchIntakeResult, 'candidates' | 'proposal'>): PriceChange[] {
  const current = new Map(result.proposal.catalog.models.map((model) => [model.id, model]));
  const updated = new Set(result.proposal.updated);
  const changes: PriceChange[] = [];
  for (const candidate of result.candidates) {
    const entry = current.get(candidate.id);
    if (!entry || !updated.has(candidate.id)) continue;
    for (const field of PRICE_FIELDS) {
      const before = entry[field];
      const after = candidate[field];
      if (typeof after !== 'number' || !Number.isFinite(after) || after < 0) continue;
      if (typeof before !== 'number' || before <= 0 || before === after) continue;
      changes.push({ id: candidate.id, field, before, after });
    }
  }
  return changes;
}

export function formatPriceChange(change: PriceChange): string {
  const label = change.field === 'inputPerMtok' ? 'input' : 'output';
  return `${change.id} ${label} $${change.before}→$${change.after} /Mtok`;
}

function errorMessage(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 240);
  } catch {
    return 'classifier error unavailable';
  }
}
