// PLAN-model-intelligence-router-2026-07-10 · Part A / Phase A5 —
// Model-intelligence watch mission entry.
//
// The runnable a scheduled mission (Mission Fabric / PFC Layer2 cron)
// invokes: fetch the changed source pages, classify them, and surface the
// resulting catalog proposal for human approval. It NEVER auto-applies —
// the proposal (promote:false) is written to a proposals log + handed to an
// injected `onProposal` sink (telegram / discovery-mission) for the HITL
// step (A4 `applyApprovedCandidates` runs only after approval).
//
// Everything external is injected so this is unit-testable and so the
// classifier LLM defaults to a CHEAP model (the routing/classification
// itself should never cost more than the turns it governs).

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { streamLLM, type LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import { lookupLlmTierSpec } from '../model-tier/index.js';
import type { LlmRunner } from '../model-tier/preset-suggest-llm.js';
import type { LLMProviderName } from '../user-config.js';
import { getUserConfig } from '../user-config.js';
import {
  detectPriceChanges,
  formatPriceChange,
  runModelWatchIntake,
  type WatchIntakeResult,
  type WatchPage,
} from './model-watch-intake.js';

export function getModelWatchProposalPath(home: string = homedir()): string {
  return join(home, '.elanous', 'model-watch-proposals.jsonl');
}

export interface ModelWatchDeps {
  /** Fetch the changed source pages. On the ops side this reads the
   *  Firecrawl monitor's changed-page checks. */
  fetchPages: () => Promise<WatchPage[]>;
  /** Classifier LLM. When omitted, one is built from the active
   *  provider's BUDGET-tier model (cheap classification). */
  runLlm?: LlmRunner;
  /** Provider for the default classifier model. Defaults to config. */
  provider?: LLMProviderName;
  /** Where the proposal is delivered for HITL (telegram / discovery
   *  mission). Defaults to appending the proposals JSONL only. */
  onProposal?: (result: WatchIntakeResult) => void | Promise<void>;
  /** Operational event sink. Defaults to the persistent debug logger. */
  log?: (category: string, event: string, data?: unknown) => void | Promise<void>;
}

export interface ModelWatchOpts {
  home?: string;
  now?: number;
  classifyTimeoutMs?: number;
}

/** Run one watch pass. Returns the (unapproved) proposal. Never throws. */
export async function runModelIntelligenceWatch(
  deps: ModelWatchDeps,
  opts: ModelWatchOpts = {},
): Promise<WatchIntakeResult> {
  const provider = deps.provider ?? safeProvider();
  const runLlm = deps.runLlm ?? buildBudgetClassifier(provider);

  let pages: WatchPage[] = [];
  try { pages = await deps.fetchPages(); } catch { pages = []; }

  const result = await runModelWatchIntake(pages, { runLlm }, {
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.classifyTimeoutMs !== undefined ? { classifyTimeoutMs: opts.classifyTimeoutMs } : {}),
  });
  const log = deps.log ?? debug.log.bind(debug);

  // Persist the proposal for the HITL surface — only when it actually
  // proposes a change, so the log stays signal.
  if (result.proposal.added.length > 0 || result.proposal.updated.length > 0) {
    try {
      const path = getModelWatchProposalPath(opts.home);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify({
        ts: opts.now ?? Date.now(),
        added: result.proposal.added,
        updated: result.proposal.updated,
        candidates: result.candidates,
        perSource: result.perSource,
      }) + '\n', 'utf-8');
    } catch { /* best-effort */ }
    try { await deps.onProposal?.(result); } catch { /* sink isolation */ }
  }

  const abnormalEmptySources = Object.entries(result.perSource)
    .filter(([, source]) => source.candidateCount === 0 && source.status !== 'completed')
    .map(([source]) => source);
  if (abnormalEmptySources.length > 0) {
    await safeLog(log, 'intelligence-map.model-watch', 'incomplete-classification', {
      sources: abnormalEmptySources,
      line: `Classification incomplete for zero-candidate sources: ${abnormalEmptySources.join(', ')}`,
    });
  }
  const priceChanges = detectPriceChanges(result);
  if (priceChanges.length > 0) {
    await safeLog(log, 'intelligence-map.model-watch', 'price-changes', {
      changes: priceChanges,
      line: `Price changes vs catalog: ${priceChanges.map(formatPriceChange).join('; ')}`,
    });
  }
  await safeLog(log, 'intelligence-map.model-watch', 'pass', {
    pages: pages.length,
    candidates: result.candidates.length,
    added: result.proposal.added.length,
    updated: result.proposal.updated.length,
  });
  return result;
}

async function safeLog(
  log: NonNullable<ModelWatchDeps['log']>,
  category: string,
  event: string,
  data?: unknown,
): Promise<void> {
  try { await log(category, event, data); } catch { /* sink isolation */ }
}

function safeProvider(): LLMProviderName {
  try { return getUserConfig().llm.provider; } catch { return 'anthropic'; }
}

/** A classifier runner on the provider's budget-tier model — a small
 *  model deciding what the big ones should be. */
function buildBudgetClassifier(provider: LLMProviderName): LlmRunner {
  const cheap = lookupLlmTierSpec(provider, 'budget').model;
  return async (msgs) => {
    let full = '';
    await streamLLM(
      msgs.map((m) => ({ role: m.role, content: m.content })) as LLMMessage[],
      (_delta, all) => { full = all; },
      { model: cheap },
    );
    return full;
  };
}
