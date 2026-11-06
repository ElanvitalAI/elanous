/**
 * `POST /v1/intake/pipeline-preview` — Phase 1 pipeline e2e wire (FU3).
 *
 * Verification surface for the Phase 1 modules landed 2026-05-12 (I0-I8):
 * decompose → enrich → categorize → goal_align → multi_spec → register-all.
 * Runs the full pipeline against a raw memo with **skeleton fallback
 * callables** (no real LLM / external fetch), then returns the
 * structured intermediate result + a register-all preview keyed by
 * taskKey. Nothing is persisted to TOX — this is a wire-smoke endpoint
 * so the user can confirm the modules connect end-to-end without
 * provisioning LLM/HTTP plugins first.
 *
 * Real LLM / enrich plugins land in a follow-up PR. The contract here
 * already matches the eventual full-pipeline endpoint so the PWA
 * doesn't need to refactor twice.
 */
import { type MemoDecomposition } from '../../intake-plane/decompose.js';
import { taskKey } from '../../intake-plane/categorize.js';
import { TaskStore } from '../../task-orchestrator/store.js';
import { registerAll } from '../../intake-plane/register-all.js';
import { buildRealIntakeCallables } from '../../intake-plane/runtime-callables.js';
import { runIntakePipelinePhases } from '../../intake-plane/pipeline-runner.js';
import {
  buildEnrichPlugins,
  buildSkillExecKeywordCrawlCallable,
} from '../../intake-plane/enrich-plugins.js';
import { kgsStoreSingleton } from '../../knowledge/kgs/sqlite-store.js';
import {
  recordPipelineRun,
  type PipelineRunRecord,
} from '../../intake-plane/pipeline-metrics.js';

import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { jsonResponse } from './json-response.js';

function badRequest(reason: string): Response {
  return jsonResponse({ error: 'bad_request', reason }, 400);
}

/** FU-I7e — soft validator for the inbound priorDecomposition shape.
 *  Returns true when the value carries a missions array; the prompt
 *  builder tolerates malformed task shapes downstream. */
function isPriorDecomposition(
  v: unknown,
): v is Pick<MemoDecomposition, 'missions'> {
  if (!v || typeof v !== 'object') return false;
  const missions = (v as { missions?: unknown }).missions;
  return Array.isArray(missions);
}

interface PipelinePreviewBody {
  rawText?: string;
  intakeId?: string;
  /** When true, write Mission + Task rows into an in-memory TaskStore
   *  and return the ids. Defaults to false (just structured preview). */
  register?: boolean;
  /** FU-I7d (2026-05-12) — whitelist of `taskKey` (`m-<n>/t-<n>`) to
   *  honour the per-card verdict from the PWA preview deck. Only
   *  effective when `register: true`. Empty/undefined → commit every
   *  task (pre-FU-I7d default). */
  includeTaskKeys?: string[];
  /** FU-I7e (2026-05-12) — natural-language refinement nudge on a
   *  prior decomposition. When set with `priorDecomposition`, the
   *  decompose phase re-prompts the LLM in refiner mode. Skeleton
   *  fallback ignores the hint (the LLM throw path doesn't reach the
   *  refinement prompt) — wiring is in place for FU-I7a real LLM. */
  refinementHint?: string;
  priorDecomposition?: Pick<MemoDecomposition, 'missions'>;
  /** FU-I7a (2026-05-12) — when true, wire each LLM-touching phase
   *  (decompose · categorize · goal-align · multi-spec) to the
   *  production `streamLLM` path instead of the SHARED_THROW skeleton
   *  fallback. Falls back to skeleton on a per-phase LLM error
   *  (decompose/categorize/align all opt-in to D4 by default). */
  useRealLlm?: boolean;
  /** FU-I7a — explicit LLM provider override (matches `PROVIDERS` keys
   *  in `src/llm.ts`: 'claude' · 'openai' · 'grok' · 'gemini' ·
   *  'local'). When omitted, `resolveDefaultProvider()` honours
   *  user-config → env. */
  provider?: string;
  /** FU-I7a — explicit model override. Forwarded to streamLLM as
   *  `opts.model`. When omitted, the provider's default model fires. */
  model?: string;
  /** FU-I7b (2026-05-12) — opt the enrich phase into the production
   *  plugin bundle (URL fetch · gh repo view · keyword stub). When
   *  false / omitted, the I2 orchestrator emits per-row "no plugin"
   *  diagnostics exactly as before. Decoupled from `useRealLlm` so
   *  the user can dogfood enrichment WITHOUT paying LLM cost. */
  useRealEnrich?: boolean;
}

/** FU-I7a — assemble the real callables when the body opts in. Lives
 *  inside a small thunk so the production lazy require runs only on
 *  the real-LLM path (FU3 e2e tests never hit this branch). FU-I7c
 *  reuses this helper from the commit endpoint via re-export. */
export function resolveRealIntakeCallables(body: {
  useRealLlm?: boolean;
  provider?: string;
  model?: string;
}): ReturnType<typeof buildRealIntakeCallables> | null {
  if (body.useRealLlm !== true) return null;
  return buildRealIntakeCallables({
    ...(body.provider ? { provider: body.provider } : {}),
    ...(body.model ? { model: body.model } : {}),
  });
}

export async function handleIntakePipelinePreviewPost(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  let body: PipelinePreviewBody;
  try {
    body = (await req.json()) as PipelinePreviewBody;
  } catch {
    return badRequest('invalid JSON body');
  }
  const rawText = typeof body.rawText === 'string' ? body.rawText : '';
  if (!rawText.trim()) return badRequest('rawText required');
  const intakeId = typeof body.intakeId === 'string' && body.intakeId.trim().length > 0
    ? body.intakeId.trim()
    : `preview-${Date.now().toString(36)}`;
  // I10 (2026-05-12) — capture wall-clock so the metrics row carries
  // an end-to-end duration the dogfood gate can aggregate.
  const startedAt = Date.now();

  // FU-I7a (2026-05-12) — resolve real callables once when the body
  // opts in. Each phase still degrades to skeleton on LLM error (D4
  // remains the default fallback path) — body.useRealLlm just swaps
  // which callable runs first.
  const real = resolveRealIntakeCallables(body);

  // FU-I7e — refinementHint + priorDecomposition forwarded into the
  // refiner prompt when present. Skeleton path silently ignores both.
  const refinementHint = typeof body.refinementHint === 'string' ? body.refinementHint.trim() : '';
  const priorDecomposition = isPriorDecomposition(body.priorDecomposition)
    ? body.priorDecomposition
    : undefined;

  // Shared phase runner powers both pipeline-preview (in-memory register)
  // and pipeline-commit (real TaskStore).

  // The skeleton fallback callables live inside the runner; we pass
  // only the real-LLM seams here.
  const { decomposition, enriched, categorize, align, synth } = await runIntakePipelinePhases(
    {
      rawText,
      intakeId,
      ...(refinementHint ? { refinementHint } : {}),
      ...(priorDecomposition ? { priorDecomposition } : {}),
    },
    {
      ...(real?.decompose ? { decompose: real.decompose } : {}),
      ...(real?.categorize ? { categorize: real.categorize } : {}),
      ...(real?.align ? { align: real.align } : {}),
      ...(real?.synth ? { synth: real.synth } : {}),
      // FU8 PR #3 (FU-I7b.2 · 2026-05-12) — when `useRealEnrich` is
      // on, pass the shared KGS store so the keyword adapter can hit
      // the BM25 cache before falling through to the external crawl.
      // The KGS cache-miss fallback uses the existing skill_exec path.
      // Its keyword adapter returns a transparent diagnostic summary on
      // rejection or execution failure so enrichment continues.
      ...(body.useRealEnrich === true
        ? {
            enrichPlugins: buildEnrichPlugins({
              kgsStore: kgsStoreSingleton(),
              externalKeywordCrawl: buildSkillExecKeywordCrawlCallable(),
            }),
          }
        : {}),
    },
  );

  let registerResult: unknown = null;
  if (body.register === true) {
    // In-memory store so the preview never touches the user's TOX.
    const store = new TaskStore({ path: ':memory:', noWal: true });
    try {
      const includeTaskKeys = Array.isArray(body.includeTaskKeys)
        ? body.includeTaskKeys.filter((s): s is string => typeof s === 'string')
        : undefined;
      const reg = await registerAll(
        {
          intakeId,
          rawText,
          decomposition: enriched,
          categorize,
          align,
          synth,
          ...(includeTaskKeys ? { includeTaskKeys } : {}),
        },
        { store },
      );
      registerResult = {
        missionIds: reg.missionIds,
        taskIds: reg.taskIds,
        workflows: reg.workflows.map((w) => ({ taskKey: w.taskKey, skeleton: w.skeleton })),
        errors: reg.errors,
        // FU-I7d — surface what the filter excluded so the PWA can
        // show "skipped N" + offer a re-register flow.
        skippedTaskKeys: reg.skippedTaskKeys,
        skippedMissionKeys: reg.skippedMissionKeys,
      };
    } finally {
      store.close();
    }
  }

  // I10 — emit one row to ~/.elanous/intake/pipeline-runs.jsonl. Fire-
  // and-forget; the writer swallows errors so the response shape is
  // never gated on disk-side hiccups.
  const enrichmentDiag = enriched.missions.reduce(
    (s, m) => s + m.tasks.reduce((t, task) => t + task.context.enrichments.length, 0),
    0,
  );
  const categorizeCounts = Object.values(categorize.categorizations).reduce(
    (acc, row) => {
      acc.total += 1;
      if (row.workflowEligible) acc.workflowEligible += 1;
      return acc;
    },
    { total: 0, workflowEligible: 0 } as { total: number; workflowEligible: number },
  );
  const alignPriorities = Object.entries(align.alignments).reduce(
    (acc, [, row]) => {
      acc[row.priority] = (acc[row.priority] ?? 0) + 1;
      return acc;
    },
    { high: 0, medium: 0, low: 0 } as Record<string, number>,
  );
  const metricsRow: PipelineRunRecord = {
    at: new Date(startedAt).toISOString(),
    intakeId,
    kind: 'preview',
    useRealLlm: body.useRealLlm === true,
    useRealEnrich: body.useRealEnrich === true,
    refined: refinementHint.length > 0,
    durationMs: Date.now() - startedAt,
    decomposition: {
      fallback: decomposition.fallback,
      missionCount: decomposition.missions.length,
      taskCount: decomposition.missions.reduce((s, m) => s + m.tasks.length, 0),
    },
    enrichment: { diagnosticOnly: enrichmentDiag, withSummary: 0 },
    categorize: {
      fallback: categorize.fallback,
      workflowEligible: categorizeCounts.workflowEligible,
      total: categorizeCounts.total,
    },
    align: {
      fallback: align.fallback,
      priorities: alignPriorities as { high: number; medium: number; low: number },
      dependencyCount: align.dependencies.length,
    },
    synth: {
      ok: synth.counts.ok,
      skeleton: synth.counts.skeleton,
      failed: synth.counts.failed,
      skipped: synth.counts.skipped,
    },
  };
  if (registerResult && typeof registerResult === 'object') {
    const reg = registerResult as {
      missionIds: string[];
      taskIds: string[];
      workflows: unknown[];
      errors: unknown[];
      skippedTaskKeys?: string[];
    };
    metricsRow.register = {
      missionCount: reg.missionIds.length,
      taskCount: reg.taskIds.length,
      workflowCount: reg.workflows.length,
      errorCount: reg.errors.length,
      skippedTaskCount: reg.skippedTaskKeys?.length ?? 0,
    };
  }
  recordPipelineRun(metricsRow);

  return jsonResponse({
    intakeId,
    decomposition: {
      rationale: decomposition.rationale,
      fallback: decomposition.fallback,
      missionCount: decomposition.missions.length,
      taskCount: decomposition.missions.reduce((s, m) => s + m.tasks.length, 0),
      missions: enriched.missions.map((m) => ({
        id: m.id,
        title: m.title,
        intent: m.intent ?? null,
        taskCount: m.tasks.length,
        // I7 (2026-05-12) — per-task data so the PWA cards UI can render
        // a card per task without a second fetch. Additive; existing
        // mission-level fields are unchanged so the FU3 e2e contract
        // tests keep passing.
        tasks: m.tasks.map((t) => {
          const key = taskKey(m.id, t.id);
          const cat = categorize.categorizations[key];
          const al = align.alignments[key];
          return {
            id: t.id,
            taskKey: key,
            title: t.title,
            intent: t.intent,
            confidence: t.confidence,
            urls: t.urls ?? [],
            keywords: t.keywords ?? [],
            refs: t.refs ?? [],
            enrichmentCount: t.context.enrichments.length,
            category: cat?.category ?? 'cognitive',
            workflowEligible: cat?.workflowEligible ?? false,
            priority: al?.priority ?? 'low',
          };
        }),
      })),
    },
    enrichmentCounts: {
      withSummary: 0,  // No plugins wired → none succeed.
      diagnosticOnly: enriched.missions.reduce(
        (s, m) => s + m.tasks.reduce((t, task) => t + task.context.enrichments.length, 0),
        0,
      ),
    },
    categorize: {
      fallback: categorize.fallback,
      counts: Object.values(categorize.categorizations).reduce(
        (acc, row) => {
          acc.total += 1;
          if (row.workflowEligible) acc.workflowEligible += 1;
          return acc;
        },
        { total: 0, workflowEligible: 0 } as { total: number; workflowEligible: number },
      ),
    },
    align: {
      fallback: align.fallback,
      dependencyCount: align.dependencies.length,
      priorities: Object.entries(align.alignments).reduce(
        (acc, [, row]) => {
          acc[row.priority] = (acc[row.priority] ?? 0) + 1;
          return acc;
        },
        { high: 0, medium: 0, low: 0 } as Record<string, number>,
      ),
    },
    synth: {
      counts: synth.counts,
    },
    register: registerResult,
  });
}
