/** Executes the existing self-implement seam for a verb unit's document draft. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ChildLlmSelection } from '../../../src/agent/run-context.js';
import { defaultSeams } from '../../../src/self-implement/seams.js';

type Context = {
  graphId: string;
  runId: string;
  nodeId: string;
  input: Record<string, unknown>;
  outputs: Record<string, Record<string, unknown>>;
};

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`verb headless-goal-loop input missing: ${name}`);
  return value;
}

function context(): Context {
  const path = required(process.env.ELANOUS_GRAPH_CONTEXT, 'ELANOUS_GRAPH_CONTEXT');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid verb graph context');
  const ctx = parsed as Partial<Context>;
  if (!['verb-make-doc', 'verb-verify'].includes(ctx.graphId ?? '') || !ctx.input || !ctx.outputs || !ctx.runId || !ctx.nodeId)
    throw new Error('invalid verb graph context');
  if (process.env.ELANOUS_GRAPH_DRY_RUN === '1') throw new Error('dry run must use the side-effect-free recipe');
  return ctx as Context;
}

function repositoryRoot(): string {
  return resolve(import.meta.dir, '../../..');
}

export function appendPriorToGoal(goal: string, prior: unknown): string {
  if (prior === null || prior === undefined) return goal;
  const serialized = JSON.stringify(prior, null, 2);
  if (!serialized) return goal;
  return `${goal}\n\n## Supplied prior research and evidence\nUse only this supplied packet for prior claims. Preserve its sources and limitations, and do not invent unsupported facts.\n\n\`\`\`json\n${serialized}\n\`\`\``;
}

export function childLlmSelectionFromRecipe(provider: string | undefined, model: string | undefined): ChildLlmSelection | undefined {
  const resolvedProvider = provider?.trim();
  const resolvedModel = model?.trim();
  if (!resolvedProvider && !resolvedModel) return undefined;
  if (!resolvedProvider || !resolvedModel) throw new Error('graph recipe child LLM requires both provider and model');
  return { provider: resolvedProvider, model: resolvedModel, source: 'config' };
}

export function implementationRequestFromContext(
  ctx: Pick<Context, 'runId' | 'input' | 'outputs'>,
  env: { ELANOUS_GRAPH_CHILD_LLM_PROVIDER?: string; ELANOUS_GRAPH_CHILD_LLM_MODEL?: string },
): { runId: string; feature: string; childLlm?: ChildLlmSelection } {
  const prepared = ctx.outputs.prepare ?? {};
  const goal = typeof prepared.goal === 'string' && prepared.goal.trim()
    ? prepared.goal
    : [ctx.input.ask, ctx.input['must-fix'], ctx.input['gate-log']].filter(Boolean).map(String).join('\n\n');
  if (!goal.trim()) throw new Error('verb headless-goal-loop input missing: goal/ask');
  const prior = prepared.prior ?? ctx.input.prior;
  const childLlm = childLlmSelectionFromRecipe(
    env.ELANOUS_GRAPH_CHILD_LLM_PROVIDER,
    env.ELANOUS_GRAPH_CHILD_LLM_MODEL,
  );
  return {
    runId: ctx.runId,
    feature: appendPriorToGoal(goal, prior),
    ...(childLlm ? { childLlm } : {}),
  };
}

export function assertIsolatedFeatureWorktree(path: string): string {
  if (!isAbsolute(path)) throw new Error('verb worktree must be absolute');
  const cwd = realpathSync(path);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  if (root !== cwd) throw new Error('verb worktree must be a git repository root');
  const gitDir = realpathSync(execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' }).trim());
  const commonDirValue = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim();
  const commonDir = realpathSync(isAbsolute(commonDirValue) ? commonDirValue : resolve(cwd, commonDirValue));
  if (gitDir === commonDir) throw new Error('verb worktree must be a separate linked Git worktree');
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).trim();
  if (!branch || branch === 'main' || branch === 'master') throw new Error('verb worktree must use an isolated feature branch');
  return cwd;
}

export function assertNoNewCommit(cwd: string, beforeHead: string): void {
  const afterHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  if (afterHead !== beforeHead) throw new Error('headless goal-loop must leave changes uncommitted for its caller');
}

function targetWorktree(ctx: Context): string {
  const prepared = ctx.outputs.prepare ?? {};
  const value = prepared.worktree ?? ctx.input.worktree;
  return assertIsolatedFeatureWorktree(required(value, 'worktree'));
}

export function outcomeForGraph(graphId: string, ok: boolean, documentDrafts: readonly string[]): 'done' | 'failed' {
  if (!ok) return 'failed';
  return graphId === 'verb-make-doc' && documentDrafts.length === 0 ? 'failed' : 'done';
}

function changedFileSnapshot(cwd: string): Map<string, string> {
  const tracked = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', 'HEAD'], { cwd, encoding: 'utf8' }).split('\0');
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8' }).split('\0');
  const snapshot = new Map<string, string>();
  for (const file of new Set([...tracked, ...untracked].filter(Boolean))) {
    try {
      snapshot.set(file, createHash('sha256').update(readFileSync(resolve(cwd, file))).digest('hex'));
    } catch { snapshot.set(file, '<missing>'); }
  }
  return snapshot;
}

async function run(): Promise<void> {
  const ctx = context();
  const cwd = targetWorktree(ctx);
  const implementationRequest = implementationRequestFromContext(ctx, {
    ELANOUS_GRAPH_CHILD_LLM_PROVIDER: process.env.ELANOUS_GRAPH_CHILD_LLM_PROVIDER,
    ELANOUS_GRAPH_CHILD_LLM_MODEL: process.env.ELANOUS_GRAPH_CHILD_LLM_MODEL,
  });
  const seams = defaultSeams({ elanousBinRoot: repositoryRoot() });
  if (!seams.implement) throw new Error('self-implement seam unavailable');
  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const beforeFiles = changedFileSnapshot(cwd);
  const result = await seams.implement({
    cwd,
    ...implementationRequest,
  });
  assertNoNewCommit(cwd, headBefore);
  const afterFiles = changedFileSnapshot(cwd);
  const changed = [...afterFiles].filter(([file, hash]) => beforeFiles.get(file) !== hash).map(([file]) => file);
  const docs = changed.filter((file) => /\.(?:md|mdx|txt|rst|adoc)$/i.test(file) && afterFiles.get(file) !== '<missing>');
  const outcome = outcomeForGraph(ctx.graphId, result.ok, docs);
  process.stdout.write(`${JSON.stringify({
    outcome,
    result: result.summary,
    evidence: {
      worktree: cwd,
      'document-drafts': docs,
      'changed-files': changed,
      'terminal-status': result.terminalStatus ?? 'unknown',
    },
  })}\n`);
}

if (import.meta.main) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
