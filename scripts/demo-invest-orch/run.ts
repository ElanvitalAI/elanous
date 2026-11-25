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

// Test universe by default: a tree run never writes the operational ledger (CLAUDE.md «트리 = test 우주»).
if (!process.env.ELANOUS_STATE_DIR && effectiveInstanceRoot() === prodInstanceRoot()) {
  const root = treeDerivedRootFor(process.cwd());
  if (!root) { console.error('invest-orch: cannot derive a test universe for this tree — set ELANOUS_STATE_DIR'); process.exit(2); }
  process.env.ELANOUS_STATE_DIR = root;
}
const { runGraph } = await import('../../src/graph-runner/runner.js');
const { createInvestDemoHandlers, DEFAULT_QUESTION, GRAPH_DIR, investElsEnv, investElsTarget } = await import('./handlers.js');

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
if (flag('--help') || flag('-h')) {
  console.log('usage: bun scripts/demo-invest-orch/run.ts [--dry-run] [--els] [--els-socket <path>] [--question <text>] [--ticker 005930.KO] [--out <dir>] [--raise-decisions] [--no-els-tab] [--json] | --prewarm-conatus');
  process.exit(0);
}
// DEMO-INVEST-ELS-TARGET: the els of the universe this run is in (default), or the one --els-socket names — never the
// operational els by default. Printed once so a rehearsal shows where its tabs go.
const elsTarget = investElsTarget(process.env, value('--els-socket'));
const elsSocket = elsTarget.socket;
console.error(`invest-orch: els target ${elsSocket}`);
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
  elsSocket,
  ...(value('--out') ? { outDir: value('--out') } : {}),
  ...(value('--sim-delay-ms') ? { simDelayMs: Number(value('--sim-delay-ms')) } : {}),
};
const started = Date.now();
let elsTab: { stop(): Promise<void> } | undefined;
let scene: { finish(dashboard?: import('../../src/tui/widgets/scenes/invest-run.js').InvestRunDashboard): Promise<void> } | undefined;
if (!flag('--no-els-tab')) {
  const { observeGraphInEls } = await import('../release-loop/els-graph-observe.js');
  const { onGraphNodeLifecycle, onGraphNodeProgress, onGraphRunIdleWake } = await import('../../src/graph-runner/runner.js');
  const { parentRunSources } = await import('./parent-run-sources.js');
  elsTab = observeGraphInEls({ socketPath: elsSocket, env: { ...investElsEnv(process.env, elsTarget), ELANOUS_ELS_WS: process.env.ELANOUS_ELS_WS?.trim() || 'invest-demo' },
    sources: parentRunSources('invest-orch-demo', 'plan', { onLifecycle: onGraphNodeLifecycle, onProgress: onGraphNodeProgress, onRunEnd: onGraphRunIdleWake }),
    log: (line) => console.error(line) });
  // DEMO-INVEST-SCENE-WIRE: the same tab draws the widget-kit scene (live panel board, then the end card).
  const { existsSync } = await import('node:fs');
  if (existsSync(elsSocket)) {
    const { feedInvestScene } = await import('./scene-feed.js');
    const { requestEls } = await import('../../src/els/client.js');
    scene = feedInvestScene({ graphYamlPath: join(GRAPH_DIR, 'invest-orch.yaml'), ticker: input.ticker ?? '005930.KO', socketPath: elsSocket, request: requestEls,
      sources: parentRunSources('invest-orch-demo', 'plan', { onLifecycle: onGraphNodeLifecycle, onProgress: onGraphNodeProgress, onRunEnd: onGraphRunIdleWake }) });
  }
}
const state = await runGraph(join(GRAPH_DIR, 'invest-orch.yaml'), { input, quiet: true, deps: { inProcessHandlers: createInvestDemoHandlers() } });
await elsTab?.stop();
const report = state.nodes.find((n) => n.nodeId === 'report');
let result: Record<string, unknown> = {};
try { result = (JSON.parse(String(report?.output)) as { result?: Record<string, unknown> }).result ?? {}; } catch { /* report missing */ }
if (scene) {
  // The end card comes from the run's real output (dashboard.json), not from the node events.
  let dashboard: import('../../src/tui/widgets/scenes/invest-run.js').InvestRunDashboard | undefined;
  try { dashboard = JSON.parse((await import('node:fs')).readFileSync(String(result.dashboard), 'utf8')); } catch { /* no dashboard: the live board stays */ }
  await scene.finish(dashboard);
}
const summary = { status: state.status, runId: state.runId, seconds: Math.round((Date.now() - started) / 100) / 10, ...result };
if (flag('--json')) console.log(JSON.stringify(summary));
else {
  const lines = Array.isArray(result.summaryLines) ? (result.summaryLines as unknown[]).map(String) : [String(result.firstLine ?? '(no report)')];
  console.log(lines[0]);
  console.log(`status ${state.status} · run ${state.runId} · ${summary.seconds}s`);
  for (const line of lines.slice(1)) console.log(line);
  if (result.report) console.log(`report ${String(result.report)}\ndashboard ${String(result.dashboard)}`);
}
// Conatus research may leave a skill child behind after its timeout; the run is over.
process.exit(state.status === 'done' ? 0 : 1);
