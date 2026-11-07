#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import { createGateRunner, GATE_ISOLATED_TIMEOUT_MS, readBaselineFileCache, saveBaselineFileCache, type GateOptions } from './gate-node.js';
import { parseFailures } from './gate-diff.js';
import { advanceGateBisectMode, runGateBisect, runGateBisectLinear, type GateBisectMeasurement, type GateBisectPlan,
  type ShadowOperationalState } from './gate-bisect.js';
import { testFileOfId } from './gate-partial.js';
import { acquireLockAsync } from '../../src/storage/file-lock.js';

type SidecarInput = {
  plan: GateBisectPlan;
  repo: string;
  ledger: string;
  path: string;
  runId: string;
  pod: Pick<NonNullable<GateOptions['pod']>, 'pool' | 'imagePin' | 'pinnedImageDigest' | 'pinnedRunId' | 'hostMirror' | 'installSlots' | 'shardTimeoutSeconds'>;
  alternatePool: string;
};

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${process.pid}-${Date.now()}.tmp`);
  try { writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    // Same-directory rename makes a complete sidecar record visible atomically.
    renameSync(temp, path);
  } finally { if (existsSync(temp)) rmSync(temp, { force: true }); }
}

function readMode(path: string): ShadowOperationalState {
  if (!existsSync(path)) return { mode: 'shadow', agreements: 0 };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schema?: unknown; state?: ShadowOperationalState };
    if (value.schema === 1 && value.state && (value.state.mode === 'shadow' || value.state.mode === 'operational')
        && Number.isSafeInteger(value.state.agreements) && value.state.agreements >= 0) return value.state;
  } catch { /* Corrupt state fails closed to shadow. */ }
  debug.log('release-loop.gate', 'bisect-mode-unmeasured', { reason: 'mode-state-unreadable', path });
  return { mode: 'shadow', agreements: 0 };
}

export async function runGateBisectSidecar(input: SidecarInput,
  measureOverride?: (file: string, commit: string, host: string) => Promise<GateBisectMeasurement>): Promise<void> {
  const runner = createGateRunner(input.repo);
  if (!measureOverride && !runner.recheckPodBatch) throw new Error('gate Pod recheck runner unavailable');
  const cacheHost = `pod:${input.alternatePool}`;
  const measure = measureOverride ?? (async (file: string, commit: string): Promise<GateBisectMeasurement> => {
    try {
      const cached = readBaselineFileCache(input.ledger, commit).get(`${file}\0${cacheHost}`);
      if (cached) return cached.errors.length ? 'unmeasured' : cached.failures.length ? 'fail' : 'pass';
      const result = (await runner.recheckPodBatch!([file], commit, { ...input.pod, pool: input.alternatePool }, GATE_ISOLATED_TIMEOUT_MS)).get(file);
      if (!result || result.timedOut || result.rc === 124 || result.rc === 137) return 'unmeasured';
      const failures = parseFailures(result.output).filter((id) => testFileOfId(id) === file);
      const status: GateBisectMeasurement = result.rc === 0 && failures.length === 0 ? 'pass' : failures.length ? 'fail' : 'unmeasured';
      if (status !== 'unmeasured') saveBaselineFileCache(input.ledger, commit,
        [{ commit, file, host: cacheHost, failures, errors: [], missing: false }]);
      return status;
    } catch { return 'unmeasured'; }
  });
  const modePath = join(input.ledger, 'release', input.plan.version, 'gate-bisect-mode.json');
  mkdirSync(dirname(modePath), { recursive: true });
  const modeLock = await acquireLockAsync(`${modePath}.lock`, { staleMs: 10 * 60_000, maxTries: 72_000 });
  try {
  const priorState = readMode(modePath);
  const evaluation = await evaluateGateBisectRun(input.plan, priorState, (file, commit) => measure(file, commit, input.alternatePool),
    (phase, event) => debug.log('release-loop.gate', 'bisect-step', { version: input.plan.version, cutCommit: input.plan.cutCommit, phase, ...event }));
  if (!modeLock.stillHeld()) throw new Error('gate bisect mode lock was lost');
  atomicJson(modePath, { schema: 1, state: evaluation.state, updatedAt: new Date().toISOString(), lastRunId: input.runId });
  debug.log('release-loop.gate', evaluation.event === 'transition' ? 'bisect-transition' : 'bisect-shadow', {
    version: input.plan.version, runId: input.runId, priorMode: priorState.mode, mode: evaluation.state.mode,
    agreements: evaluation.state.agreements, shadowDecision: evaluation.shadowDecision, operationalDecision: evaluation.operationalDecision,
  });
  const operational = evaluation.state.mode === 'operational';
  const findings = evaluation.findings;
  const unmeasured = [...evaluation.shadow.unmeasured, ...evaluation.operational.unmeasured];
  const cards = (operational && unmeasured.length === 0 ? findings : []).map((finding) => {
    // git-spawn-allow: read-only commit subject maps a verified first-failure commit to its PR.
    const subject = spawnSync('git', ['show', '-s', '--format=%s', finding.firstFailingCommit], { cwd: input.repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const pr = subject.status === 0 ? subject.stdout.match(/#(\d{4,})\b/)?.[1] : undefined;
    const lookup = pr ? spawnSync('gh', ['pr', 'view', pr, '--json', 'author,assignees', '--jq', '.assignees[0].login // .author.login'],
      { cwd: input.repo, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }) : null;
    const owner = lookup?.status === 0 ? lookup.stdout.trim() || null : null;
    const card = { ...finding, pullRequest: pr ? Number(pr) : null, owner, ownerStatus: owner ? 'resolved' : 'unresolved', evidence: input.path };
    debug.log('release-loop.gate-autoheal', 'repair-card', { version: input.plan.version, runId: input.runId, ...card });
    debug.log('release-loop.gate', 'bisect-found', { version: input.plan.version, cutCommit: input.plan.cutCommit, ...card });
    return card;
  });
  atomicJson(input.path, { ...input.plan, status: unmeasured.length ? 'partial' : operational ? 'complete' : evaluation.event === 'unmeasured' ? 'unmeasured' : 'shadow',
    shadowFindings: evaluation.shadow.findings, operationalFindings: evaluation.operational.findings, findings: cards,
    unmeasured, completedAt: new Date().toISOString() });
  } finally { modeLock.release(); }
}

export async function evaluateGateBisectRun(plan: GateBisectPlan, state: ShadowOperationalState,
  measure: (file: string, commit: string, host: string) => Promise<GateBisectMeasurement>,
  onStep: (phase: 'bisect' | 'reference', event: { file: string; commit: string; result: GateBisectMeasurement; host: string }) => void = () => {}) {
  const shadow = await runGateBisect(plan, measure, (event) => onStep('bisect', event));
  const operational = await runGateBisectLinear(plan, measure, (event) => onStep('reference', event));
  const comparable = shadow.unmeasured.length === 0 && operational.unmeasured.length === 0;
  const decision = (findings: typeof shadow.findings) => JSON.stringify(findings.map(({ file, firstFailingCommit }) => ({ file, firstFailingCommit })));
  const shadowDecision = comparable ? decision(shadow.findings) : null;
  const operationalDecision = comparable ? decision(operational.findings) : null;
  const advanced = advanceGateBisectMode(state, shadowDecision, operationalDecision, 3);
  return { ...advanced, priorState: state, shadow, operational, shadowDecision, operationalDecision,
    findings: advanced.state.mode === 'operational' ? operational.findings : [] };
}

async function main(): Promise<void> {
  const inputArg = process.argv.indexOf('--input');
  const inputPath = inputArg >= 0 ? process.argv[inputArg + 1] : undefined;
  if (!inputPath) throw new Error('--input is required');
  const input = JSON.parse(readFileSync(resolve(inputPath), 'utf8')) as SidecarInput;
  await registerStandaloneLogSink('release-loop');
  await runGateBisectSidecar(input);
}

if (import.meta.main) {
  try { await main(); }
  catch (error) { debug.log('release-loop.gate', 'bisect-sidecar-failed', { error: String(error) }); process.exitCode = 1; }
}
