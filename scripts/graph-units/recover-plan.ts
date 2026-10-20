import { readFileSync } from 'node:fs';
import { planPrLandRecoveryForEntry, type PrLandRecoveryContext } from '../../src/cli/pr-land-recovery.js';

type GraphContext = { nodeId?: string; input?: { context?: PrLandRecoveryContext } };

try {
  const path = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!path) throw new Error('ELANOUS_GRAPH_CONTEXT missing');
  const graph = JSON.parse(readFileSync(path, 'utf8')) as GraphContext;
  const context = graph.input?.context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('recover context missing');
  console.log(JSON.stringify(planPrLandRecoveryForEntry(context, graph.nodeId ?? '')));
} catch (error) {
  console.log(JSON.stringify({ outcome: 'failed', result: { action: 'none', reason: error instanceof Error ? error.message : String(error) }, evidence: { refusal: '', label: 'invalid-input', route: null, source: 'none' } }));
}
