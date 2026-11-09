import { createFakeExecutableDevice, type FakeExecutableRun, type FakeBinCall } from './fake-bin.js';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const FAKE_BIN_ARGS_EVENT = 'sim.fake-bin-args.completed';
export const FAKE_BIN_ARGS_COMPLETION_BOUNDARY = 'three argv outcomes via fake executable; real shell executions 0';

export interface FakeBinArgsIdentity {
  runId: string;
  missionId: string;
  taskId: string;
}

export interface FakeBinArgsRunEvent {
  occurredAt: string;
  event: typeof FAKE_BIN_ARGS_EVENT;
  data: FakeBinArgsIdentity & {
    responses: FakeExecutableRun[];
    calls: FakeBinCall[];
    realToolExecutions: 0;
    shellExecutions: 0;
  };
}

export interface FakeBinArgsSimulation {
  responses: FakeExecutableRun[];
  calls: FakeBinCall[];
  event: FakeBinArgsRunEvent | null;
  completionBoundary: string | null;
  realToolExecutions: 0;
  shellExecutions: 0;
}

const EXPECTED_RESPONSES: FakeExecutableRun[] = [
  { name: 'tool', argv: ['auth', 'status', '--json'], stdout: 'logged-in\n', stderr: '', exitCode: 0, signal: null },
  { name: 'tool', argv: ['auth', 'login', '--device-code'], stdout: '', stderr: 'login denied\n', exitCode: 17, signal: null },
  { name: 'tool', argv: ['version'], stdout: 'default response\n', stderr: '', exitCode: 0, signal: null },
];
const EXPECTED_CALLS: FakeBinCall[] = EXPECTED_RESPONSES.map(({ name, argv }) => ({ name, argv }));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

/** Reject a completion receipt unless it preserves the exact fake-bin calls and their results. */
export function isValidFakeBinArgsEvent(value: unknown, expectedIdentity?: FakeBinArgsIdentity): value is FakeBinArgsRunEvent {
  if (!isRecord(value) || value.event !== FAKE_BIN_ARGS_EVENT || typeof value.occurredAt !== 'string') return false;
  const observedAt = new Date(value.occurredAt);
  if (Number.isNaN(observedAt.getTime()) || observedAt.toISOString() !== value.occurredAt) return false;
  const data = value.data;
  if (!isRecord(data)) return false;
  if (![data.runId, data.missionId, data.taskId].every((id) => typeof id === 'string' && id.length > 0)) return false;
  if (expectedIdentity && (data.runId !== expectedIdentity.runId || data.missionId !== expectedIdentity.missionId || data.taskId !== expectedIdentity.taskId)) return false;
  if (data.realToolExecutions !== 0 || data.shellExecutions !== 0) return false;
  return stableJson(data.responses) === stableJson(EXPECTED_RESPONSES)
    && stableJson(data.calls) === stableJson(EXPECTED_CALLS);
}

/** Require the created test root to resolve exactly to this worktree's isolated state directory. */
export function isSafeFakeBinEvidenceRoot(repoRoot: string, requestedTestRoot: string, actualTestRoot: string, productionRoot: string): boolean {
  const repo = resolve(repoRoot);
  const requested = resolve(requestedTestRoot);
  const actual = resolve(actualTestRoot);
  const production = resolve(productionRoot);
  const expected = resolve(repo, '.elanous-test');
  const relativeToRepo = relative(repo, actual);
  const insideRepo = relativeToRepo !== '' && relativeToRepo !== '..' && !relativeToRepo.startsWith(`..${sep}`) && !isAbsolute(relativeToRepo);
  return requested === expected && actual === expected && actual !== production && insideRepo;
}

/** Allow only the isolated root itself or one direct owned child beneath it; reject nested symlink escapes. */
export function isSafeFakeBinEvidenceStateRoot(isolatedRoot: string, requestedStateRoot: string, actualStateRoot: string, productionRoot: string): boolean {
  const root = resolve(isolatedRoot);
  const requested = resolve(requestedStateRoot);
  const actual = resolve(actualStateRoot);
  const production = resolve(productionRoot);
  const relativeRequested = relative(root, requested);
  const directChild = relativeRequested !== '' && relativeRequested !== '..'
    && !relativeRequested.startsWith(`..${sep}`) && !isAbsolute(relativeRequested) && !relativeRequested.includes(sep);
  const relativeActual = relative(root, actual);
  const actualInside = relativeActual === '' || (relativeActual !== '..' && !relativeActual.startsWith(`..${sep}`)
    && !isAbsolute(relativeActual) && !relativeActual.includes(sep));
  return (requested === root || directChild) && actual === requested && actualInside && actual !== production;
}

/** Canonicalize a path even when its final directory has not been created yet. */
export function canonicalizePathWithMissingTail(path: string): string {
  let existingAncestor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error(`no existing ancestor for path: ${path}`);
    missing.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  return resolve(realpathSync(existingAncestor), ...missing);
}

/** Exercise the existing per-argv response API through its registered fake executable only. */
export function simulateFakeBinArgumentResponses(identity: FakeBinArgsIdentity): FakeBinArgsSimulation {
  const device = createFakeExecutableDevice({ tool: {
    stdout: 'default response\n',
    exitCode: 0,
    responses: [
      { argsStartWith: ['auth', 'status'], stdout: 'logged-in\n', exitCode: 0 },
      { argsStartWith: ['auth', 'login'], stderr: 'login denied\n', exitCode: 17 },
    ],
  } });
  try {
    device.run('tool', ['auth', 'status', '--json']);
    device.run('tool', ['auth', 'login', '--device-code']);
    device.run('tool', ['version']);
    const responses = device.runs();
    const calls = device.calls();
    const occurredAt = new Date().toISOString();
    const candidateEvent: FakeBinArgsRunEvent = {
      occurredAt,
      event: FAKE_BIN_ARGS_EVENT,
      data: { ...identity, responses, calls, realToolExecutions: 0, shellExecutions: 0 },
    };
    const valid = isValidFakeBinArgsEvent(candidateEvent, identity);
    return {
      responses,
      calls,
      event: valid ? candidateEvent : null,
      completionBoundary: valid ? FAKE_BIN_ARGS_COMPLETION_BOUNDARY : null,
      realToolExecutions: 0,
      shellExecutions: 0,
    };
  } finally {
    device.cleanup();
  }
}
