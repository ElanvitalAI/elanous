import { readFileSync } from 'node:fs';
import { invokeResearch } from '../../../src/research-bridge/invoke.js';
import type { ExternalResearchResult } from '../../../src/research-bridge/types.js';

type GraphContext = { graphId: string; input: { ask?: unknown } };
type ResearchInvoker = (topic: string) => Promise<ExternalResearchResult>;

export interface ResearchUnitOutput {
  outcome: 'done' | 'failed';
  result: { result: { title: string; collectedAt: string; facts: string[]; sources: string[] }; evidence: Record<string, unknown> };
  evidence: Record<string, unknown>;
}

/** Keep the independent search result and its source envelope together for the downstream document unit. */
export async function researchUnitOutput(topic: string, search: ResearchInvoker = invokeResearch): Promise<ResearchUnitOutput> {
  const query = topic.trim();
  if (!query) throw new Error('verb-research input missing: ask');
  const response = await search(query);
  const sources = [...new Set((response.output.match(/https?:\/\/[^\s<>"']+/g) ?? [])
    .map((value) => value.replace(/[),.;!?]+$/, ''))
    .filter((value) => { try { new URL(value); return true; } catch { return false; } }))];
  const complete = response.ok && response.output.trim().length > 0 && sources.length > 0;
  const evidence = {
    source: response.skill,
    method: 'independent omni-crawl search',
    query,
    observedAt: response.finishedAt,
    sources,
    outcome: complete ? 'complete' : 'failed',
    ...(response.error ? { limitations: response.error } : {}),
  };
  return {
    outcome: complete ? 'done' : 'failed',
    result: {
      result: { title: query, collectedAt: response.finishedAt, facts: response.output.trim() ? [response.output.trim()] : [], sources },
      evidence,
    },
    evidence,
  };
}

async function run(): Promise<void> {
  const contextPath = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!contextPath) throw new Error('ELANOUS_GRAPH_CONTEXT is required');
  const context = JSON.parse(readFileSync(contextPath, 'utf8')) as GraphContext;
  if (context.graphId !== 'verb-research') throw new Error('invalid verb-research graph context');
  process.stdout.write(`${JSON.stringify(await researchUnitOutput(typeof context.input?.ask === 'string' ? context.input.ask : ''))}\n`);
}

if (import.meta.main) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
