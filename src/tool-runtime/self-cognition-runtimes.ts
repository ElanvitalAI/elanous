import { createRequire } from 'node:module';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { debug } from '../debug/log.js';
import type { LLMToolSpec } from '../llm.js';
import type { NativeToolCatalogEntry } from '../native-tool-catalog.js';
import type { ToolRunResult, ToolRuntime, ToolRuntimeContext } from './types.js';

/** Canonical names for the read-only self-cognition surface. */
export const SELF_COGNITION_TOOL_NAMES = [
  'self_recall',
  'logs_query',
  'ops_status',
  'memory_recall',
] as const;

type SelfCognitionToolName = (typeof SELF_COGNITION_TOOL_NAMES)[number];
type RecallToolName = 'memory_recall' | 'self_recall';
type CoreToolsModule = typeof import('../domains/core-tools.js');

const require = createRequire(import.meta.url);

function coreTools(): CoreToolsModule {
  return require('../domains/core-tools.js') as CoreToolsModule;
}

function coreSpec(name: SelfCognitionToolName): LLMToolSpec {
  const spec = coreTools().CORE_TOOL_SPECS.find(candidate => candidate.name === name);
  if (!spec) throw new Error(`Missing core tool spec for self-cognition runtime '${name}'`);
  return spec;
}

function toToolRunResult(result: unknown): ToolRunResult {
  return typeof result === 'object' && result !== null
    ? result as Record<string, unknown>
    : { output: String(result) };
}

const PROGRESS_MS = 10_000;
const DEFAULT_BUDGET_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;

function hitCount(result: ToolRunResult): number {
  const data: Record<string, unknown> = result;
  return Array.isArray(data.hits) ? data.hits.length
    : Array.isArray(data.events) ? data.events.length
      : data.restored ? 1 : 0;
}

function partialResult(name: RecallToolName, result: ToolRunResult | undefined, budgetMs: number): ToolRunResult {
  const fallback = name === 'memory_recall' ? { hits: [], count: 0 } : { events: [], count: 0, docs: null };
  const snapshot: Record<string, unknown> = result ?? fallback;
  const budgetSeconds = budgetMs / 1000;
  return {
    ...snapshot,
    partial: true,
    note: `${typeof snapshot.note === 'string' ? `${snapshot.note}\n` : ''}(찾던 중 ${budgetSeconds}초에서 멈췄습니다 — 더 찾을까요?)`,
  };
}

/** A deadline returns the latest completed search stage; late results cannot replace it. */
export async function runBudgetedRecall(
  name: RecallToolName,
  args: Record<string, unknown>,
  ctx: ToolRuntimeContext,
  search: (onPartial: (result: ToolRunResult) => void) => Promise<ToolRunResult>,
  stop: () => void = () => {},
  progressAfterMs = PROGRESS_MS,
): Promise<ToolRunResult> {
  const started = Date.now();
  const budgetMs = typeof args.timeBudgetMs === 'number' && Number.isFinite(args.timeBudgetMs) && args.timeBudgetMs > 0
    ? Math.min(args.timeBudgetMs, MAX_TIMER_MS) : DEFAULT_BUDGET_MS;
  let latest: ToolRunResult | undefined;
  let settled = false;
  const query = typeof args.query === 'string' && args.query.trim()
    ? args.query.trim().replace(/\s+/g, ' ').slice(0, 80)
    : name === 'self_recall' ? '자기 구현·자율행동 이력' : '최근 발송·대화';
  const log = (event: 'progress' | 'budget-hit' | 'done', result?: ToolRunResult) => {
    debug.log('tool.memory-recall', event, { elapsedMs: Date.now() - started, hits: hitCount(result ?? latest ?? {}) });
  };
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<ToolRunResult>((resolve, reject) => {
    const finish = (result: ToolRunResult, budgetHit: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(progressTimer);
      clearTimeout(budgetTimer);
      log(budgetHit ? 'budget-hit' : 'done', result);
      if (budgetHit) stop();
      resolve(result);
    };
    progressTimer = setTimeout(() => {
      if (settled) return;
      const line = `기억을 찾는 중 — ${query}`;
      ctx.emitFeedback?.({
        envelopeVersion: 1,
        sessionId: ctx.sessionId ?? '',
        blockId: `${ctx.sessionId ?? 'recall'}:tool:${ctx.toolCallId ?? name}:progress`,
        parentToolCallId: ctx.toolCallId,
        kind: 'tool.progress', phase: 'delta', emittedAt: Date.now(), seq: 1,
        payload: { stream: 'generic', lines: [line] }, asciiFallback: [line],
      });
      log('progress');
    }, progressAfterMs);
    budgetTimer = setTimeout(() => finish(partialResult(name, latest, budgetMs), true), budgetMs);
    try {
      void search(result => { if (!settled) latest = result; }).then(
        result => finish(result, false),
        error => {
          if (settled) return;
          settled = true;
          clearTimeout(progressTimer);
          clearTimeout(budgetTimer);
          stop();
          reject(error);
        },
      );
    } catch (error) {
      settled = true;
      clearTimeout(progressTimer);
      clearTimeout(budgetTimer);
      stop();
      reject(error);
    }
  });
}

// Separate thread: synchronous SQLite and S3 restore must not block progress/deadline timers.
if (!isMainThread && parentPort) {
  parentPort.on('message', async ({ name, args }: { name: RecallToolName; args: Record<string, unknown> }) => {
    try {
      if (name === 'self_recall') {
        const { existsSync } = await import('node:fs');
        const { surfaceEventsDbPath, openSurfaceEventsDb, recallEvents } = await import('../domains/surface-events.js');
        if (existsSync(surfaceEventsDbPath())) {
          const db = openSurfaceEventsDb();
          try {
            const query = typeof args.query === 'string' ? args.query : '';
            const hits = recallEvents(db, {
              domain: 'elanous',
              sinceHours: typeof args.sinceHours === 'number' ? args.sinceHours : 720,
              limit: typeof args.limit === 'number' ? args.limit : 8,
              ...(query ? { query } : {}),
            });
            const events = hits.map(h => ({
              when: h.ts, tool: h.surface, kind: h.kind ?? 'impl',
              summary: (h.summary ?? h.text).slice(0, 300), score: Math.round(h.score * 1000) / 1000,
            }));
            parentPort?.postMessage({ stage: 'partial', result: { events, count: events.length, docs: null } });
          } catch { /* self_recall's episode stage is fail-soft */ } finally { db.close(); }
        }
      }
      const result = await coreTools().dispatchRecallUnbudgeted(name, args, partial => {
        parentPort?.postMessage({ stage: 'partial', result: partial });
      });
      parentPort?.postMessage({ stage: 'done', result });
    } catch (error) {
      parentPort?.postMessage({ stage: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export type RecallSearch = (name: RecallToolName, args: Record<string, unknown>, onPartial: (result: ToolRunResult) => void) => Promise<ToolRunResult>;

export function runRecall(name: RecallToolName, args: Record<string, unknown>, ctx: ToolRuntimeContext, injectedSearch?: RecallSearch, onPartial?: (result: ToolRunResult) => void): Promise<ToolRunResult> {
  const worker = injectedSearch ? undefined : new Worker(new URL(import.meta.url));
  let active = true;
  const search = (capture: (result: ToolRunResult) => void) => {
    const report = (result: ToolRunResult) => {
      if (!active) return;
      capture(result);
      onPartial?.(result);
    };
    return injectedSearch
      ? injectedSearch(name, args, report)
      : new Promise<ToolRunResult>((resolve, reject) => {
        worker!.on('message', (message: { stage: string; result?: unknown; error?: string }) => {
          if (message.stage === 'partial') report(toToolRunResult(message.result));
          else if (message.stage === 'done') resolve(toToolRunResult(message.result));
          else if (message.stage === 'error') reject(new Error(message.error));
        });
        worker!.on('error', reject);
        worker!.on('exit', code => { if (code !== 0) reject(new Error(`Recall worker exited: ${code}`)); });
        worker!.postMessage({ name, args });
      });
  };
  return runBudgetedRecall(name, args, ctx, search, () => { active = false; if (worker) void worker.terminate(); })
    .finally(() => { active = false; if (worker) void worker.terminate(); });
}

export const SELF_COGNITION_RUNTIMES: readonly ToolRuntime[] = SELF_COGNITION_TOOL_NAMES.map(name => ({
  id: name,
  get spec() {
    return coreSpec(name);
  },
  run: async (args, ctx) => name === 'memory_recall' || name === 'self_recall'
    ? runRecall(name, args, ctx)
    : toToolRunResult(await coreTools().buildCoreTools().dispatch(name, args)),
}));

/** MCP catalog metadata derived from the same name ledger as the runtimes. */
export const SELF_COGNITION_MCP_CATALOG_ENTRIES: readonly NativeToolCatalogEntry[] = SELF_COGNITION_TOOL_NAMES.map(name => ({
  id: name,
  kind: 'other',
  aliases: [name],
  displayName: name,
  description: 'Read-only self-cognition query over elanous history, memory, operations, or logs.',
  promptSummary: `\`${name}\` (read-only self-cognition query)`,
  host: ['mcp'],
  safety: ['read-only'],
  supportsParallel: true,
  defaultEnabled: true,
  intentScope: 'ops-ui',
}));
