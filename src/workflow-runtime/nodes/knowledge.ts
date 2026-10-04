import { dispatchElanousObsidianSearch } from '../../tool-runtime/elanous-obsidian-search-runtime.js';
import type { KnowledgeNode, NodeExecContext, NodeOutput, WorkflowDeps } from '../types.js';
import { interpolate } from '../variables.js';

export async function executeKnowledgeNode(
  node: KnowledgeNode,
  ctx: NodeExecContext,
  deps: WorkflowDeps,
): Promise<NodeOutput> {
  const startedAt = Date.now();
  try {
    const query = interpolate(node.knowledge.query, {
      arguments: ctx.arguments,
      artifactsDir: ctx.artifactsDir,
      outputs: ctx.outputs,
    }).text;
    const limit = node.knowledge.limit ?? 5;
    const result = await (deps.searchObsidian ?? dispatchElanousObsidianSearch)({ query, limit });
    const matches = result.matches;
    return {
      ok: true,
      output: result.error ? '' : matches.slice(0, limit)
        .map(match => `— ${match.path}:${match.lineNumber}\n${match.snippet.slice(0, 400)}`)
        .join('\n\n'),
      matches,
      ...(result.error ? { error: result.error } : matches.length === 0 ? { error: 'no matches' } : {}),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: true,
      output: '',
      matches: [],
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}
