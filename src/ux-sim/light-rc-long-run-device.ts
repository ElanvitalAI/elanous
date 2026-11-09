import { formatLightRc, runLightRc, type LightRcDeps } from '../release-loop/light-rc.js';
import type { GateResult } from '../../scripts/release-loop/gate-node.js';

const SHA = 'c'.repeat(40);
type SimulationResult = { pass: boolean; completedAfterHold: boolean; result: string[] };

export async function runLightRcLongRunSimulation(version = '0.3.5'): Promise<SimulationResult> {
  let releaseGate!: (value: GateResult) => void;
  let startedGate!: () => void;
  const gateStarted = new Promise<void>((resolve) => { startedGate = resolve; });
  let settled = false;
  const gateResult = new Promise<GateResult>((resolve) => { releaseGate = resolve; });
  const deps: LightRcDeps = {
    cwd: process.cwd(),
    git: (args) => ({ rc: 0, stdout: `${SHA}\n` }),
    previousVersion: () => '0.3.4',
    runFormalHostGate: async () => { startedGate(); return gateResult; },
  };
  const pending = runLightRc(version, { base: SHA, head: SHA, remote: 'aws1', log: () => {} }, deps)
    .then((value) => { settled = true; return { kind: 'result' as const, value }; }, (error) => {
      settled = true;
      return { kind: 'error' as const, error: error instanceof Error ? error.message : String(error) };
    });
  const startedOrFinished = await Promise.race([
    gateStarted.then(() => ({ kind: 'gate' as const })),
    pending.then((completion) => ({ kind: 'finished' as const, completion })),
  ]);
  if (startedOrFinished.kind === 'finished') {
    const failure = startedOrFinished.completion.kind === 'error' ? startedOrFinished.completion.error : 'light-rc completed before its host gate started';
    return { pass: false, completedAfterHold: false, result: [`⛔ light-rc simulation stopped before gate start: ${failure}`] };
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  const remainedPending = !settled;
  releaseGate({ outcome: 'error', commit: SHA, introduced: [], preexisting: 0, fixed: null, knownEnv: 0,
    knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 3_600_000, error: 'simulated long-running light-rc became unmeasured' });
  const completion = await pending;
  if (completion.kind === 'error') return { pass: false, completedAfterHold: remainedPending, result: [`⛔ light-rc simulation failed: ${completion.error}`] };
  const value = completion.value;
  const formatted = formatLightRc(value);
  const pass = remainedPending && !value.ok && value.introduced === null
    && value.unmeasured === 'simulated long-running light-rc became unmeasured'
    && formatted[0]?.startsWith('⛔') === true && !formatted.some((line) => line.includes('✅'));
  return { pass, completedAfterHold: remainedPending, result: formatted };
}
