// Persist each live-model scenario before starting the next one. A resumed run
// must use the same prompt, provider, model, evaluator source and scenarios.
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireLockAsync } from '../storage/file-lock.js';
import { summarizeLiveObservations, summarizeLiveRuns, type LiveRun, type LiveScenario } from './op-behavior-live.js';

export type EvalBinding = { model: string; provider: string; promptSha256: string; evaluatorSha256: string; scenarioSha256: string };
export type EvalCheckpoint = { version: 1; model: string; binding: EvalBinding; complete: boolean; summary: ReturnType<typeof summarizeLiveRuns>; runs: LiveRun[]; attempts: LiveRun[] };

export async function runCheckpointed(options: {
  path: string; binding: EvalBinding; scenarios: readonly LiveScenario[]; resume?: boolean;
  run: (scenario: LiveScenario) => Promise<LiveRun>;
}): Promise<EvalCheckpoint> {
  // Hold the same lock across reading, model calls and checkpoint replacement.
  // A live holder cannot be stolen on age; dead holders can be recovered.
  const lock = await acquireLockAsync(`${options.path}.lock`, { breakDeadHolder: true, maxTries: 2, retryBusyMs: 20 });
  try { return await runLocked(options, () => lock.stillHeld()); }
  finally { lock.release(); }
}

type CheckpointOptions = Parameters<typeof runCheckpointed>[0];
async function runLocked(options: CheckpointOptions, stillHeld: () => boolean): Promise<EvalCheckpoint> {
  const { path, binding, scenarios } = options;
  const assertHeld = () => { if (!stillHeld()) throw new Error('checkpoint lock lost'); };
  let attempts: LiveRun[] = [];
  if (options.resume) {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as EvalCheckpoint;
    if (saved.version !== 1 || JSON.stringify(saved.binding) !== JSON.stringify(binding) || !Array.isArray(saved.attempts)) throw new Error('checkpoint binding mismatch');
    const known = new Set(scenarios.map(s => s.id));
    if (saved.attempts.some(r => !known.has(r.scenario) || r.promptSha256 !== binding.promptSha256
      || (!r.error && (r.provider !== binding.provider || r.model !== binding.model)))) throw new Error('invalid checkpoint attempts');
    attempts = [...saved.attempts];
  }
  const snapshot = (): EvalCheckpoint => {
    const latest = new Map(attempts.map(r => [r.scenario, r]));
    const runs = scenarios.flatMap(s => { const result = latest.get(s.id); return result ? [result] : []; });
    const summary = summarizeLiveRuns(runs);
    const complete = runs.length === scenarios.length && summary.errors === 0;
    const observations = summarizeLiveObservations(runs);
    const checkpoint: EvalCheckpoint & { observations: ReturnType<typeof summarizeLiveObservations> } = { version: 1, model: binding.model, binding, complete, summary: { ...summary, rate: complete ? summary.rate : null },
      observations: complete ? observations : { ...observations, declaredRequestedOrUnconfirmed: null, toolHumanHandoffs: null }, runs, attempts: [...attempts] };
    return checkpoint;
  };
  const serialize = () => JSON.stringify(snapshot(), null, 2) + '\n';
  assertHeld();
  if (!options.resume) writeFileSync(path, serialize(), { flag: 'wx', mode: 0o600 });
  const persist = () => {
    const tmp = join(dirname(path), `.op-eval-${randomUUID()}.tmp`);
    try { assertHeld(); writeFileSync(tmp, serialize(), { flag: 'wx', mode: 0o600 }); assertHeld(); renameSync(tmp, path); }
    finally { try { unlinkSync(tmp); } catch { /* renamed or not created */ } }
  };
  for (const scenario of scenarios) {
    const previous = [...attempts].reverse().find(r => r.scenario === scenario.id);
    if (previous && !previous.error) continue;
    assertHeld();
    const result = await options.run(scenario);
    if (result.scenario !== scenario.id || result.promptSha256 !== binding.promptSha256
      || (!result.error && (result.provider !== binding.provider || result.model !== binding.model))) throw new Error('scenario, prompt, or provider mismatch');
    attempts.push(result);
    persist();
    // Provider errors are not behaviour failures. Keep their receipt and allow
    // an explicit later resume instead of repeating the same broken call six times.
    if (result.error) break;
  }
  return snapshot();
}
