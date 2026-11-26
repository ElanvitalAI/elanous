// GOAL-ORCHESTRATION-NL — the five pattern templates (orchestration/v1). The planner starts from one of these and
// fills goal/items; `eln orchestrate plan --template <pattern>` prints one as-is.
import { ORCHESTRATION_API, type OrchestrationPattern, type OrchestrationSpec } from './spec.js';

const LIMITS = { maxParallel: 4, timeoutSec: 300, budgetUsd: 2, maxRounds: 2 };

export function templateFor(pattern: OrchestrationPattern, goal: string, items: readonly string[] = []): OrchestrationSpec {
  const base = { api: ORCHESTRATION_API, goal, limits: LIMITS } as const;
  switch (pattern) {
    case 'map-reduce':
      return { ...base, pattern, tasks: items.length ? items : ['option A', 'option B', 'option C'],
        workers: [
          { id: 'eln-analyst', kind: 'eln', role: 'analyst' },
          { id: 'codex-analyst', kind: 'codex', role: 'analyst' },
          { id: 'claude-analyst', kind: 'claude', role: 'analyst', model: 'haiku' },
        ],
        reduce: { method: 'llm-summary', success: 'min-items:3' }, layout: { grid: 'auto', spotlight: 'verdict' } };
    case 'pipeline':
      return { ...base, pattern, tasks: items.length >= 2 ? items : ['write a first draft', 'review the draft and list concrete fixes', 'revise the draft applying every fix'],
        workers: [
          { id: 'writer', kind: 'claude', role: 'writer', model: 'haiku' },
          { id: 'reviewer', kind: 'codex', role: 'reviewer' },
          { id: 'reviser', kind: 'eln', role: 'editor' },
        ],
        reduce: { method: 'last', success: 'min-length:400' }, layout: { grid: 'auto', spotlight: 'active' } };
    case 'panel':
      return { ...base, pattern, tasks: items,
        workers: [
          { id: 'optimist', kind: 'eln', role: 'panelist', persona: 'optimist — argues for' },
          { id: 'skeptic', kind: 'codex', role: 'panelist', persona: 'skeptic — argues against' },
          { id: 'risk', kind: 'claude', role: 'panelist', persona: 'risk officer — names what can fail', model: 'haiku' },
        ],
        reduce: { method: 'vote', success: 'all-ok' }, layout: { grid: 'auto', spotlight: 'verdict' } };
    case 'supervisor-workers':
      return { ...base, pattern, tasks: items,
        workers: [
          { id: 'supervisor', kind: 'claude', role: 'supervisor', model: 'haiku' },
          { id: 'worker-1', kind: 'eln', role: 'worker' },
          { id: 'worker-2', kind: 'codex', role: 'worker' },
        ],
        reduce: { method: 'llm-summary', success: 'all-ok' }, layout: { grid: 'auto', spotlight: 'active' } };
    case 'loop-until':
      return { ...base, pattern, tasks: items, limits: { ...LIMITS, maxRounds: 3 },
        workers: [{ id: 'iterator', kind: 'eln', role: 'iterator' }],
        reduce: { method: 'last', success: 'llm-judge' }, layout: { grid: 'auto', spotlight: 'active' } };
  }
}

/** Scenario presets (대표 11-26): a goal that reads like one of these starts from its full spec — data workers with their
 *  `fetch` command, the reduce, and (market brief) a publish node. Commands use this machine's CLIs and the existing
 *  secret resolver; nothing here starts a VM. Edit the YAML before confirming to change sources. */
export interface Preset { readonly id: string; readonly match: RegExp; readonly build: (goal: string) => OrchestrationSpec }
export const PRESETS: readonly Preset[] = [
  {
    id: 'market-brief',
    match: /시장\s*브리핑|시황\s*브리핑|market\s+brief/iu,
    build: (goal) => ({
      api: ORCHESTRATION_API, goal, pattern: 'map-reduce',
      tasks: ['news — headlines that move tomorrow\'s open', 'X — what traders and analysts are saying', 'YouTube — expert market talks', 'prices & flows — index, majors, foreign/institutional flows, FX'],
      workers: [
        // DEMO-SOURCES-VIA-SECRET (대표 11-26): every desk is a real provider with its key from `eln secret`; each item
        // carries { provider, url, fetchedAt } into the reduce and the 출처 section. No key / failed call → «source
        // unavailable» in the tile and no claim in the brief.
        { id: 'news', kind: 'eln', role: 'news desk (Firecrawl · Brave)', fetch: 'eln orchestrate source news "내일 코스피 전망 증시 뉴스"' },
        { id: 'x-pulse', kind: 'eln', role: 'social desk (X)', fetch: 'eln orchestrate source x "코스피 반도체 외국인 수급 전망"' },
        { id: 'youtube', kind: 'eln', role: 'video desk (Supadata)', fetch: 'eln orchestrate source youtube "증시 전망 내일 코스피"' },
        { id: 'prices', kind: 'eln', role: 'market data desk (EODHD · KIS · KRX)', fetch: 'eln orchestrate source market' },
      ],
      reduce: { method: 'llm-summary', success: 'min-length:300' },
      layout: { grid: 'auto', spotlight: 'verdict' },
      limits: { maxParallel: 4, timeoutSec: 240, budgetUsd: 1, maxRounds: 2 },
      voice: true,
      publish: { title: 'Publish · PDF + voice → Telegram', command: 'bash "${ORCH_PUBLISH_BRIEF:?set ORCH_PUBLISH_BRIEF to the brief publish script}" "$ORCH_RESULT_FILE" "$ORCH_RUN_DIR" ${ORCH_PUBLISH_ARGS:-}' },
    }),
  },
  {
    id: 'contract-review',
    match: /계약서\s*검토|review (this|the) contract/iu,
    build: (goal) => ({
      api: ORCHESTRATION_API, goal, pattern: 'panel', tasks: ['clauses that shift risk to us', 'missing protections', 'redline suggestions'],
      workers: [
        { id: 'counsel-eln', kind: 'eln', role: 'reviewer', persona: 'commercial counsel' },
        { id: 'counsel-codex', kind: 'codex', role: 'reviewer', persona: 'risk analyst' },
        { id: 'counsel-claude', kind: 'claude', role: 'reviewer', persona: 'plain-language editor', model: 'haiku' },
      ],
      reduce: { method: 'consensus', success: 'all-ok' }, layout: { grid: 'auto', spotlight: 'verdict' }, limits: LIMITS,
    }),
  },
  {
    id: 'competitor-table',
    match: /경쟁사.*(조사|비교)|compare competitors/iu,
    build: (goal) => ({
      api: ORCHESTRATION_API, goal, pattern: 'map-reduce', tasks: ['competitor #1', 'competitor #2', 'competitor #3'],
      workers: [
        { id: 'web', kind: 'eln', role: 'web researcher' },
        { id: 'social', kind: 'eln', role: 'social researcher' },
        { id: 'analyst', kind: 'codex', role: 'analyst' },
      ],
      reduce: { method: 'llm-summary', success: 'contains:|' }, layout: { grid: 'auto', spotlight: 'verdict' }, limits: LIMITS,
    }),
  },
  {
    id: 'youtube-digest',
    match: /유튜브.*(요약|정리)|youtube.*(digest|summar)/iu,
    build: (goal) => ({
      api: ORCHESTRATION_API, goal, pattern: 'map-reduce', tasks: ['latest video 1', 'latest video 2', 'latest video 3'],
      workers: [{ id: 'video', kind: 'eln', role: 'video summarizer' }, { id: 'video-b', kind: 'claude', role: 'video summarizer', model: 'haiku' }],
      reduce: { method: 'llm-summary', success: 'min-items:2' }, layout: { grid: 'auto', spotlight: 'verdict' }, limits: LIMITS,
    }),
  },
  {
    id: 'bug-fix',
    match: /버그.*(재현|수정)|reproduce.*fix|fix (this|the) bug/iu,
    build: (goal) => ({
      api: ORCHESTRATION_API, goal, pattern: 'pipeline', tasks: ['reproduce the bug and write the failing steps', 'propose the minimal fix as a diff', 'verify the fix against the repro and list what was checked'],
      workers: [{ id: 'repro', kind: 'codex', role: 'reproducer' }, { id: 'fix', kind: 'claude', role: 'fixer', model: 'haiku' }, { id: 'verify', kind: 'eln', role: 'verifier' }],
      reduce: { method: 'last', success: 'llm-judge' }, layout: { grid: 'auto', spotlight: 'active' }, limits: LIMITS,
    }),
  },
];

export function presetFor(goal: string): Preset | undefined { return PRESETS.find((p) => p.match.test(goal)); }
