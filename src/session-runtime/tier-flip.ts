// ── Tier flip — defer specialised tool schemas (Coding Pipeline P1 followup) ──
//
// The `nativeToolCatalog` ships three meta fields per entry:
//   - `alwaysLoad`    — if `false` the schema is held back from the base prompt
//   - `shouldDefer`   — if `true` the entry surfaces in the deferred summary
//                       block so the LLM knows the tool exists and can call
//                       `ToolSearch({query:"select:<name>"})` to hydrate the schema
//   - `toolSearchable`— if `false`, ToolSearch refuses to surface the schema
//                       (safety-sensitive meta-tools)
//
// Consumers (chat path, skill runner, MCP server) build a list of
// `LLMToolSpec`s every turn and hand it to the provider. This module
// is the single seam where that list gets split into:
//
//   { activeSpecs:   <full-schema list, fed to provider as `tools=[…]`>,
//     deferredEntries: <(name + summary) pairs, rendered into system prompt> }
//
// Deferred entries do NOT appear in the provider tool list, so the
// provider cannot call them directly. The LLM hydrates a schema by
// calling `ToolSearch({query:"select:<name>"})`. The result is a
// `<functions>{...}</functions>` block; once it lands in the
// conversation, the tool is callable on subsequent turns exactly like
// any pre-loaded tool.
//
// Pattern adapted from claude-code-fork's `src/Tool.ts`
// `shouldDefer`/`alwaysLoad` fields. Mirrors the "agility-tier loaded
// by default, big-armada loaded on demand" philosophy from the P1
// HANDOFF.

import type { ContentBlock, LLMMessage, LLMToolSpec } from '../llm.js';
import {
  nativeToolCatalog,
  type NativeToolCatalogEntry,
} from '../native-tool-catalog.js';
import { collectSignals } from '../tool-hints/signals.js';
import type { ToolIntentScope } from '../tool-hints/types.js';
// Spec-only import (pure literal, zero deps) — the dispatch half of
// ToolSearch lives in skills/tools/tool-search.ts and drags the tool
// runtime registry with it, which has no business in this prompt seam.
import { buildToolSearchTool, TOOL_SEARCH_NAME } from '../skills/tools/tool-search-spec.js';

/** P3 웜 intent-preload (RFC §4) — userText 가 도메인/스코프 시그널을 담고
 *  있으면, 그 스코프의 deferred 툴을 **당턴 active 로 선주입**(un-defer)해
 *  ToolSearch 왕복을 없앤다. 매칭은 Arc H 와 동일한 `collectSignals` 재사용
 *  (single source of intent truth). 매칭 안 되는 스코프의 deferred 툴은
 *  그대로 deferred → ToolSearch 콜드 폴백(P4). */
function warmPreloadScopesFromText(userText: string): ReadonlySet<ToolIntentScope> {
  const sig = collectSignals({ recentUserText: userText });
  const scopes = new Set<ToolIntentScope>();
  // ⭐ 실행/변경 의도만 `'coding'` 을 연다(2026-07-27) — 이 스코프 ∩ deferred = 8종
  //   (EnterWorktree·SelfImplement·SelfOrchestrate·RunDevHarness·SolveMission·
  //    run_tests·GitCommit·MergePullRequest). 태그는 이미 있었는데 **스위치가 없어서**
  //   배틀쉽이 영원히 name-only 였다(실측 warmPreloaded:0).
  if (sig.intentCoding) scopes.add('coding');
  if (sig.intentBrowse) scopes.add('browse');
  if (sig.intentViz) scopes.add('viz');
  if (sig.intentCapture) scopes.add('capture');
  if (sig.intentOpsFleet) scopes.add('ops-fleet');
  if (sig.intentOpsUi) scopes.add('ops-ui');
  return scopes;
}

export interface DeferredToolEntry {
  /** LLM-facing tool name (catalog `displayName`). What the LLM types
   *  in `ToolSearch({query:"select:<name>"})`. */
  name: string;
  /** One-line `promptSummary` from the catalog entry. Tells the LLM
   *  what the tool does so it can decide whether to hydrate. */
  summary: string;
}

export interface TierSplitResult {
  /** Full-schema specs to pass to the provider as `tools=[…]`. */
  active: LLMToolSpec[];
  /** Name+summary pairs to render into the system prompt as a
   *  "deferred tools available via ToolSearch" block. */
  deferred: DeferredToolEntry[];
  /** P3 웜-preload — deferred 였지만 turn intent 매칭으로 active 로 승격된
   *  툴 이름들(관측용). 빈 배열 = 웜-preload 없음. */
  warmPreloaded: string[];
  /** Deferred tool names that cannot be hydrated because ToolSearch is absent.
   *  Regression sentinel — the summoner invariant should keep this empty. */
  unhydratable: string[];
  /** True when this split had to add ToolSearch to `active` itself (the
   *  caller's spec list deferred something but shipped no summoner). */
  toolSearchInjected: boolean;
}

/** Build a quick-lookup map: `displayName` → catalog entry. Catalog
 *  alias matches are handled too so MCP / snake_case names still
 *  resolve. Built once and re-used per call. */
function buildNameIndex(
  catalog: readonly NativeToolCatalogEntry[],
): Map<string, NativeToolCatalogEntry> {
  const map = new Map<string, NativeToolCatalogEntry>();
  for (const entry of catalog) {
    map.set(entry.displayName.toLowerCase(), entry);
    map.set(entry.id.toLowerCase(), entry);
    for (const alias of entry.aliases) {
      map.set(alias.toLowerCase(), entry);
    }
  }
  return map;
}

/** Decide whether a catalog entry should be deferred. The default
 *  (no fields set) is **always-load** so existing tools stay visible.
 *  Only an entry that explicitly opts in via
 *  `alwaysLoad === false` AND `shouldDefer === true` gets deferred. */
function isDeferred(entry: NativeToolCatalogEntry): boolean {
  return entry.alwaysLoad === false && entry.shouldDefer === true;
}

/** ROADMAP Wave 2 classification fallback — tool specs whose runtime
 *  is registered but whose catalog entry was never landed get a
 *  byname-based defer decision here. Each entry below is a known
 *  large + rarely-used spec identified by
 *  `scripts/measure-tool-economics.ts --verbose`. Once the catalog
 *  carries these as real entries (with `alwaysLoad:false,
 *  shouldDefer:true`), the byname fallback is no longer needed and
 *  the entry can be deleted from this set.
 *
 *  Treat as a deprecation queue, not architecture. */
const IMPLICIT_DEFERRED_BY_NAME: ReadonlySet<string> = new Set([
  // auto-research surface (specialised analysis loop)
  'ResearchPlan',
  'EnterAutoMode',
  // CFT surface (industrial Q-tool battery)
  'WriteA3',
  'RunFMEA',
  'RunPDCA',
  'RunDMAIC',
  'QuickKillTriage',
  'IshikawaAnalyze',
  'EscalateLadder',
  'ClassifyGoal',
  // andon / process-health surface
  'EmitProcessHealth',
  // knowledge surface
  'KnowledgeQuery',
  'KnowledgeWrite',
]);

function isImplicitlyDeferredByName(name: string): boolean {
  return IMPLICIT_DEFERRED_BY_NAME.has(name);
}

function isDynamicallyDeferred(spec: LLMToolSpec): boolean {
  const policy = spec as LLMToolSpec & { alwaysLoad?: boolean; shouldDefer?: boolean };
  return policy.alwaysLoad === false && policy.shouldDefer === true;
}

/**
 * Split a list of `LLMToolSpec`s into the active set (full schema in
 * the provider tool list) and the deferred set (name + summary in the
 * system prompt). Specs with no matching catalog entry stay active —
 * we never withhold a schema we can't classify.
 */
export function splitDeferredToolSpecs(
  specs: readonly LLMToolSpec[],
  /** Override the default catalog — primarily for tests. */
  catalog: readonly NativeToolCatalogEntry[] = nativeToolCatalog,
  /** P3 웜-preload — 이 스코프에 속한 deferred 툴은 active 로 승격(un-defer).
   *  omit / 빈 Set = 웜-preload 없음(전부 deferred → P4 콜드 폴백). */
  warmPreloadScopes: ReadonlySet<ToolIntentScope> = new Set(),
): TierSplitResult {
  const index = buildNameIndex(catalog);
  const active: LLMToolSpec[] = [];
  const deferred: DeferredToolEntry[] = [];
  const warmPreloaded: string[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    const entry = index.get(spec.name.toLowerCase());
    if (entry && isDeferred(entry)) {
      // P3 — turn intent 가 이 툴의 스코프를 활성화했으면 defer 하지 않고
      // active 로 선주입(왕복 0). 매칭 안 되면 deferred 유지(P4 폴백).
      if (entry.intentScope && warmPreloadScopes.has(entry.intentScope)) {
        active.push(spec);
        if (!seen.has(entry.displayName)) warmPreloaded.push(entry.displayName);
        seen.add(entry.displayName);
        continue;
      }
      if (seen.has(entry.displayName)) continue;
      seen.add(entry.displayName);
      deferred.push({
        name: entry.displayName,
        summary: entry.promptSummary,
      });
    } else if (!entry && isDynamicallyDeferred(spec)) {
      if (seen.has(spec.name)) continue;
      seen.add(spec.name);
      deferred.push({
        name: spec.name,
        summary: synthesiseFallbackSummary(spec),
      });
    } else if (!entry && isImplicitlyDeferredByName(spec.name)) {
      // No catalog entry but the byname fallback says this is
      // specialised + rarely used. Render with a synthesised
      // promptSummary derived from the spec itself — the LLM still
      // sees enough to know it exists + can call ToolSearch.
      if (seen.has(spec.name)) continue;
      seen.add(spec.name);
      deferred.push({
        name: spec.name,
        summary: synthesiseFallbackSummary(spec),
      });
    } else {
      active.push(spec);
    }
  }
  // ⭐ Summoner invariant (2026-07-26 · RFC-observability-driven-tool-selection F2):
  //   **if we defer a battleship, we hand over the summoner too.**
  //   Previously this seam only *detected* the missing summoner and
  //   reported it as `unhydratable` — the announce block told the model
  //   about tools it had no way to load, so it fell back to shelling out
  //   (`elanous self implement` via PtyShell) instead of calling
  //   SelfImplement. Injecting ToolSearch closes that loop.
  //
  //   The surface still has to ROUTE ToolSearch (see
  //   boot/daemon-tools/index.ts); injecting the schema without the
  //   route would trade a silent miss for an "unknown tool" error, so
  //   the two land together.
  let toolSearchInjected = false;
  if (deferred.length > 0 && !active.some((spec) => spec.name === TOOL_SEARCH_NAME)) {
    active.push(buildToolSearchTool());
    toolSearchInjected = true;
  }
  // Kept as a regression sentinel: with the invariant above this should
  // now always be empty. A non-empty value means something bypassed the
  // injection and the announce block is advertising dead names again.
  const unhydratable = deferred.length > 0 && !active.some((spec) => spec.name === TOOL_SEARCH_NAME)
    ? deferred.map((entry) => entry.name)
    : [];
  return { active, deferred, warmPreloaded, unhydratable, toolSearchInjected };
}

/** Build a one-line summary from a bare LLMToolSpec when we have no
 *  catalog `promptSummary` — used by the byname fallback above. We
 *  clip the description to keep the announce block tight; the LLM
 *  needs just enough context to know whether to hydrate. */
function synthesiseFallbackSummary(spec: LLMToolSpec): string {
  const desc = (spec.description ?? '').trim();
  const clipped = desc.length > 120 ? `${desc.slice(0, 117)}...` : desc;
  return clipped.length > 0 ? `\`${spec.name}\` — ${clipped}` : `\`${spec.name}\``;
}

/**
 * Render deferred entries into a system-prompt block. Returns the
 * empty string when nothing is deferred (caller can `.filter(Boolean)`
 * before joining sections). Format mirrors claude-code-fork's deferred
 * tools advertisement block — short header, bullet list, single
 * "how to load" sentence pointing at ToolSearch.
 */
export function buildDeferredToolsPromptBlock(
  deferred: readonly DeferredToolEntry[],
): string {
  if (deferred.length === 0) return '';
  const lines = deferred.map((entry) => `- ${entry.name} — ${entry.summary}`);
  return [
    '## Deferred tools (schemas not loaded)',
    '',
    `The following ${deferred.length} tools exist but their parameter schemas`,
    'are NOT in the active tool list to keep the prompt lean. Names + brief',
    'summaries follow. To call one of these tools, first invoke',
    '`ToolSearch({query:"select:<name>[,<name>...]"})` — the response',
    'contains the full schema, after which the tool is callable exactly',
    'like any pre-loaded tool.',
    '',
    ...lines,
  ].join('\n');
}

// ── ROADMAP-agent-surface-deferred-tools-2026-05-13 Wave 2 W2.4/W2.5 wire ──
//
// Caller-side helper that drops the deferred announce block into the
// outbound system message. Used by `runCoreTurn` (and future skill /
// eval-cli paths) so a single seam decides where the block lives in
// the prompt.
//
// Placement rule: the LAST system message in the array wins — for the
// common shape `[system, user, ...]` that's the only one; for the
// occasional `[system, user, system-reminder, user]` shape we append
// to the reminder so the deferred summary lives next to other
// turn-scoped reminders (closer to the cursor = higher recency-bias
// utility). When NO system message exists, a fresh one is prepended.
//
// Append (not replace) so existing system content + cache breakpoints
// stay intact — Anthropic's prompt-cache key hashes the full system
// content, and we want the cached prefix to remain stable while the
// deferred block lives at the tail (cache-friendlier than a head
// rewrite).

/** Wave 2 W2.5 — splice the deferred announce block into `messages`,
 *  preferring the trailing system message. Returns a new array; the
 *  input is not mutated. No-op when `block` is empty. */
export function injectDeferredAnnounce(
  messages: readonly LLMMessage[],
  block: string,
): LLMMessage[] {
  if (!block) return messages.slice();
  const out = messages.slice();
  // Find the LAST system message (closest to the user cursor).
  let lastSystemIdx = -1;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i]!.role === 'system') { lastSystemIdx = i; break; }
  }
  if (lastSystemIdx === -1) {
    // No system message yet — synthesise a thin one at the head.
    out.unshift({ role: 'system', content: block });
    return out;
  }
  const target = out[lastSystemIdx]!;
  out[lastSystemIdx] = appendTextToMessage(target, block);
  return out;
}

/** Normalise to "<content trimmed of trailing newlines>\n\n<block>" so
 *  the result has exactly one blank line between the original tail
 *  and the appended block, regardless of how many trailing newlines
 *  the input had. */
function joinWithBlankLine(prefix: string, block: string): string {
  const trimmed = prefix.replace(/\n+$/, '');
  return trimmed.length === 0 ? block : `${trimmed}\n\n${block}`;
}

function appendTextToMessage(msg: LLMMessage, block: string): LLMMessage {
  if (typeof msg.content === 'string') {
    return { ...msg, content: joinWithBlankLine(msg.content, block) };
  }
  // ContentBlock[] — append to the LAST text block; if none exists,
  // push a fresh one. Other block kinds (image / tool_use / tool_result)
  // are passed through untouched.
  const blocks: ContentBlock[] = msg.content.map((b) => ({ ...b }));
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i]!;
    if (b.type === 'text') {
      const text = (b as { text?: string }).text ?? '';
      blocks[i] = { ...b, text: joinWithBlankLine(text, block) };
      return { ...msg, content: blocks };
    }
  }
  blocks.push({ type: 'text', text: block } as ContentBlock);
  return { ...msg, content: blocks };
}

/** Wave 2 W2.4 + W2.5 convenience — split specs AND inject the
 *  announce block in one call. Caller passes `{ messages, tools }`,
 *  receives `{ messages, tools }` ready to hand to `streamLLMWithTools`.
 *  Empty-tools and no-deferred shortcuts skip the work cheaply. */
export interface ApplyDeferredToolsResult {
  messages: LLMMessage[];
  tools: LLMToolSpec[];
  /** Counts for telemetry — `runCoreTurn` logs these via debug.log so
   *  M1-M5 baseline measurement (ROADMAP § 5) can be collected. */
  stats: {
    activeCount: number;
    deferredCount: number;
    /** P3 — deferred 였다가 turn intent 매칭으로 active 로 선주입된 툴 수
     *  (웜-preload). ToolSearch 왕복을 절약한 횟수. */
    warmPreloaded: number;
    /** Number of deferred tools that cannot be hydrated because ToolSearch is absent. */
    unhydratableCount: number;
    /** Deferred and unhydratable tool names for capability-resolution observability. */
    deferredNames: string[];
    unhydratableNames: string[];
    /** True when the messages array was actually rewritten. False on
     *  empty-tools / all-active paths so callers can elide a copy. */
    injected: boolean;
    /** True when ToolSearch was added to the active tool list because the
     *  caller deferred something without shipping a summoner (F2 invariant). */
    toolSearchInjected: boolean;
  };
}

/** Per-call options. `enabled === false` short-circuits the split so
 *  every spec lands in `active` — used by `runCoreTurn` when the user
 *  set `tools.deferred.mode = 'off'` (Wave 2 W2.9 opt-out for A/B
 *  baseline measurement). */
export interface ApplyDeferredToolsOpts {
  enabled?: boolean;
  catalog?: readonly NativeToolCatalogEntry[];
  /** P3 웜 intent-preload (RFC §4) — 이번 턴 userText. 도메인/스코프 시그널이
   *  있으면 그 스코프의 deferred 툴을 active 로 선주입해 ToolSearch 왕복을
   *  없앤다. omit 시 웜-preload 없음(모든 deferred 툴은 P4 콜드 폴백). */
  userText?: string;
}

export function applyDeferredTools(
  messages: readonly LLMMessage[],
  tools: readonly LLMToolSpec[],
  opts: ApplyDeferredToolsOpts = {},
): ApplyDeferredToolsResult {
  const enabled = opts.enabled ?? true;
  const catalog = opts.catalog ?? nativeToolCatalog;
  if (tools.length === 0) {
    return {
      messages: messages.slice(),
      tools: [],
      stats: {
        activeCount: 0,
        deferredCount: 0,
        warmPreloaded: 0,
        unhydratableCount: 0,
        deferredNames: [],
        unhydratableNames: [],
        injected: false,
        toolSearchInjected: false,
      },
    };
  }
  if (!enabled) {
    return {
      messages: messages.slice(),
      tools: tools.slice(),
      stats: {
        activeCount: tools.length,
        deferredCount: 0,
        warmPreloaded: 0,
        unhydratableCount: 0,
        deferredNames: [],
        unhydratableNames: [],
        injected: false,
        toolSearchInjected: false,
      },
    };
  }
  // P3 — turn intent 로 웜-preload 스코프 계산(userText 있을 때만).
  const warmScopes = opts.userText
    ? warmPreloadScopesFromText(opts.userText)
    : new Set<ToolIntentScope>();
  const { active, deferred, warmPreloaded, unhydratable, toolSearchInjected } = splitDeferredToolSpecs(tools, catalog, warmScopes);
  if (deferred.length === 0) {
    return {
      messages: messages.slice(),
      tools: active,
      stats: {
        activeCount: active.length,
        deferredCount: 0,
        warmPreloaded: warmPreloaded.length,
        unhydratableCount: 0,
        deferredNames: [],
        unhydratableNames: [],
        injected: false,
        toolSearchInjected: false,
      },
    };
  }
  const block = buildDeferredToolsPromptBlock(deferred);
  const rewritten = injectDeferredAnnounce(messages, block);
  return {
    messages: rewritten,
    tools: active,
    stats: {
      activeCount: active.length,
      deferredCount: deferred.length,
      warmPreloaded: warmPreloaded.length,
      unhydratableCount: unhydratable.length,
      deferredNames: deferred.map((entry) => entry.name),
      unhydratableNames: unhydratable,
      injected: true,
      toolSearchInjected,
    },
  };
}
