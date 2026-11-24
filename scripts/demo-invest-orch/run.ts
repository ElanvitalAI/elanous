#!/usr/bin/env bun
// DEMO-1126-INVEST-ORCH door — one graph run of graphs/demo/invest-orch/invest-orch.yaml with the demo's handler registry.
//   bun scripts/demo-invest-orch/run.ts                     live (skills · Conatus · eln/codex/claude panel CLIs)
//   bun scripts/demo-invest-orch/run.ts --dry-run           recorded fixtures — no network, no model (rehearsal · fallback)
//   … --els                                                 each panel CLI (or simulated pane) opens as an els tab in ws «invest-demo»
//   … --question "2027 한국 증시 전망" --out <dir> --raise-decisions --json
//   bun scripts/demo-invest-orch/run.ts --prewarm-conatus   run Conatus research once (minutes) — the graph uses it for 12 h
// The run goes through the standard graph runner, so its run/node events land in the run ledger the graph view reads.
// With an els server on this host the run also shows as ONE els graph tab (workspace ELANOUS_ELS_WS, default «invest-demo»):
// fan-out branches are child runs, so parent-run-sources.ts re-addresses their node events to the parent run (--no-els-tab: off).
import { join } from 'node:path';
import { effectiveInstanceRoot, prodInstanceRoot, treeDerivedRootFor } from '../../src/instance/resolve.js';
import type { DemoInput } from './handlers.js';

// The els server is the host's operational one; resolve its socket before the run is pinned to the test universe.
const elsSocket = process.env.ELANOUS_ELS_SOCKET?.trim() || join(prodInstanceRoot(), 'els', 'els.sock');
// Test universe by default: a tree run never writes the operational ledger (CLAUDE.md «트리 = test 우주»).
if (!process.env.ELANOUS_STATE_DIR && effectiveInstanceRoot() === prodInstanceRoot()) {
  const root = treeDerivedRootFor(process.cwd());
  if (!root) { console.error('invest-orch: cannot derive a test universe for this tree — set ELANOUS_STATE_DIR'); process.exit(2); }
  process.env.ELANOUS_STATE_DIR = root;
}
const { runGraph } = await import('../../src/graph-runner/runner.js');
const { createInvestDemoHandlers, DEFAULT_QUESTION, GRAPH_DIR } = await import('./handlers.js');

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
if (flag('--help') || flag('-h')) {
  console.log('usage: bun scripts/demo-invest-orch/run.ts [--dry-run] [--els] [--question <text>] [--ticker 005930.KO] [--out <dir>] [--raise-decisions] [--no-els-tab] [--json] | --prewarm-conatus');
  process.exit(0);
}
if (flag('--prewarm-conatus')) {
  // Conatus research (investment pack → research-bridge) runs for minutes; warm it before the demo, the graph reads the cache (≤ 12 h).
  const { prewarmConatusResearch, conatusCachePath } = await import('./handlers.js');
  const t = Date.now();
  const r = await prewarmConatusResearch(value('--question') ?? DEFAULT_QUESTION);
  console.log(`Conatus research warmed in ${Math.round((Date.now() - t) / 1000)}s · ${r.summary.length} chars · ${conatusCachePath()}`);
  process.exit(0);
}
const input: DemoInput = {
  question: value('--question') ?? DEFAULT_QUESTION,
  ticker: value('--ticker') ?? '005930.KO',
  fixtures: flag('--dry-run'),
  els: flag('--els'),
  raiseDecisions: flag('--raise-decisions'),
  ...(value('--out') ? { outDir: value('--out') } : {}),
  ...(value('--sim-delay-ms') ? { simDelayMs: Number(value('--sim-delay-ms')) } : {}),
};
const started = Date.now();
let elsTab: { stop(): Promise<void> } | undefined;
if (!flag('--no-els-tab')) {
  const { observeGraphInEls } = await import('../release-loop/els-graph-observe.js');
  const { onGraphNodeLifecycle, onGraphNodeProgress, onGraphRunIdleWake } = await import('../../src/graph-runner/runner.js');
  const { parentRunSources } = await import('./parent-run-sources.js');
  elsTab = observeGraphInEls({ socketPath: elsSocket, env: { ...process.env, ELANOUS_ELS_WS: process.env.ELANOUS_ELS_WS?.trim() || 'invest-demo' },
    sources: parentRunSources('invest-orch-demo', 'plan', { onLifecycle: onGraphNodeLifecycle, onProgress: onGraphNodeProgress, onRunEnd: onGraphRunIdleWake }),
    log: (line) => console.error(line) });
}
const state = await runGraph(join(GRAPH_DIR, 'invest-orch.yaml'), { input, quiet: true, deps: { inProcessHandlers: createInvestDemoHandlers() } });
await elsTab?.stop();
const report = state.nodes.find((n) => n.nodeId === 'report');
let result: Record<string, unknown> = {};
try { result = (JSON.parse(String(report?.output)) as { result?: Record<string, unknown> }).result ?? {}; } catch { /* report missing */ }
const summary = { status: state.status, runId: state.runId, seconds: Math.round((Date.now() - started) / 100) / 10, ...result };
if (flag('--json')) console.log(JSON.stringify(summary));
else {
  console.log(`${String(result.firstLine ?? '(no report)')}`);
  console.log(`status ${state.status} · run ${state.runId} · ${summary.seconds}s`);
  if (result.consensusLine) console.log(String(result.consensusLine));
  if (result.decisionSummary) console.log(String(result.decisionSummary));
  if (result.report) console.log(`report ${String(result.report)}\ndashboard ${String(result.dashboard)}`);
}
// Conatus research may leave a skill child behind after its timeout; the run is over.
process.exit(state.status === 'done' ? 0 : 1);
