/** Runs the existing gate and review seams for verb-verify. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultSeams } from '../../../src/self-implement/seams.js';
import { streamLLM } from '../../../src/llm.js';
import { resolveRoleLlm } from '../../../src/user-config.js';

type Context = {
  graphId: string;
  runId: string;
  nodeId: string;
  input: Record<string, unknown>;
  outputs: Record<string, Record<string, unknown>>;
};

export function reviewOutcome(result: { reviewed: boolean; mustFix: readonly unknown[]; verdict?: string }): 'pass' | 'fail' | 'needs-human' {
  if (!result.reviewed || result.verdict === 'needs-human') return 'needs-human';
  return result.mustFix.length === 0 && (result.verdict === 'pass' || result.verdict === 'warn') ? 'pass' : 'fail';
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`verb verify input missing: ${name}`);
  return value;
}

function context(): Context {
  const path = required(process.env.ELANOUS_GRAPH_CONTEXT, 'ELANOUS_GRAPH_CONTEXT');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid verb verify context');
  const ctx = parsed as Partial<Context>;
  if (ctx.graphId !== 'verb-verify' || !ctx.input || !ctx.outputs || !ctx.runId || !ctx.nodeId)
    throw new Error('invalid verb verify context');
  if (process.env.ELANOUS_GRAPH_DRY_RUN === '1') throw new Error('dry run must use the side-effect-free recipe');
  return ctx as Context;
}

async function run(): Promise<void> {
  const stage = process.argv[2];
  const ctx = context();
  const prepared = ctx.outputs.prepare ?? {};
  const cwd = required(prepared.worktree ?? ctx.input.worktree, 'worktree');
  const seams = defaultSeams({
    repoRoot: resolve(cwd),
    elanousBinRoot: resolve(import.meta.dir, '../../..'),
    llmReview: async (prompt) => streamLLM([{ role: 'user', content: prompt }], () => {}, { model: resolveRoleLlm('review').model }),
  });

  if (stage === 'gate') {
    if (ctx.nodeId !== 'gate') throw new Error(`verb verify node mismatch: ${ctx.nodeId} / gate`);
    const result = await seams.gate(cwd, { runId: ctx.runId });
    process.stdout.write(`${JSON.stringify({ outcome: result.passed ? 'pass' : 'fail', passed: result.passed,
      'gate-log': result.log ?? '' })}\n`);
    return;
  }
  if (stage === 'review') {
    if (ctx.nodeId !== 'review') throw new Error(`verb verify node mismatch: ${ctx.nodeId} / review`);
    if (!seams.reviewDiff) throw new Error('verb verify review seam unavailable');
    const intent = required(prepared['review-intent'] ?? ctx.input.ask, 'review-intent');
    const result = await seams.reviewDiff(cwd, { runId: ctx.runId, goal: intent,
      gateEvidenceNote: typeof ctx.outputs.gate?.['gate-log'] === 'string' ? ctx.outputs.gate['gate-log'] : undefined });
    const outcome = reviewOutcome(result);
    process.stdout.write(`${JSON.stringify({ outcome, verdict: result.verdict, reviewed: result.reviewed,
      ...(result.failureReason ? { 'failure-reason': result.failureReason } : {}),
      'must-fix': result.mustFix, 'review-summary': result.summary })}\n`);
    return;
  }
  throw new Error(`unknown verb verify stage: ${stage ?? '<missing>'}`);
}

if (import.meta.main) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
