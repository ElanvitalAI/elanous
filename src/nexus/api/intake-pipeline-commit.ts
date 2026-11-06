/**
 * `POST /v1/intake/pipeline-commit` — Phase 1 pipeline real-register (FU-I7c).
 *
 * Sibling of `/v1/intake/pipeline-preview` (FU3) but writes Mission +
 * Task rows into the user's **real** TaskStore (`~/.elanous/tasks/tasks.db`,
 * TOX_SCHEMA_VERSION=2 with `tox_missions`) and persists workflow YAMLs
 * into `~/.elanous/workflows/`. Until this endpoint landed, the only
 * register surface (`pipeline-preview` with `register: true`) wrote to
 * an in-memory store so the user could verify the pipeline without
 * touching production data.
 *
 * Same body schema as preview so the PWA only swaps the path; `register`
 * is implicit here (the endpoint *is* the register). All other FU
 * flags (`useRealLlm` · `provider` · `model` · `includeTaskKeys` ·
 * `refinementHint` · `priorDecomposition`) honoured the same way.
 *
 * Auth + bad-body handling mirrors `pipeline-preview` so the wire
 * contract stays consistent (a curl that worked on preview swaps to
 * commit with no code changes).
 *
 * Cross-ref:
 *   src/intake-plane/pipeline-runner.ts (5-phase shared runner)
 *   src/intake-plane/register-all.ts (real TaskStore writer · I8)
 *   src/workflow-runtime/storage.ts (saveWorkflow disk writer)
 *   src/nexus/api/intake-pipeline-preview.ts (FU3 sibling)
 */
import { type MemoDecomposition } from '../../intake-plane/decompose.js';
import { taskKey } from '../../intake-plane/categorize.js';
import { TaskStore } from '../../task-orchestrator/store.js';
import {
  registerAll,
  type SaveWorkflowCallable,
} from '../../intake-plane/register-all.js';
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
import { saveWorkflow as saveWorkflowToDisk } from '../../workflow-runtime/storage.js';

import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { jsonResponse } from './json-response.js';
import { resolveRealIntakeCallables } from './intake-pipeline-preview.js';

function badRequest(reason: string): Response {
  return jsonResponse({ error: 'bad_request', reason }, 400);
}

function isPriorDecomposition(
  v: unknown,
): v is Pick<MemoDecomposition, 'missions'> {
  if (!v || typeof v !== 'object') return false;
  const missions = (v as { missions?: unknown }).missions;
  return Array.isArray(missions);
}

interface PipelineCommitBody {
  rawText?: string;
  intakeId?: string;
  /** FU-I7d — whitelist of `taskKey`s. Reject/defer cards excluded. */
  includeTaskKeys?: string[];
  /** FU-I7e — refinement nudge + prior decomposition. */
  refinementHint?: string;
  priorDecomposition?: Pick<MemoDecomposition, 'missions'>;
  /** FU-I7a — real LLM wire. */
  useRealLlm?: boolean;
  provider?: string;
  model?: string;
  /** FU-I7b — production enrichment plugin bundle. Same surface as
   *  `pipeline-preview` so the commit flow honours whichever toggle
   *  state the PWA last applied. */
  useRealEnrich?: boolean;
}

/** FU-I7c — production SaveWorkflowCallable adapter. Bridges the I8
 *  callable contract (`{name, yaml, scope, skeleton, taskKey}` →
 *  `{ok, path}|{ok:false, error}`) to the workflow-runtime
 *  `saveWorkflow()` disk writer. `scope` defaults to 'global' so the
 *  YAML lives under `~/.elanous/workflows/` (matches R3 `elanous workflow
 *  synth` save destination); a project scope could be threaded later
 *  via body opts. */
function buildProductionSaveWorkflowCallable(): SaveWorkflowCallable {
  return async ({ name, yaml, scope, meta }) => {
    // M4-3.2 (FU8 PR #8 · 2026-05-12) — merge provenance into the
    // YAML before the disk writer validates it. The synth output
    // YAML never carries `_meta`, so we just append a `_meta:` block
    // at the end (YAML parsers honor the top-level merge). When the
    // upstream YAML already has `_meta`, we replace the block so
    // register-all's missionId binding always wins.
    const stampedYaml = stampWorkflowMeta(yaml, meta);
    const result = saveWorkflowToDisk(name, stampedYaml, {
      scope: scope ?? 'global',
    });
    if (!result.ok) {
      const validationMessage = result.validation && !result.validation.ok
        ? (result.validation.issues[0]?.message ?? 'validation_failed')
        : null;
      return {
        ok: false,
        error: result.error ?? validationMessage ?? 'save_failed',
      };
    }
    return { ok: true, path: result.path ?? `~/.elanous/workflows/${name}.yaml` };
  };
}

/** M4-3.2 — merge a `_meta` block into a workflow YAML string.
 *
 * Implementation deliberately string-level rather than parse +
 * re-serialize so we don't depend on a YAML AST library + we
 * never accidentally rewrite the user-authored body. Strips any
 * existing top-level `_meta:` block (everything from the line
 * starting with `_meta:` to the next non-indented line) then
 * appends a fresh block. Exported for unit testing. */
export function stampWorkflowMeta(
  yaml: string,
  meta?: { missionId?: string; intakeId?: string; sourceTaskKey?: string },
): string {
  if (!meta || (!meta.missionId && !meta.intakeId && !meta.sourceTaskKey)) {
    return yaml;
  }
  const lines = yaml.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (skipping) {
      // Continue skipping indented lines (the `_meta:` block body).
      if (line.length === 0 || line.startsWith(' ') || line.startsWith('\t')) {
        continue;
      }
      skipping = false;
    }
    if (/^_meta:\s*$/.test(line)) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  out.push('_meta:');
  if (meta.missionId) out.push(`  missionId: ${escapeYamlScalar(meta.missionId)}`);
  if (meta.intakeId) out.push(`  intakeId: ${escapeYamlScalar(meta.intakeId)}`);
  if (meta.sourceTaskKey) out.push(`  sourceTaskKey: ${escapeYamlScalar(meta.sourceTaskKey)}`);
  out.push('');
  return out.join('\n');
}

/** Wrap a scalar in single quotes when it contains characters that
 *  YAML would otherwise interpret (`:` is the main offender —
 *  `mission:abc` would be misread as a key/value pair). Booleans /
 *  numbers / nulls aren't a concern here because the recognised
 *  `_meta` fields are all strings. */
function escapeYamlScalar(s: string): string {
  return /[:#&*!|>'"%@`]/.test(s) ? `'${s.replace(/'/g, "''")}'` : s;
}

export async function handleIntakePipelineCommitPost(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  let body: PipelineCommitBody;
  try {
    body = (await req.json()) as PipelineCommitBody;
  } catch {
    return badRequest('invalid JSON body');
  }
  const rawText = typeof body.rawText === 'string' ? body.rawText : '';
  if (!rawText.trim()) return badRequest('rawText required');
  const intakeId = typeof body.intakeId === 'string' && body.intakeId.trim().length > 0
    ? body.intakeId.trim()
    : `commit-${Date.now().toString(36)}`;
  const startedAt = Date.now();

  const real = resolveRealIntakeCallables({
    useRealLlm: body.useRealLlm,
    ...(body.provider ? { provider: body.provider } : {}),
    ...(body.model ? { model: body.model } : {}),
  });

  const refinementHint = typeof body.refinementHint === 'string' ? body.refinementHint.trim() : '';
  const priorDecomposition = isPriorDecomposition(body.priorDecomposition)
    ? body.priorDecomposition
    : undefined;

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
      // The shared KGS store short-circuits keyword crawls through the
      // BM25 cache. Cache misses use the existing skill_exec path, whose
      // adapter returns transparent failure summaries so enrichment continues.
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

  // FU-I7c — production TaskStore (no `:memory:`). The bare `new
  // TaskStore()` constructor reads `~/.elanous/tasks/tasks.db` (the
  // user's TOX) — same pattern as `tasks-scheduler.ts` handlers.
  const store = new TaskStore();
  const saveWorkflow = buildProductionSaveWorkflowCallable();
  let registerPayload: unknown;
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
      // FU8 follow-up #1 (2026-05-12) — inject the shared KGS store
      // as the `kgsMissionWriter` so every committed Mission row
      // also produces a `mission:<id>` KnowledgeCard. The same
      // singleton is already used by the keyword-crawl adapter, so
      // boot cost stays single-instance.
      { store, saveWorkflow, kgsMissionWriter: kgsStoreSingleton() },
    );
    registerPayload = {
      missionIds: reg.missionIds,
      taskIds: reg.taskIds,
      workflows: reg.workflows.map((w) => ({
        taskKey: w.taskKey,
        skeleton: w.skeleton,
        path: w.path,
      })),
      errors: reg.errors,
      skippedTaskKeys: reg.skippedTaskKeys,
      skippedMissionKeys: reg.skippedMissionKeys,
    };
  } finally {
    store.close();
  }

  // I10 (2026-05-12) — emit dogfood metrics row.
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
  const reg = registerPayload as {
    missionIds: string[];
    taskIds: string[];
    workflows: unknown[];
    errors: unknown[];
    skippedTaskKeys: string[];
  };
  const metricsRow: PipelineRunRecord = {
    at: new Date(startedAt).toISOString(),
    intakeId,
    kind: 'commit',
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
    register: {
      missionCount: reg.missionIds.length,
      taskCount: reg.taskIds.length,
      workflowCount: reg.workflows.length,
      errorCount: reg.errors.length,
      skippedTaskCount: reg.skippedTaskKeys.length,
    },
  };
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
      withSummary: 0,
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
    register: registerPayload,
  });
}
