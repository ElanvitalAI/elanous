// Pure gate evaluator.
//
// Inputs: catalog, hints (turn→session→project→global order), signals.
// Output: GateDecision { filtered, boost, paramDefaults, hintReasons }.
//
// No async, no LLM, no filesystem reads — those all happened upstream
// (registry, probe, signals). This module is the one place where rules
// live, and it's a switch table so auditing "why is X visible / hidden"
// is a line-by-line read.
//
// Caching is per fingerprint; the gate memoizes across repeated calls
// within a draw.

import { createHash } from 'node:crypto';

import type { NativeToolCatalogEntry } from '../native-tool-catalog.js';
import { debug } from '../debug/log.js';
import { probeOk } from './probe.js';
import type { SignalSnapshot } from './signals.js';
import type { GateDecision, Hint, ToolIntentScope } from './types.js';
import { setLastActiveScopes } from './intent-miss.js';

const CACHE = new Map<string, GateDecision>();
const CACHE_MAX = 64;

/** Reset the memo. Exposed for tests and /hint reset. */
export function resetGateCache(): void {
  CACHE.clear();
}

export function evaluateGate(
  catalog: NativeToolCatalogEntry[],
  hints: Hint[],
  signals: SignalSnapshot,
): GateDecision {
  const key = cacheKey(catalog, hints, signals);
  const cached = CACHE.get(key);
  if (cached) {
    recordGateEvaluation(catalog.length, cached.filtered.length, {
      defaultEnabled: notRunStage(),
      probe: notRunStage(),
      intentScope: notRunStage(),
      minTier: notRunStage(),
      hints: notRunStage(),
      modelFamilyCap: notRunStage(),
    }, true);
    return cached;
  }

  const enabled = new Set<string>();
  const stages: GateStages = {
    defaultEnabled: notRunStage(),
    probe: notRunStage(),
    intentScope: notRunStage(),
    minTier: notRunStage(),
    hints: notRunStage(),
    modelFamilyCap: notRunStage(),
  };
  const boost = new Map<string, number>();
  const paramDefaults = new Map<string, Record<string, unknown>>();

  // ─── Step 1: seed with defaultEnabled entries ──────────────────
  for (const tool of catalog) {
    if (tool.defaultEnabled) enabled.add(tool.id);
  }
  stages.defaultEnabled = executedStage(catalog.length, enabled.size);

  // ─── Step 2: probe filter (fail-closed hide/disable) ───────────
  const beforeProbe = enabled.size;
  for (const tool of catalog) {
    if (!tool.probe) continue;
    const ok = probeOk(tool.probe);
    if (ok) continue;
    const mode = tool.probe.onFail ?? 'hide';
    if (mode === 'hide') enabled.delete(tool.id);
    else if (mode === 'disable') enabled.delete(tool.id);
    // 'warn': leave enabled; caller may read hintReasons to surface
  }
  stages.probe = executedStage(beforeProbe, enabled.size);

  // ─── Step 2.5: intentScope filter (Arc H · opt-in) ─────────────
  // Only active when HARNESS_TOOL_DISCIPLINE_ENABLED=1 (matches Arc G's
  // default-disabled pattern — user explicitly opts in after evaluating).
  // Scope union: `'coding'` is always active; browse/viz/capture/ops
  // activate iff signals.ts intent regex matched this turn. `'always'`
  // is never filtered; untagged entries default to `'always'`.
  if (toolDisciplineEnabled()) {
    const beforeIntentScope = enabled.size;
    const activeScopes = activeIntentScopes(signals);
    // Arc H follow-up — cache the active set so dispatch-time miss
    // telemetry can compare against it without recomputing signals.
    setLastActiveScopes(activeScopes);
    for (const tool of catalog) {
      const scope: ToolIntentScope = tool.intentScope ?? 'always';
      if (scope === 'always') continue;
      if (!activeScopes.has(scope)) enabled.delete(tool.id);
    }
    stages.intentScope = executedStage(beforeIntentScope, enabled.size);
  }

  // ─── Step 3: minTier filter ────────────────────────────────────
  const activeTier = signals.modelTier;
  if (activeTier) {
    const beforeMinTier = enabled.size;
    const tierRank: Record<string, number> = { T1: 3, T2: 2, T3: 1 };
    const activeRank = tierRank[activeTier] ?? 2;
    for (const tool of catalog) {
      if (!tool.minTier) continue;
      const need = tierRank[tool.minTier] ?? 2;
      if (activeRank < need) enabled.delete(tool.id);
    }
    stages.minTier = executedStage(beforeMinTier, enabled.size);
  }

  // ─── Step 4: hint overrides (most-specific last wins) ──────────
  // Hints arrive already ordered turn → session → project → global;
  // later-scope hints should NOT overwrite more-specific earlier
  // ones, so we iterate in reverse so specific wins.
  const beforeHints = enabled.size;
  const seenForKind = new Map<string, HintKindCombo>();
  for (let i = hints.length - 1; i >= 0; i--) {
    const h = hints[i];
    const tools = resolveTool(h.tool, catalog);
    for (const toolId of tools) {
      const comboKey = `${toolId}:${h.kind}`;
      if (seenForKind.has(comboKey)) continue;
      seenForKind.set(comboKey, { toolId, kind: h.kind });

      if (h.kind === 'enable')  enabled.add(toolId);
      if (h.kind === 'disable') enabled.delete(toolId);
      if (h.kind === 'prefer') boost.set(toolId, (boost.get(toolId) ?? 0) + 2);
      if (h.kind === 'boost')  boost.set(toolId, (boost.get(toolId) ?? 0) + 1);
      if (h.kind === 'avoid')  boost.set(toolId, (boost.get(toolId) ?? 0) - 1);
      if (h.kind === 'param-default') {
        const existing = paramDefaults.get(toolId) ?? {};
        const args = (h.payload?.args as Record<string, unknown> | undefined) ?? {};
        paramDefaults.set(toolId, { ...existing, ...args });
      }
    }
  }
  stages.hints = executedStage(beforeHints, enabled.size);

  // ─── Step 5: signal-driven boosts ──────────────────────────────
  if (signals.intentResearch) {
    bumpIfEnabled(enabled, boost, 'web_search', 2);
    bumpIfEnabled(enabled, boost, 'omni_search', 2);
    bumpIfEnabled(enabled, boost, 'web_fetch', 2);
  }
  if (signals.intentDiagram) {
    bumpIfEnabled(enabled, boost, 'mermaid_render', 2);
  }
  if (signals.recentNetworkError) {
    bumpIfEnabled(enabled, boost, 'api_call', 1);
  }
  if (signals.hasPython) {
    bumpIfEnabled(enabled, boost, 'ast_grep', 1);
  }

  // ─── P15: terminal session boosts ──────────────────────────────
  if (signals.hasActivePtyModal) {
    // Agent should check current sessions before spawning a new shell.
    bumpIfEnabled(enabled, boost, 'terminal_modal_list', 2);
    bumpIfEnabled(enabled, boost, 'terminal_modal_observe', 2);
  }
  if (signals.hasSessionAttention) {
    // Something is waiting — urgently boost observe.
    bumpIfEnabled(enabled, boost, 'terminal_modal_observe', 2);
  }
  if (signals.backgroundedPtyCount > 0) {
    bumpIfEnabled(enabled, boost, 'terminal_modal_focus', 1);
  }

  // ─── Step 6: model-tier budget cap ─────────────────────────────
  // Weak/cheap models pay a per-tool token tax. On codex/gpt-5 we
  // cap the prompt after boost sort to keep per-call overhead bounded.
  // Research already has an intent signal; it needs more source tools but
  // still has a finite cap. Claude/Opus/Grok don't need this cap.
  let keep: string[] = [...enabled];
  const capped = signals.modelFamily === 'codex' || signals.modelFamily === 'gpt';
  if (capped) {
    const beforeModelFamilyCap = keep.length;
    const cap = signals.researchAgent ? 16 : 8;
    if (keep.length > cap) {
      keep = keep
        .map(id => ({ id, score: boost.get(id) ?? 0 }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, cap)
        .map(x => x.id);
    }
    stages.modelFamilyCap = executedStage(beforeModelFamilyCap, keep.length);
  }

  // Sort by boost desc then id asc for stable output order.
  keep = keep
    .map(id => ({ id, score: boost.get(id) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map(x => x.id);

  const hintReasons: string[] = [];
  for (const h of hints) if (h.reason) hintReasons.push(h.reason);

  const decision: GateDecision = {
    filtered: keep,
    boost: Object.fromEntries(boost),
    paramDefaults: Object.fromEntries(paramDefaults),
    hintReasons,
  };

  if (CACHE.size >= CACHE_MAX) {
    // LRU-ish eviction: drop the oldest insertion.
    const firstKey = CACHE.keys().next().value;
    if (firstKey !== undefined) CACHE.delete(firstKey);
  }
  CACHE.set(key, decision);
  recordGateEvaluation(catalog.length, decision.filtered.length, stages, false);
  return decision;
}

type GateStage = {
  executed: boolean;
  before: number | null;
  after: number | null;
  removed: number | null;
};

type GateStages = Record<
  'defaultEnabled' | 'probe' | 'intentScope' | 'minTier' | 'hints' | 'modelFamilyCap',
  GateStage
>;

function notRunStage(): GateStage {
  return { executed: false, before: null, after: null, removed: null };
}

function executedStage(before: number, after: number): GateStage {
  return { executed: true, before, after, removed: Math.max(0, before - after) };
}

function recordGateEvaluation(
  catalogCount: number,
  filteredCount: number,
  stages: GateStages,
  cacheHit: boolean,
): void {
  // This is a per-call summary: names stay out so high-cardinality catalogs do not flood observability.
  debug.log('capability.resolve', 'tool-gate-evaluated', {
    cacheHit,
    catalogCount,
    filteredCount,
    removedCount: catalogCount - filteredCount,
    stages,
  });
}

type HintKindCombo = { toolId: string; kind: Hint['kind'] };

function resolveTool(needle: string, catalog: NativeToolCatalogEntry[]): string[] {
  if (needle === '*') return catalog.map(t => t.id);
  const entry = catalog.find(t => t.id === needle || t.aliases.includes(needle));
  return entry ? [entry.id] : [];
}

function bumpIfEnabled(enabled: Set<string>, boost: Map<string, number>, id: string, delta: number): void {
  if (!enabled.has(id)) return;
  boost.set(id, (boost.get(id) ?? 0) + delta);
}

function cacheKey(
  catalog: NativeToolCatalogEntry[],
  hints: Hint[],
  signals: SignalSnapshot,
): string {
  const parts = [
    catalog.map(t => t.id).sort().join(','),
    hints.map(h => `${h.id}:${h.kind}:${h.tool}:${h.usesLeft ?? ''}`).join(';'),
    signals.fingerprint,
    toolDisciplineEnabled() ? 'disc:1' : 'disc:0',
  ];
  return createHash('sha1').update(parts.join('||')).digest('hex').slice(0, 16);
}

/** Arc H — env opt-in gate. Evaluated per-call so tests can toggle the
 *  env var via setEnvForTesting(). The cache key includes this flag so
 *  flipping it invalidates memoized decisions. */
function toolDisciplineEnabled(): boolean {
  return process.env.HARNESS_TOOL_DISCIPLINE_ENABLED === '1';
}

/** Arc H — compute active intent scope set. `'coding'` is always
 *  present (default lane); browse/viz/capture/ops-fleet/ops-ui are
 *  unioned when their signals.ts regex matched this turn. */
function activeIntentScopes(signals: SignalSnapshot): Set<ToolIntentScope> {
  const active = new Set<ToolIntentScope>(['coding']);
  if (signals.intentBrowse) active.add('browse');
  if (signals.intentViz) active.add('viz');
  if (signals.intentCapture) active.add('capture');
  if (signals.intentOpsFleet) active.add('ops-fleet');
  if (signals.intentOpsUi) active.add('ops-ui');
  return active;
}
