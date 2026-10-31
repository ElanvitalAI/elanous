#!/usr/bin/env bun
/**
 * Isolated E4 evidence bridge: GATE-MOCK-EVENT-SCENARIOS fake devices plus the production
 * runGateNode autoheal decision/log path. It never starts a release run or a real Pod.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { debug } from '../../src/debug/log.js';
import { setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import { prodInstanceRoot } from '../../src/instance/resolve.js';
import { runGateNode, type GateResult } from './gate-node.js';
import { GATE_NODE_SIM_SCENARIOS, judgeInjectedGateEvent } from './gate-node-sim.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const testRoot = join(repoRoot, '.elanous-test');
const runId = `gate-autoheal-sim-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;

if (realpathSync(repoRoot) === realpathSync(prodInstanceRoot())) {
  throw new Error('refusing to run evidence simulation from the production state root');
}
if (process.env.ELANOUS_STATE_DIR && resolve(process.env.ELANOUS_STATE_DIR) !== resolve(testRoot)) {
  throw new Error(`ELANOUS_STATE_DIR must be this worktree test root: ${testRoot}`);
}

const scenario = GATE_NODE_SIM_SCENARIOS.find((item) => item.id === 'host-down-reroute');
if (!scenario) throw new Error('GATE-MOCK-EVENT-SCENARIOS is missing host-down-reroute');
const simulated = await judgeInjectedGateEvent(scenario);
if (simulated.outcome !== scenario.expectedOutcome || simulated.action !== scenario.action || simulated.podCommandCalls !== 0) {
  throw new Error(`fake-device scenario did not match: ${JSON.stringify(simulated)}`);
}

mkdirSync(testRoot, { recursive: true });
process.env.ELANOUS_STATE_DIR = testRoot;
process.env.ELANOUS_RUN_ID = runId;
process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({
  runId,
  input: { version: '0.2.43', previousVersion: '0.2.42', commit: 'a'.repeat(40) },
  outputs: {},
});
setElanousConfigDir(testRoot);

if (!await registerStandaloneLogSink('release-loop')) throw new Error('could not register isolated release-loop logs.db sink');

// Inject the same host-unreachable failure class through the production node's judge seam. runGateNode
// performs the real cause classification, budgeted decision, ledger write, and debug.log emission.
const injectedFailure: GateResult = {
  outcome: 'error', commit: 'a'.repeat(40), introduced: [], preexisting: 0, fixed: 0,
  knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1_000,
  error: 'gate host unreachable (simulation injection)',
};
const exitCode = await runGateNode(['--json'], process.env, undefined, async () => injectedFailure);
if (exitCode !== 2) throw new Error(`expected injected gate error exit=2, got ${exitCode}`);
debug.flush();

console.log(JSON.stringify({ label: 'simulation E4', runId, scenario: scenario.id,
  scenarioOutcome: simulated.outcome, plannerAction: simulated.action, podCommandCalls: simulated.podCommandCalls,
  injectedCause: 'host-down', expectedAutohealAction: 'host-switch', exitCode,
  store: join(testRoot, 'logs/logs.db') }));
