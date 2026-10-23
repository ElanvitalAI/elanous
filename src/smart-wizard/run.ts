import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runGraph, type GraphRunState } from '../graph-runner/runner.js';
import type { WorkflowDeps } from '../workflow-runtime/types.js';

const WIZARD_GRAPH = resolve(import.meta.dir, '../../graphs/wizard/wizard-loop.yaml');
const FIRST_RESEARCH_PATH = ['intake', 'classify', 'ground'] as const;

export interface WizardRequestRunOptions {
  /** Stable caller-supplied identity, or generated for this request. */
  runId?: string;
  /** Isolated graph-run ledger root. */
  stateRoot?: string;
  /** Injected for controlled runs; omitted to use the graph runner's production LLM. */
  callLLM?: (prompt: string) => Promise<string>;
  /** Injected command runner for isolated execution and deterministic verification. */
  runBash?: WorkflowDeps['runBash'];
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface WizardRequestRun {
  runId: string;
  status: GraphRunState['status'];
  path: string[];
  /** Observed graph edges; every record is stamped with the enclosing run identity. */
  transitions: Array<{ from: string; to: string; runId: string }>;
  state: GraphRunState;
}

/** Run one request through the wizard graph and expose its first research transition. */
export async function runWizardRequest(
  request: string,
  options: WizardRequestRunOptions = {},
): Promise<WizardRequestRun> {
  const normalizedRequest = request.trim();
  if (!normalizedRequest) throw new TypeError('wizard request must not be empty');
  if (!existsSync(WIZARD_GRAPH)) throw new Error(`wizard-loop graph is missing: ${WIZARD_GRAPH}`);

  const runId = options.runId ?? randomUUID();
  const state = await runGraph(WIZARD_GRAPH, {
    runId,
    input: { request: normalizedRequest },
    quiet: true,
    deps: {
      ...(options.stateRoot ? { root: options.stateRoot } : {}),
      ...(options.callLLM ? { callLLM: options.callLLM } : {}),
      ...(options.runBash ? { runBash: options.runBash } : {}),
      ...(options.log ? { log: options.log } : {}),
    },
  });

  if (state.runId !== runId) throw new Error(`wizard run identity changed: expected ${runId}, got ${state.runId}`);
  const transitions = state.path.slice(1).map((to, index) => ({
    from: state.path[index]!,
    to,
    runId: state.runId,
  }));
  const firstResearchPath = state.path.slice(0, Math.min(state.path.length, FIRST_RESEARCH_PATH.length));
  if (!firstResearchPath.every((nodeId, index) => nodeId === FIRST_RESEARCH_PATH[index]) ||
      (state.status === 'awaiting-approval' && firstResearchPath.length !== FIRST_RESEARCH_PATH.length)) {
    throw new Error(`wizard request did not reach the first research steps: ${firstResearchPath.join(' → ')}`);
  }

  return { runId: state.runId, status: state.status, path: [...state.path], transitions, state };
}
