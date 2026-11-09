import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_BIN_ARGS_COMPLETION_BOUNDARY, FAKE_BIN_ARGS_EVENT, canonicalizePathWithMissingTail, isSafeFakeBinEvidenceRoot, isSafeFakeBinEvidenceStateRoot, isValidFakeBinArgsEvent, simulateFakeBinArgumentResponses, type FakeBinArgsRunEvent } from './fake-bin-args-sim.js';

test('fake-bin per-argv responses preserve exact results and emit a run-bound E4/E5 receipt', () => {
  const identity = { runId: 'run-fake-bin-args-1108', missionId: 'mission-fake-bin-args-1108', taskId: 'task-fake-bin-args-1108' };
  const result = simulateFakeBinArgumentResponses(identity);

  expect(result.responses).toMatchObject([
    { name: 'tool', argv: ['auth', 'status', '--json'], stdout: 'logged-in\n', stderr: '', exitCode: 0, signal: null },
    { name: 'tool', argv: ['auth', 'login', '--device-code'], stdout: '', stderr: 'login denied\n', exitCode: 17, signal: null },
    { name: 'tool', argv: ['version'], stdout: 'default response\n', stderr: '', exitCode: 0, signal: null },
  ]);
  expect(result.calls.map((call) => call.argv)).toEqual([
    ['auth', 'status', '--json'], ['auth', 'login', '--device-code'], ['version'],
  ]);
  expect(result.event).toMatchObject({
    event: FAKE_BIN_ARGS_EVENT,
    data: { ...identity, responses: result.responses, calls: result.calls, realToolExecutions: 0, shellExecutions: 0 },
  });
  expect(isValidFakeBinArgsEvent(result.event, identity)).toBe(true);
  expect(Number.isNaN(Date.parse(result.event!.occurredAt))).toBe(false);
  expect(result.completionBoundary).toBe(FAKE_BIN_ARGS_COMPLETION_BOUNDARY);
  expect(result.realToolExecutions).toBe(0);
  expect(result.shellExecutions).toBe(0);
});

test('fake-bin completion receipt rejects corrupted response or argv evidence', () => {
  const identity = { runId: 'run-fake-bin-args-corruption', missionId: 'mission-fake-bin-args-corruption', taskId: 'task-fake-bin-args-corruption' };
  const event = simulateFakeBinArgumentResponses(identity).event!;
  const badResponse = structuredClone(event);
  Reflect.set(badResponse.data.responses[0]!, 'stdout', 'wrong output\n');
  const badCall = structuredClone(event);
  Reflect.set(badCall.data.calls[1]!, 'argv', ['auth', 'status']);

  expect(isValidFakeBinArgsEvent(badResponse, identity)).toBe(false);
  expect(isValidFakeBinArgsEvent(badCall, identity)).toBe(false);
});

test('fake-bin evidence rejects a symlink-resolved state root outside the isolated test directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'fake-bin-evidence-root-'));
  const repo = join(root, 'repo');
  const productionRoot = join(repo, '.elanous-prod');
  const requestedTestRoot = join(repo, '.elanous-test');
  try {
    mkdirSync(repo);
    mkdirSync(productionRoot);
    symlinkSync(productionRoot, requestedTestRoot, 'dir');
    const prodSymlinkTarget = realpathSync(requestedTestRoot);
    expect(prodSymlinkTarget).toBe(realpathSync(productionRoot));
    expect(isSafeFakeBinEvidenceRoot(realpathSync(repo), requestedTestRoot, prodSymlinkTarget, prodSymlinkTarget)).toBe(false);
    const canonicalRoot = realpathSync(repo);
    expect(isSafeFakeBinEvidenceStateRoot(join(canonicalRoot, '.elanous-test'), join(canonicalRoot, '.elanous-test'), prodSymlinkTarget, prodSymlinkTarget)).toBe(false);

    rmSync(requestedTestRoot);
    const nestedTarget = join(repo, '.cache', 'nested-test-state');
    mkdirSync(dirname(nestedTarget), { recursive: true });
    mkdirSync(nestedTarget);
    symlinkSync(nestedTarget, requestedTestRoot, 'dir');
    const nestedRealPath = realpathSync(requestedTestRoot);
    expect(nestedRealPath.startsWith(`${realpathSync(repo)}/`)).toBe(true);
    expect(isSafeFakeBinEvidenceRoot(realpathSync(repo), requestedTestRoot, nestedRealPath, realpathSync(productionRoot))).toBe(false);
    const isolatedRoot = join(realpathSync(repo), '.elanous-test');
    const nestedChild = join(isolatedRoot, 'nested', 'owned-state');
    expect(isSafeFakeBinEvidenceStateRoot(isolatedRoot, nestedChild, nestedChild, realpathSync(productionRoot))).toBe(false);
    const directChild = join(isolatedRoot, 'fake-bin-args-integration-test');
    expect(isSafeFakeBinEvidenceStateRoot(isolatedRoot, directChild, directChild, realpathSync(productionRoot))).toBe(true);

    const canonicalIsolatedRoot = join(repo, '.isolated-alias-target');
    mkdirSync(canonicalIsolatedRoot);
    const aliasedHome = join(repo, 'aliased-home');
    symlinkSync(canonicalIsolatedRoot, aliasedHome, 'dir');
    const missingProductionRoot = join(aliasedHome, '.elanous');
    const canonicalMissingProductionRoot = canonicalizePathWithMissingTail(missingProductionRoot);
    const aliasedProductionState = join(canonicalIsolatedRoot, '.elanous');
    expect(canonicalMissingProductionRoot).toBe(aliasedProductionState);
    expect(isSafeFakeBinEvidenceStateRoot(canonicalIsolatedRoot, aliasedProductionState, aliasedProductionState, canonicalMissingProductionRoot)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fake-bin evidence allows an absent production root without creating or aliasing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'fake-bin-absent-prod-'));
  const repo = join(root, 'repo');
  const isolatedRoot = join(repo, '.elanous-test');
  const stateRoot = join(isolatedRoot, 'owned-child');
  const absentProductionRoot = join(root, 'isolated-home', '.elanous');
  try {
    mkdirSync(stateRoot, { recursive: true });
    expect(existsSync(absentProductionRoot)).toBe(false);
    expect(isSafeFakeBinEvidenceRoot(repo, isolatedRoot, realpathSync(isolatedRoot), absentProductionRoot)).toBe(true);
    expect(isSafeFakeBinEvidenceStateRoot(isolatedRoot, stateRoot, realpathSync(stateRoot), absentProductionRoot)).toBe(true);
    expect(existsSync(absentProductionRoot)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evidence script entry reads its canonical event before emitting E4 and E5', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const isolationRoot = join(realpathSync(repoRoot), '.elanous-test');
  if (!existsSync(isolationRoot)) mkdirSync(isolationRoot, { recursive: true });
  expect(realpathSync(isolationRoot)).toBe(isolationRoot);
  const testRoot = join(isolationRoot, `fake-bin-args-integration-${crypto.randomUUID()}`);
  const siblingRoot = join(isolationRoot, `unrelated-sibling-${crypto.randomUUID()}`);
  const testHome = join(isolationRoot, `fake-bin-args-home-${crypto.randomUUID()}`);
  const aliasedHome = join(isolationRoot, `fake-bin-args-aliased-home-${crypto.randomUUID()}`);
  const aliasedProductionState = join(isolationRoot, '.elanous');
  const siblingMarker = join(siblingRoot, 'preserve.txt');
  const scriptPath = join(repoRoot, 'scripts', 'ux-sim', 'sim-fake-bin-args-evidence.ts');
  try {
    mkdirSync(siblingRoot, { recursive: true });
    mkdirSync(testHome, { recursive: true });
    symlinkSync(isolationRoot, aliasedHome, 'dir');
    writeFileSync(siblingMarker, 'unrelated sibling state survives');
    const childEnv: NodeJS.ProcessEnv = {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      HOME: testHome,
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      ...(process.env.TZ === undefined ? {} : { TZ: process.env.TZ }),
      ELANOUS_STATE_DIR: testRoot,
    };
    const child = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: childEnv,
      encoding: 'utf8',
      timeout: 30_000,
      shell: false,
    });
    if (child.error) throw child.error;
    expect(child.signal).toBeNull();
    if (child.status !== 0) throw new Error(`evidence child failed status=${child.status} signal=${child.signal} stdout=${child.stdout} stderr=${child.stderr}`);
    expect(child.stderr).toBe('');
    expect(child.stdout).toContain(`완료 경계 실물: ${FAKE_BIN_ARGS_COMPLETION_BOUNDARY}`);
    const receiptLine = child.stdout.split(/\r?\n/u).find((line) => line.startsWith('canonical readback receipt='));
    expect(receiptLine).toBeDefined();
    const result = JSON.parse(receiptLine!.slice('canonical readback receipt='.length)) as {
      logRowId: string | number; runId: string; missionId: string; taskId: string; occurredAt: string;
      testRoot: string; productionRoot: string; storePath: string; event: FakeBinArgsRunEvent;
    };
    expect(child.stdout).toContain(`event=${FAKE_BIN_ARGS_EVENT} logRowId=${result.logRowId} runId=${result.runId} missionId=${result.missionId} taskId=${result.taskId} occurredAt=${result.occurredAt}`);
    expect(child.stdout).toContain('canonical logs readback verified');
    expect(result.event.data).toMatchObject({ runId: result.runId, missionId: result.missionId, taskId: result.taskId,
      responses: [{ argv: ['auth', 'status', '--json'], stdout: 'logged-in\n', exitCode: 0 },
        { argv: ['auth', 'login', '--device-code'], stderr: 'login denied\n', exitCode: 17 },
        { argv: ['version'], stdout: 'default response\n', exitCode: 0 }],
      calls: [{ argv: ['auth', 'status', '--json'] }, { argv: ['auth', 'login', '--device-code'] }, { argv: ['version'] }],
      realToolExecutions: 0, shellExecutions: 0,
    });
    expect(result.logRowId).toBeTruthy();
    expect(result.testRoot).toBe(testRoot);
    expect(result.testRoot.startsWith(`${isolationRoot}/`)).toBe(true);
    expect(result.testRoot).not.toBe(result.productionRoot);
    expect(result.productionRoot).toBe(join(testHome, '.elanous'));
    expect(existsSync(result.productionRoot)).toBe(false);
    expect(result.storePath).toBe(join(result.testRoot, 'logs', 'logs.db'));
    expect(result.storePath).not.toBe(join(result.productionRoot, 'logs', 'logs.db'));
    expect(child.stdout).toContain('fake executable calls=3; real tool executions=0; real shell executions=0');
    rmSync(testRoot, { recursive: true, force: true });
    expect(existsSync(siblingMarker)).toBe(true);
    expect(readFileSync(siblingMarker, 'utf8')).toBe('unrelated sibling state survives');

    const aliasedChild = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: { ...childEnv, HOME: aliasedHome, ELANOUS_STATE_DIR: aliasedProductionState },
      encoding: 'utf8',
      timeout: 30_000,
      shell: false,
    });
    if (aliasedChild.error) throw aliasedChild.error;
    expect(aliasedChild.signal).toBeNull();
    expect(aliasedChild.status).not.toBe(0);
    expect(aliasedChild.stdout).not.toContain('완료 경계 실물:');
    expect(aliasedChild.stderr).toContain('refusing unsafe state root outside the isolated test root');
    expect(existsSync(aliasedProductionState)).toBe(false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
    rmSync(siblingRoot, { recursive: true, force: true });
    rmSync(testHome, { recursive: true, force: true });
    rmSync(aliasedHome, { force: true });
  }
}, { timeout: 45_000 });
