import { test, expect, describe, spyOn } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { debug } from '../../debug/log.js';
import { createTask, type Task } from '../types.js';
import {
  createSelfImplementAdapter,
  defaultSelfImplementSpawn,
  parseSelfImplementJson,
  resolveSpawnElanousBin,
  type SelfImplementJobSpawn,
  type SelfImplementJobDone,
  reportUnmappedDispositionFields,
} from './self-implement.js';

function makeTask(feature = 'add a helper', extra: Record<string, unknown> = {}): Task {
  return createTask({
    title: 'self-dev job',
    surface: { kind: 'self-implement', feature, ...extra },
    isolation: 'worktree',
  });
}

async function assertDefaultSpawnBin(cwd: string, expectedBin: string, expectedBinSource: string): Promise<void> {
  const shimDir = mkdtempSync(join(tmpdir(), 'self-implement-bun-shim-'));
  const capturePath = join(shimDir, 'spawn.txt');
  const bunShim = join(shimDir, 'bun');
  writeFileSync(bunShim, '#!/bin/sh\nprintf "%s\\n%s\\n%s\\n%s\\n" "$(pwd -P)" "$1" "$4" "$(cat "$5")" > "$ELANOUS_TEST_SPAWN_CAPTURE"\n');
  chmodSync(bunShim, 0o755);
  const launches: Array<{ bin: unknown; binSource: unknown }> = [];
  const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    if (category === 'self-dev.spawn' && event === 'launch') launches.push({ bin: data?.bin, binSource: data?.binSource });
  }) as typeof debug.log);
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const originalCapture = process.env.ELANOUS_TEST_SPAWN_CAPTURE;
  try {
    process.env.PATH = `${shimDir}:${originalPath ?? ''}`;
    process.env.ELANOUS_TEST_SPAWN_CAPTURE = capturePath;
    process.chdir(cwd);
    const { done } = defaultSelfImplementSpawn()({ feature: 'verify bin root', spaceId: 'test-space' });
    await done;
    const [spawnCwd, entry, option, path] = readFileSync(capturePath, 'utf8').trim().split('\n');
    expect([spawnCwd, entry, option]).toEqual([realpathSync(cwd), expectedBin, '--feature-file']);
    expect(path).toBe('verify bin root');
    expect(launches).toEqual([{ bin: expectedBin, binSource: expectedBinSource }]);
  } finally {
    process.chdir(originalCwd);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCapture === undefined) delete process.env.ELANOUS_TEST_SPAWN_CAPTURE;
    else process.env.ELANOUS_TEST_SPAWN_CAPTURE = originalCapture;
    logSpy.mockRestore();
    rmSync(shimDir, { recursive: true, force: true });
  }
}

describe('self-implement surface adapter (S1 · parallel self-dev)', () => {
  test('terminal JSON retains pushed harvestable branch for supervisor, but never infers a push from branch alone', () => {
    expect(parseSelfImplementJson('{"stage":"timed-out","ok":false,"branch":"self-impl/finished","harvestable":true}')).toMatchObject({ stage: 'timed-out', branch: 'self-impl/finished', harvestable: true });
    expect(parseSelfImplementJson('{"stage":"timed-out","ok":false,"branch":"self-impl/finished"}')?.harvestable).toBeUndefined();
    expect(parseSelfImplementJson('{"stage":"timed-out","ok":false,"harvestable":true}')?.harvestable).toBeUndefined();
  });
  test('aborted harvestable child keeps PR number and a present goal revision observation for the parent', () => {
    const goalPlanRevision = { status: 'read', attempted: 1, applied: 0, failureReasons: ['expected-text-not-found'] };
    const parsed = parseSelfImplementJson(JSON.stringify({ stage: 'aborted', ok: false,
      branch: 'self-impl/aborted', harvestable: true, prNumber: 30155, goalPlanRevision }));
    expect(parsed).toMatchObject({ harvestable: true, prNumber: 30155, goalPlanRevision });
    expect(parsed?.childEvidence).toMatchObject({ harvestable: true, prNumber: 30155, goalPlanRevision });
    expect(parseSelfImplementJson(JSON.stringify({ stage: 'aborted', ok: false, harvestable: true, prNumber: -1 }))?.childEvidence)
      .not.toHaveProperty('harvestable');
    expect(parseSelfImplementJson(JSON.stringify({ stage: 'aborted', ok: false, branch: 'self-impl/aborted', harvestable: true,
      prNumber: 30155.5 }))?.prNumber).toBeUndefined();
  });
  test('aborted harvestable child keeps a valid read-failed observation and rejects malformed evidence', () => {
    const readFailure = { status: 'read-failed', reason: 'unreadable-files', scannedFiles: 2,
      unreadableFiles: 1, ledgerDirectory: '/tmp/ledger' };
    const parsed = parseSelfImplementJson(JSON.stringify({ stage: 'aborted', ok: false,
      branch: 'self-impl/aborted', harvestable: true, prNumber: 30155, goalPlanRevision: readFailure }));
    expect(parsed?.childEvidence).toMatchObject({ goalPlanRevision: readFailure });
    expect(parseSelfImplementJson(JSON.stringify({ stage: 'aborted', ok: false,
      branch: 'self-impl/aborted', harvestable: true, prNumber: 30155,
      goalPlanRevision: { ...readFailure, reason: 'unknown', unreadableFiles: 3 } }))?.childEvidence)
      .not.toHaveProperty('goalPlanRevision');
  });
  test('Pod failure keeps child classification facts and calls held out-of-scope edits with a stop reason scope-escape', () => {
    const abandonedClassification = { classification: 'implementation-deficit', classificationBasis: 'no-clean-worktree', worktreeClean: false };
    const accountAvailability = { reason: 'no-candidate', candidateCount: 0 };
    const child = { stage: 'soft-stopped', ok: false,
      detail: 'Out-of-scope edits held in the worktree; gate and publication skipped.',
      abandonedClassification, supervisorVerdict: 'UNCONVERGEABLE', goalCauseObserved: true,
      terminationReason: 'goal-only-rework-exhausted', quotaExhaustionAssessment: { accountAvailability } };
    // SCOPE-ESCAPE-AS-REFINE — a held detail without a stop reason is not a scope-escape stop.
    expect(parseSelfImplementJson(JSON.stringify(child))?.childEvidence).toMatchObject({ classification: 'implementation-deficit' });
    expect(parseSelfImplementJson(JSON.stringify(child))?.childEvidence).not.toHaveProperty('scopeEscape');
    const parsed = parseSelfImplementJson(JSON.stringify({ ...child, scopeStopReasons: ['deletion'] }));
    expect(parsed?.childEvidence).toEqual({ classification: 'scope-escape', scopeEscape: true, scopeStopReasons: ['deletion'], abandonedClassification,
      detail: 'Out-of-scope edits held in the worktree; gate and publication skipped.',
      supervisorVerdict: 'UNCONVERGEABLE', goalCauseObserved: true,
      terminationReason: 'goal-only-rework-exhausted', accountAvailability });
    expect(parsed?.failureClassification).toBe('implementation-deficit');
  });
  test('self implement --json prints a real out-of-scope Git edit and its stdout reaches parent childEvidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'scope-cli-fixture-'));
    const repo = join(root, 'repo');
    const worktree = join(root, 'worktree');
    const home = join(root, 'home');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(home);
    writeFileSync(join(repo, 'src/inside.ts'), 'export const inside = 1;\n');
    // SCOPE-AS-DIRECTION accepts a plain outside edit; a protected path (.env) is what still holds (SCOPE-ESCAPE-AS-REFINE).
    writeFileSync(join(repo, '.env'), 'A=1\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('config', 'user.name', 'scope test');
      git('config', 'user.email', 'scope@example.invalid');
      git('add', '-A');
      git('commit', '-qm', 'baseline');
      git('worktree', 'add', '-q', '-b', 'scope-fixture', worktree);
      const goalFile = join(root, 'goal.txt');
      writeFileSync(goalFile, '## PROBLEM\nOriginal ask (verbatim, unmodified):\n```\n대상 경로: src/inside.ts\nImplement the change.\n```\n');
      const orchestrator = resolve(import.meta.dir, '../../self-implement/orchestrator.ts');
      const seamFile = resolve(import.meta.dir, '../../self-implement/test-seams.ts');
      const preload = join(root, 'scope-preload.ts');
      writeFileSync(preload, `import { mock } from 'bun:test';
import { seams } from ${JSON.stringify(seamFile)};
const original = await import(${JSON.stringify(orchestrator + '?scope-fixture-original')});
mock.module(${JSON.stringify(orchestrator)}, () => ({ ...original, runSelfImplement: async (options) =>
  original.runSelfImplement({ ...options, runId: 'run-scope-cli', goalFile: ${JSON.stringify(goalFile)}, memory: false,
    writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
    seams: seams({ createWorktree: async ({ branch, base }) => ({ path: ${JSON.stringify(worktree)}, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
      implement: async () => { require('node:fs').writeFileSync(${JSON.stringify(join(worktree, '.env'))}, 'edited by child\\n'); return { ok: true, summary: 'impl' }; },
      askExecutionClarification: async () => ({ choice: 'Stay in scope', by: 'owner' }),
      gate: async () => { throw new Error('gate must not run'); },
      openPr: async () => { throw new Error('PR must not open'); } }) }) }));
`);
      const entry = resolve(import.meta.dir, '../../../bin/elanous.mjs');
      const launched = spawnSync('bun', ['--preload', preload, entry, '--test', 'self', 'implement', '--json', 'implement scoped change'], {
        cwd: repo, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, HOME: home, LOCAL_LLM_URL: 'http://127.0.0.1:9', ELANOUS_TEST_MODE: '1', ELANOUS_HARNESS_ENTRANCE: 'self-implement', ELANOUS_STATE_DIR: join(root, 'state') },
      });
      expect(launched.error).toBeUndefined();
      expect(launched.status, `stdout: ${launched.stdout}\nstderr: ${launched.stderr}`).toBe(0);
      expect(execFileSync('git', ['status', '--porcelain', '--', '.env'], { cwd: worktree, encoding: 'utf8' }),
        `stdout: ${launched.stdout}\nstderr: ${launched.stderr}`).toContain('.env');
      const output = launched.stdout;
      const terminal = JSON.parse(output.trim().split('\n').at(-1)!) as { result?: Record<string, unknown> } & Record<string, unknown>;
      const child = terminal.result ?? terminal;
      expect(child).toMatchObject({ stage: 'soft-stopped', outOfScopeEdits: ['.env'], scopeStopReasons: ['protected-path'], outsideCount: 1,
        nameCapReached: false, worktreePath: worktree, branch: expect.any(String) });
      expect(parseSelfImplementJson(output)).toMatchObject({ worktreePath: worktree, branch: child.branch,
        childEvidence: { classification: 'scope-escape', scopeEscape: true, scopeStopReasons: ['protected-path'], outOfScopeEdits: ['.env'] } });
      console.log(`[scope-cli] command=bun --preload ${preload} ${entry} --test self implement --json "implement scoped change" rc=${launched.status} stdout-tail=${output.trim().split('\n').at(-1)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
  test('Pod scope escape requires held edits, and lifted facts redact tokens', () => {
    for (const row of [
      { outOfScopeEdits: { count: 0 }, detail: 'No out-of-scope edits held in the worktree.' },
      { outOfScopeEdits: [], detail: 'Out-of-scope edits were not held in the worktree.' },
    ]) {
      const parsed = parseSelfImplementJson(JSON.stringify({ stage: 'soft-stopped', ok: false,
        abandonedClassification: { classification: 'implementation-deficit' }, ...row }));
      expect(parsed?.childEvidence?.scopeEscape).toBeUndefined();
      expect(parsed?.childEvidence?.classification).toBe('implementation-deficit');
    }
    const token = `sk-${'a'.repeat(24)}`;
    const parsed = parseSelfImplementJson(JSON.stringify({ stage: 'soft-stopped', ok: false,
      abandonedClassification: { classification: 'implementation-deficit', diagnostic: token },
      quotaExhaustionAssessment: { accountAvailability: { reason: token } } }));
    expect(JSON.stringify(parsed?.childEvidence)).not.toContain(token);
  });
  test('failed Pod copies bounded child error, stderr and structured exit code without inferring failures', () => {
    const token = `sk-${'b'.repeat(24)}`;
    const failed = parseSelfImplementJson(JSON.stringify({ stage: 'failed', ok: false, exitCode: 128,
      error: 'gh pr create failed', detail: `request failed ${token}`, stderr: 'remote rejected\n' + 'x'.repeat(5000) }));
    expect(failed?.childEvidence).toMatchObject({ error: 'gh pr create failed', exitCode: 128 });
    expect(failed?.childEvidence?.detail).not.toContain(token);
    expect(failed?.childEvidence?.detail).toContain('***');
    expect(failed?.childEvidence?.stderr?.length).toBeLessThanOrEqual(4000);
    const boundaryToken = `sk-${'c'.repeat(24)}`;
    const boundary = parseSelfImplementJson(JSON.stringify({ stage: 'failed', ok: false,
      stderr: 'x'.repeat(3993) + ' ' + boundaryToken }));
    expect(boundary?.childEvidence?.stderr).not.toContain(boundaryToken);
    expect(boundary?.childEvidence?.stderr?.endsWith('sk-***')).toBe(true);

    for (const exitCode of [256, -1, 1.5, '128']) {
      const parsed = parseSelfImplementJson(JSON.stringify({ stage: 'failed', ok: false, exitCode }));
      expect(parsed?.childEvidence?.exitCode).toBeUndefined();
    }
    const successful = parseSelfImplementJson(JSON.stringify({ stage: 'merged', ok: true,
      error: 'gh pr create succeeded', detail: 'success detail', stderr: 'warning only', exitCode: 0 }));
    expect(successful?.childEvidence).toBeUndefined();
  });
  test('PR open failure retains bounded cause and blocker identities in parent child evidence', () => {
    const error = `draft PR 생성 실패(worktree·branch 보존 · ${'very-long-path-'.repeat(35)})\nself-implement PR guard 실패: same-cell; candidateCardId=ta-next; blockers=#29829:ta-first`;
    const parsed = parseSelfImplementJson(JSON.stringify({ stage: 'error', ok: false, error }));
    expect(parsed?.childEvidence?.prFailure).toEqual({
      stage: 'pr-open-failed', errorTail: 'self-implement PR guard 실패: same-cell; candidateCardId=ta-next; blockers=#29829:ta-first',
      blockingPrNumber: 29829, candidateCardId: 'ta-next', blockingCardId: 'ta-first',
    });
    const unknown = parseSelfImplementJson(JSON.stringify({ stage: 'error', ok: false,
      error: 'draft PR 생성 실패\nself-implement PR guard 실패: same-cell; candidateCardId=unknown; blockers=#29829:unknown' }));
    expect(unknown?.childEvidence?.prFailure).toMatchObject({ blockingPrNumber: 29829 });
    expect(unknown?.childEvidence?.prFailure).not.toHaveProperty('candidateCardId');
    expect(unknown?.childEvidence?.prFailure).not.toHaveProperty('blockingCardId');
  });
  test('exit 0 → completed', async () => {
    const spawn: SelfImplementJobSpawn = () => ({
      address: 'self-impl:x',
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: 'done' }),
    });
    const adapter = createSelfImplementAdapter({ spawn });
    const res = await adapter(makeTask(), {});
    const exec = await res.promise;
    expect(exec.status).toBe('completed');
    expect(exec.surfaceAddress).toBe('self-impl:x');
    expect(exec.output).toBe('done');
  });

  test('non-zero exit promotes a structured child diagnostic while preserving exit code', async () => {
    const spawn: SelfImplementJobSpawn = () => ({
      address: 'self-impl:y',
      done: Promise.resolve<SelfImplementJobDone>({
        exitCode: 1,
        output: '{"stage":"error","ok":false,"error":"child diagnostic"}',
        disposition: { stage: 'error', ok: false, error: 'child diagnostic' },
      }),
    });
    const adapter = createSelfImplementAdapter({ spawn });
    const exec = await (await adapter(makeTask(), {})).promise;
    expect(exec.status).toBe('failed');
    expect(exec.error).toEqual({
      code: 'SELF_IMPL_FAILED',
      message: 'child diagnostic (self implement exited with code 1)',
    });
  });

  test('non-zero exit distinguishes empty child output from unparseable output', async () => {
    const emptySpawn: SelfImplementJobSpawn = () => ({
      address: 'self-impl:empty',
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 1, output: '' }),
    });
    const unparseableSpawn: SelfImplementJobSpawn = () => ({
      address: 'self-impl:unparseable',
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 1, output: 'plain child output' }),
    });

    const empty = await (await createSelfImplementAdapter({ spawn: emptySpawn })(makeTask(), {})).promise;
    const unparseable = await (await createSelfImplementAdapter({ spawn: unparseableSpawn })(makeTask(), {})).promise;
    expect(empty.error?.message).toBe('self implement exited with code 1 (child produced no output)');
    expect(unparseable.error?.message).toBe('self implement exited with code 1 (child output did not contain a parseable terminal JSON diagnostic)');
  });

  test('long child output labels its UTF-8 tail as an upper bound without splitting Unicode', async () => {
    // 4,098 bytes: the 4,096-byte boundary starts inside the first `한`, so
    // preserving valid UTF-8 skips its remaining bytes and yields a shorter tail.
    const output = `x${'한'.repeat(1_363)}😀끝z`;
    const spawn: SelfImplementJobSpawn = () => ({
      address: 'self-impl:long-output',
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 1, output }),
    });
    const exec = await (await createSelfImplementAdapter({ spawn })(makeTask(), {})).promise;
    const marker = '[output truncated to at most 4096 UTF-8 bytes]\n';
    const tail = exec.output!.slice(marker.length);
    expect(exec.output).toStartWith(marker);
    expect(Buffer.byteLength(tail, 'utf8')).toBe(4_094);
    expect(tail).toEndWith('😀끝z');
    expect(tail).not.toContain('\uFFFD');
  });

  test('explicit child error remains higher priority than a parsed diagnostic', async () => {
    const spawn: SelfImplementJobSpawn = () => ({
      address: 'self-impl:explicit-error',
      done: Promise.resolve<SelfImplementJobDone>({
        exitCode: 1,
        output: '{"stage":"error","ok":false,"error":"parsed diagnostic"}',
        error: { code: 'SELF_IMPL_SPAWN_FAILED', message: 'explicit error' },
        disposition: { stage: 'error', ok: false, error: 'parsed diagnostic' },
      }),
    });
    const exec = await (await createSelfImplementAdapter({ spawn })(makeTask(), {})).promise;
    expect(exec.error).toEqual({ code: 'SELF_IMPL_SPAWN_FAILED', message: 'explicit error' });
  });

  test('spawn throws synchronously → failed (SPAWN_FAILED)', async () => {
    const spawn: SelfImplementJobSpawn = () => { throw new Error('no bun'); };
    const adapter = createSelfImplementAdapter({ spawn });
    const exec = await (await adapter(makeTask(), {})).promise;
    expect(exec.status).toBe('failed');
    expect(exec.error?.code).toBe('SELF_IMPL_SPAWN_FAILED');
    expect(exec.error?.message).toContain('no bun');
  });

  test('aborted signal wins over exit code → cancelled', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const spawn: SelfImplementJobSpawn = () => ({
      address: 'self-impl:z',
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: 'ok' }),
    });
    const adapter = createSelfImplementAdapter({ spawn });
    const exec = await (await adapter(makeTask(), { signal: ctrl.signal })).promise;
    expect(exec.status).toBe('cancelled');
    expect(exec.error?.code).toBe('ABORTED');
  });

  test('surface fields (base/autoMerge/draft) + distinct space id flow to spawn', async () => {
    let seen: Parameters<SelfImplementJobSpawn>[0] | null = null;
    const spawn: SelfImplementJobSpawn = (input) => {
      seen = input;
      return { address: `self-impl:${input.spaceId}`, done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }) };
    };
    const adapter = createSelfImplementAdapter({ spawn });
    const task = makeTask('build X', { base: 'origin/main', autoMerge: true, draft: false });
    await (await adapter(task, {})).promise;
    expect(seen!.feature).toBe('build X');
    expect(seen!.base).toBe('origin/main');
    expect(seen!.autoMerge).toBe(true);
    expect(seen!.draft).toBe(false);
    // space id is derived from the task id → distinct per job.
    expect(seen!.spaceId).toContain(task.id.replace('task:', ''));
  });

  test('a task surface forwards its after goal ID or PR number to the Pod spawn input', async () => {
    const seen: Array<string | number | undefined> = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      seen.push(input.after);
      return { address: 'self-impl:after', done: Promise.resolve({ exitCode: 0, output: '' }) };
    };
    const adapter = createSelfImplementAdapter({ spawn });
    for (const after of ['goal-before', 123]) {
      await (await adapter(makeTask('dependent', { after }), {})).promise;
    }
    await (await adapter(makeTask('independent'), {})).promise;
    expect(seen).toEqual(['goal-before', 123, undefined]);
  });

  test('production spawn falls back to this elanous bin outside a git repository', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'self-implement-bin-fallback-'));
    try {
      const expectedBin = resolve(import.meta.dir, '../../../bin/elanous.mjs');
      expect(existsSync(expectedBin)).toBe(true);
      await assertDefaultSpawnBin(cwd, expectedBin, 'source-tree-fallback');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('production spawn falls back from an external git repository with a directory entrypoint', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'self-implement-bin-git-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd });
      writeFileSync(join(cwd, 'README.md'), '# external product\n');
      mkdirSync(join(cwd, 'bin'));
      mkdirSync(join(cwd, 'bin', 'elanous.mjs'));
      const expectedBin = resolve(import.meta.dir, '../../../bin/elanous.mjs');
      await assertDefaultSpawnBin(cwd, expectedBin, 'source-tree-fallback');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('production spawn keeps the current elanous repository bin', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'self-implement-bin-own-repo-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      mkdirSync(join(repo, 'bin'));
      writeFileSync(join(repo, 'bin', 'elanous.mjs'), '// isolated repository entrypoint\n');
      await assertDefaultSpawnBin(repo, join(realpathSync(repo), 'bin', 'elanous.mjs'), 'cwd-repository');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('resolveSpawnElanousBin uses only regular repository entrypoints and reports missing candidates', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'self-implement-selector-'));
    const missingSourceRoot = mkdtempSync(join(tmpdir(), 'self-implement-missing-source-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd });
      mkdirSync(join(cwd, 'bin'));
      mkdirSync(join(cwd, 'bin', 'elanous.mjs'));
      expect(resolveSpawnElanousBin(cwd)).toEqual({
        bin: resolve(import.meta.dir, '../../../bin/elanous.mjs'),
        source: 'source-tree-fallback',
      });
      rmSync(join(cwd, 'bin'), { recursive: true, force: true });
      expect(() => resolveSpawnElanousBin(cwd, missingSourceRoot)).toThrow(/tried .*bin\/elanous\.mjs/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(missingSourceRoot, { recursive: true, force: true });
    }
  });

  test('parseSelfImplementJson — extracts disposition from --json tail', () => {
    const stdout = 'some progress line\n{"ok":true,"stage":"merged","branch":"b","prUrl":"https://x/1","prNumber":1,"merged":true}';
    const d = parseSelfImplementJson(stdout);
    expect(d).toMatchObject({ ok: true, stage: 'merged', prUrl: 'https://x/1', prNumber: 1, merged: true });
  });

  test('parseSelfImplementJson — preserves the child run id in both identity fields only when nonblank', () => {
    const d = parseSelfImplementJson('{"stage":"merged","ok":true,"runId":"run-child-1"}');
    expect(d).toMatchObject({ runId: 'run-child-1', childRunId: 'run-child-1' });
    for (const runId of ['', '   ', 123, null]) {
      const invalid = parseSelfImplementJson(JSON.stringify({ stage: 'merged', ok: true, runId }));
      expect(invalid).not.toHaveProperty('runId');
      expect(invalid).not.toHaveProperty('childRunId');
    }
  });

  test('parseSelfImplementJson — retains a non-empty terminal error diagnostic', () => {
    const d = parseSelfImplementJson('{"stage":"error","ok":false,"error":"unable to derive isolated child universe"}');
    expect(d).toMatchObject({ stage: 'error', ok: false, error: 'unable to derive isolated child universe' });
    expect(parseSelfImplementJson('{"stage":"error","ok":false,"error":"  "}')).not.toHaveProperty('error');
  });

  test('parseSelfImplementJson — preserves valid provider failure evidence and omits invalid evidence', () => {
    const providerErrors = { count: 5, provider: 'grok', category: 'quota' };
    expect(parseSelfImplementJson(JSON.stringify({ stage: 'timed-out', providerErrors }))?.providerErrors).toEqual({ ...providerErrors, category: 'quota' });
    expect(parseSelfImplementJson(JSON.stringify({ stage: 'timed-out', providerErrors: { ...providerErrors, category: 'invalid' } }))).not.toHaveProperty('providerErrors');
    expect(parseSelfImplementJson('{"stage":"timed-out"}')).not.toHaveProperty('providerErrors');
  });

  test('parseSelfImplementJson — null when no JSON line', () => {
    expect(parseSelfImplementJson('just progress\nno json here')).toBeNull();
  });

  test('parseSelfImplementJson — picks the last JSON object (ignores earlier noise)', () => {
    const d = parseSelfImplementJson('{"stage":"early"}\nmid\n{"ok":false,"stage":"gate-failed"}');
    expect(d).toMatchObject({ ok: false, stage: 'gate-failed' });
  });

  test('parseSelfImplementJson — nested child failure supplies the parent disposition without borrowing an earlier result', () => {
    const old = JSON.stringify({ kind: 'self', ok: false, result: { stage: 'aborted', ok: false, outOfScopeEdits: ['old.ts'] } });
    const current = JSON.stringify({ kind: 'external', ok: false, result: { stage: 'soft-stopped', ok: false,
      outOfScopeEdits: ['current.ts'], scopeStopReasons: ['deletion'], abandonedClassification: { classification: 'implementation-deficit' },
      supervisorVerdict: 'UNCONVERGEABLE', goalCauseObserved: true,
      terminationReason: { kind: 'goal-only-rework-exhausted' },
      quotaExhaustionAssessment: { accountAvailability: { reason: 'no-candidate', candidateCount: 0 } } } });
    const graph = JSON.stringify({ kind: 'graph', stage: 'merged', ok: true });
    const disposition = parseSelfImplementJson(`${old}\n${current}\n${graph}`);
    expect(disposition).toMatchObject({ stage: 'soft-stopped', ok: false, failureClassification: 'implementation-deficit',
      childEvidence: { classification: 'scope-escape', scopeEscape: true, outOfScopeEdits: ['current.ts'],
        supervisorVerdict: 'UNCONVERGEABLE', goalCauseObserved: true,
        terminationReason: { kind: 'goal-only-rework-exhausted' }, accountAvailability: { reason: 'no-candidate', candidateCount: 0 } } });
    expect(disposition?.childEvidence?.outOfScopeEdits).not.toContain('old.ts');
    const malformed = JSON.stringify({ kind: 'self', stage: 'merged', ok: true, result: {} });
    expect(parseSelfImplementJson(`${old}\n${current}\n${malformed}`)).toMatchObject({ stage: 'soft-stopped', ok: false,
      failureClassification: 'implementation-deficit', childEvidence: { outOfScopeEdits: ['current.ts'] } });
  });

  test('parseSelfImplementJson — a later successful nested child stays successful and clears earlier failure evidence', () => {
    const old = JSON.stringify({ kind: 'self', ok: false, result: { stage: 'aborted', ok: false, outOfScopeEdits: ['old.ts'] } });
    const current = JSON.stringify({ kind: 'self', ok: true, result: { stage: 'merged', ok: true, prUrl: 'https://example.invalid/pr/1', merged: true } });
    const disposition = parseSelfImplementJson(`${old}\n${current}`);
    expect(disposition).toMatchObject({ stage: 'merged', ok: true, prUrl: 'https://example.invalid/pr/1', merged: true });
    expect(disposition?.childEvidence).toBeUndefined();
    expect(disposition?.failureClassification).toBeUndefined();
  });

  test('parseSelfImplementJson — legacy flat stage without ok retains its scope evidence', () => {
    const disposition = parseSelfImplementJson(JSON.stringify({ stage: 'soft-stopped', outOfScopeEdits: ['x.ts'] }));
    // SCOPE-ESCAPE-AS-REFINE — no stop reason: the held name is the new scope, not a scope-escape.
    expect(disposition).toMatchObject({ stage: 'soft-stopped', childEvidence: { newScope: ['x.ts'], outOfScopeEdits: ['x.ts'] } });
    expect(disposition?.childEvidence).not.toHaveProperty('scopeEscape');
    expect(parseSelfImplementJson(JSON.stringify({ stage: 'soft-stopped', outOfScopeEdits: ['.env'] }))).toMatchObject({ stage: 'soft-stopped',
      childEvidence: { classification: 'scope-escape', scopeEscape: true, scopeStopReasons: ['protected-path'], outOfScopeEdits: ['.env'] } });
  });

  test('wrong surface kind → throws (guard)', async () => {
    const adapter = createSelfImplementAdapter({ spawn: () => ({ address: 'x', done: Promise.resolve({ exitCode: 0, output: '' }) }) });
    const bad = createTask({ title: 't', surface: { kind: 'llm-direct', prompt: 'hi' } });
    let msg = '';
    try { await adapter(bad, {}); } catch (e) { msg = String((e as Error).message); }
    expect(msg).toContain('wrong kind');
  });
});

// ⛔⭐⭐⭐ `A1`·`A2`(2026-08-19 · 대표 *"R3 가 서브 프로세스여도 잘 도는 안"*)
//   🚨 이 계약이 깨지면 트리아지가 「도구 한계」와 「자식이 못 함」을 «같은 칸»으로 본다.
//     그리고 그 실패는 «조용하다» — 2026-08-19 까지 아무도 몰랐다.
describe('parseSelfImplementJson — 판정 3종이 «전선을 건넌다» (A1)', () => {
  const line = (o: Record<string, unknown>) => `noise\n${JSON.stringify(o)}\n`;

  test('⭐ mergeReason · stopReason · completionDisposition 을 «전부» 옮긴다', () => {
    const d = parseSelfImplementJson(line({
      stage: 'pr-opened', ok: true,
      mergeReason: 'review-diff-truncated',
      stopReason: 'max-rounds',
      completionDisposition: 'unconverged',
    }))!;
    expect(d.mergeReason).toBe('review-diff-truncated');
    expect(d.stopReason).toBe('max-rounds');
    expect(d.completionDisposition).toBe('unconverged');
  });

  test('failureClassification 을 전선에 싣고 completionDisposition 은 독립으로 보존한다', () => {
    const d = parseSelfImplementJson(line({
      stage: 'review-blocked', ok: false,
      completionDisposition: 'completed-without-changes',
      failureClassification: 'goal-unconvergeable-candidate',
    }))!;
    expect(d.failureClassification).toBe('goal-unconvergeable-candidate');
    expect(d.completionDisposition).toBe('completed-without-changes');
  });

  test('자식 JSON 의 abandonedClassification.classification 도 failureClassification 으로 보존한다', () => {
    const d = parseSelfImplementJson(line({
      stage: 'review-blocked', ok: false,
      completionDisposition: 'completed-without-changes',
      abandonedClassification: { classification: 'goal-unconvergeable-candidate' },
    }))!;
    expect(d.failureClassification).toBe('goal-unconvergeable-candidate');
    expect(d.completionDisposition).toBe('completed-without-changes');
  });

  test('어휘 밖 분류 문자열은 failureClassification 칸을 만들지 않는다', () => {
    const d = parseSelfImplementJson(line({
      stage: 'review-blocked', ok: false,
      failureClassification: 'not-a-classification',
      completionDisposition: 'completed-without-changes',
    }))!;
    expect(d.failureClassification).toBeUndefined();
    expect(d.completionDisposition).toBe('completed-without-changes');
  });

  test('⛔ 빈 문자열은 «없는 것»이다 — 빈 값으로 판정하지 않는다', () => {
    const d = parseSelfImplementJson(line({ stage: 'merged', ok: true, mergeReason: '   ' }))!;
    expect(d.mergeReason).toBeUndefined();
  });

  test('종전 칸들은 그대로다 (회귀)', () => {
    const d = parseSelfImplementJson(line({
      stage: 'merged', ok: true, branch: 'b', prNumber: 7, merged: true,
    }))!;
    expect(d.stage).toBe('merged');
    expect(d.prNumber).toBe(7);
    expect(d.merged).toBe(true);
  });
});

describe('reportUnmappedDispositionFields — 파서가 «버린 칸»을 말한다 (A2)', () => {
  test('⭐ 인식 못 한 키를 «이름으로» 낸다 — 이것이 다음 결손을 «값»으로 만든다', () => {
    const unmapped = reportUnmappedDispositionFields(
      { stage: 'merged', ok: true, futureJudgment: 'x', anotherOne: 1 },
      { stage: 'merged', ok: true },
    );
    expect([...unmapped].sort()).toEqual(['anotherOne', 'futureJudgment']);
  });

  test('전부 인식했으면 빈 목록 — 소음을 만들지 않는다', () => {
    expect(reportUnmappedDispositionFields({ stage: 'm' }, { stage: 'm' })).toEqual([]);
  });

  test('⛔ undefined 값은 «버린 것»이 아니다', () => {
    expect(reportUnmappedDispositionFields({ stage: 'm', gone: undefined }, { stage: 'm' })).toEqual([]);
  });
});

describe('reviewGateFields — E4 벤치 칸', () => {
  test('gate.passed · 리뷰 판정 · must-fix 수를 옮기고, 리뷰를 «안 한» 판(reviewed=false)은 리뷰 칸을 싣지 않는다', async () => {
    const { reviewGateFields } = await import('./self-implement.js');
    expect(reviewGateFields({ gate: { passed: true }, review: { verdict: 'warn', mustFix: ['a', 'b'], reviewed: true } }))
      .toEqual({ gatePassed: true, reviewVerdict: 'warn', reviewMustFixCount: 2 });
    expect(reviewGateFields({ gate: { passed: false }, review: { verdict: 'pass', mustFix: [], reviewed: false } }))
      .toEqual({ gatePassed: false });
    expect(reviewGateFields({ gate: 'x', review: [] })).toEqual({});
  });
});
