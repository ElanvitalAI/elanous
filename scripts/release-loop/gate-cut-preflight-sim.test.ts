import { expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { createGateRunner, runGateNode } from './gate-node.js';
import { cutReleaseBranchForRun } from './version-node.js';
import { createTempGitRemote } from '../../src/ux-sim/temp-git-remote.js';
import { PodPoolScheduler } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import type { RunPodCommandOptions } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import type { LogRecord } from '../../src/mss/logging/record.js';
import { gateShardRuntimeIdentityKey, type GateShardReceipt } from './gate-shard-dispatch.js';

const CHANGED = ['docs/TECH-harness-map-2026-10-06.md', 'package.json', 'scenarios/ux-sim/rla-arg-adaptive-heal.yaml'];
const SCENARIO = '../../scenarios/ux-sim/release-cut-preflight-regressions.yaml';
const RECEIPT_ROSTER = '../../scenarios/ux-sim/fixtures/release-cut-0306-shards.json';
setDefaultTimeout(120_000);

test('release cut preflight catalog includes four live-entry blocks and the whole-radius incident', () => {
  const catalog = parse(readFileSync(new URL(SCENARIO, import.meta.url), 'utf8')) as { cases: Array<{ id: string; expected: string }> };
  expect(catalog.cases.map(({ id }) => id)).toEqual([
    'stale-cli-image-pin', 'foreign-release-branch-owner', 'gate-run-scope-missing',
    'hq-shard-ledger-missing', 'cut-change-invalidates-all-shards',
  ]);
  expect(catalog.cases.slice(0, 4).every(({ expected }) => expected.startsWith('blocked · '))).toBe(true);
});

test('missing image pin, graph run scope, and remote ledger fail before Pod commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-cut-preflight-sim-'));
  const calls: string[] = [];
  const emitted: string[] = [];
  const log = spyOn(console, 'log').mockImplementation(((...args: unknown[]) => { emitted.push(args.join(' ')); }) as typeof console.log);
  const error = spyOn(console, 'error').mockImplementation(((...args: unknown[]) => { emitted.push(args.join(' ')); }) as typeof console.error);
  try {
    const inputs = [
      { version: '0.3.6', previousVersion: '0.3.5', gateExecutor: 'pod', gatePodPool: 'pool-sim@sim-host:1' },
      { version: '0.3.6', previousVersion: '0.3.5', gateExecutor: 'pod', gatePodPool: 'pool-sim@sim-host:1', gateImagePin: 'cut-commit' },
    ];
    const expectedErrors = ['gateImagePin cut-commit is required for a policy-selected release gate', 'pod-gate-missing-run-scope'];
    for (const [index, input] of inputs.entries()) {
      const context = join(root, 'graph-context.json');
      writeFileSync(context, JSON.stringify({ input, outputs: { 'version-release': { commit: 'a'.repeat(40) } } }));
      const rc = await runGateNode(['--json'], { ...process.env, ELANOUS_GRAPH_CONTEXT: context, ELANOUS_STATE_DIR: root });
      expect(rc).toBe(2);
      expect(emitted.join('\n')).toContain(expectedErrors[index]!);
      emitted.length = 0;
    }
    const runner = createGateRunner(root, undefined, undefined, async () => {
      calls.push('pod');
      throw new Error('fake Pod boundary must remain unused');
    }, new PodPoolScheduler([{ context: 'pool-sim', sshHost: 'sim-host', capacity: 1, k3dCluster: 'sim' }]));
    await expect(runner.sweep(root, undefined, { pool: 'pool-sim', shards: 1, shardsFile: {
      path: join(root, 'shards.json'), version: '0.3.6', receiptRoot: join(root, 'receipts'),
      base40: 'b'.repeat(40), envFingerprint: 'c'.repeat(64),
    } })).rejects.toThrow('remote gate refused: HQ shard ledger is not configured');
    expect(calls).toEqual([]);
  } finally { log.mockRestore(); error.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test('foreign release branch owner scenario calls the production cut path and preserves the remote ref', () => {
  const fixture = createTempGitRemote();
  try {
    const { seed, checkout, remote, git } = fixture;
    git(seed, ['config', 'user.name', 'release-cut-sim']);
    git(seed, ['config', 'user.email', 'release-cut-sim@example.test']);
    git(checkout, ['config', 'user.name', 'release-cut-sim']);
    git(checkout, ['config', 'user.email', 'release-cut-sim@example.test']);
    writeFileSync(join(seed, 'package.json'), `${JSON.stringify({ name: 'release-cut-sim', version: '0.2.18-dev.3' }, null, 2)}\n`);
    writeFileSync(join(seed, 'bun.lock'), JSON.stringify({ workspaces: { '': { name: 'release-cut-sim', version: '0.2.18-dev.3', dependencies: {} } } }));
    mkdirSync(join(seed, 'src'), { recursive: true });
    writeFileSync(join(seed, 'src/a.ts'), 'export const a = 1;\n');
    mkdirSync(join(seed, 'graphs/release'), { recursive: true });
    for (const file of ['release-loop.yaml', 'recipes.yaml'])
      copyFileSync(join(process.cwd(), 'graphs/release', file), join(seed, 'graphs/release', file));
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-m', 'release-cut simulation fixture']);
    git(seed, ['push', 'origin', 'main']);
    git(checkout, ['fetch', 'origin']);
    git(checkout, ['reset', '--hard', 'origin/main']);
    const first = cutReleaseBranchForRun(checkout, '0.2.18', {
      install: () => {}, freeze: () => null, runId: 'run-owner-a', root: fixture.root,
    });
    expect(first).toMatchObject({ outcome: 'ok', branch: 'release/0.2.18' });
    const before = git(remote, ['rev-parse', 'release/0.2.18']);
    expect(() => cutReleaseBranchForRun(checkout, '0.2.18', {
      install: () => { throw new Error('foreign owner must block before install'); },
      freeze: () => null, runId: 'run-owner-b', root: fixture.root,
    })).toThrow('refusing to replace a foreign release branch');
    expect(git(remote, ['rev-parse', 'release/0.2.18'])).toBe(before);
  } finally { fixture.cleanup(); }
});

test('synthetic cut commit routes a non-TypeScript diff through full-radius invalidation', async () => {
  const repo = process.cwd();
  const roster = JSON.parse(readFileSync(new URL(RECEIPT_ROSTER, import.meta.url), 'utf8')) as {
    shards: Array<{ id: string; files: string[] }>;
  };
  expect(roster.shards).toHaveLength(81);
  const shards = roster.shards;
  const tests = [...new Set(shards.flatMap((shard) => shard.files))].sort();
  expect(tests).toHaveLength(6611);
  const replayShards = shards;
  const replayTests = tests;
  const temp = mkdtempSync(join(tmpdir(), 'release-cut-production-replay-'));
  const historicalRepo = join(temp, 'repo');
  const gitRoot = (args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  const git = (args: string[]) => spawnSync('git', args, { cwd: historicalRepo, encoding: 'utf8' });
  let worktreeAdded = false;
  try {
    // Start from the checked-out production code, then create an incident commit in this disposable
    // worktree. The replay no longer requires historical commit objects to be present in the clone.
    const added = gitRoot(['worktree', 'add', '--detach', historicalRepo, 'HEAD']);
    expect(added.status).toBe(0);
    worktreeAdded = true;
        const priorCommitResult = git(['rev-parse', 'HEAD']);
    expect(priorCommitResult.status).toBe(0);
    const priorCommit = priorCommitResult.stdout.trim();
    const nonTsChanges = new Map([
      [CHANGED[0]!, '\n<!-- synthetic release cut fixture change -->\n'],
      [CHANGED[1]!, '\n'],
      [CHANGED[2]!, '\n# synthetic release cut fixture change\n'],
    ]);
    for (const [file, suffix] of nonTsChanges)
      writeFileSync(join(historicalRepo, file), readFileSync(join(historicalRepo, file), 'utf8') + suffix);
    const staged = git(['add', ...CHANGED]);
    expect(staged.status).toBe(0);
    const committed = git(['-c', 'user.name=release-cut-preflight-sim', '-c', 'user.email=release-cut-preflight-sim@example.test',
      'commit', '-m', 'synthetic non-TypeScript release cut incident']);
    expect(committed.status).toBe(0);
    const incidentCommit = git(['rev-parse', 'HEAD']).stdout.trim();
    expect(incidentCommit).toMatch(/^[0-9a-f]{40}$/);
    const changed = git(['diff', '--name-only', priorCommit, incidentCommit]);
    expect(changed.status).toBe(0);
    const changedFiles = changed.stdout.split(/\r?\n/).filter(Boolean);
    expect(changedFiles).toEqual([...CHANGED].sort());
    const nonTs = changedFiles.filter((file) => !file.endsWith('.ts'));
    expect(nonTs).toEqual([...CHANGED].sort());

    const historicalNodeModules = join(historicalRepo, 'node_modules');
    const currentNodeModules = resolve(repo, 'node_modules');
    if (existsSync(currentNodeModules)) symlinkSync(currentNodeModules, historicalNodeModules, 'dir');
    const receiptRoot = join(temp, 'receipts');
    mkdirSync(receiptRoot);
    const base40 = 'c'.repeat(40);
    const fingerprint = 'd'.repeat(64);
    const lockfileHash = '9'.repeat(64);
    const imageDigest = `sha256:${'e'.repeat(64)}`;
    const runtimeIdentity = { bunVersion: '1.4.2', platform: 'linux', architecture: 'x64', envFingerprint: fingerprint,
      baseImageDigest: `sha256:${'a'.repeat(64)}` };
    // Test-only fixture at the content-identity seam: equal test content must not override the
    // production decision that a non-TypeScript change invalidates the whole cut radius.
    writeFileSync(join(historicalRepo, 'scripts/release-loop/gate-reuse-identity.ts'), `
export function gateTestedFileHashesAtCommit(_repo: string, _commit: string, files: readonly string[]) {
  return Object.fromEntries(files.map((file) => [file, '${'9'.repeat(64)}']));
}
export function gateLockfileHashAtCommit() { return '${lockfileHash}'; }
export function sameGateTestedFileHashes(a?: Record<string, string>, b?: Record<string, string>) {
  return !!a && !!b && JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort())
    && Object.keys(a).every((key) => a[key] === b[key]);
}
`);
    const receipts: GateShardReceipt[] = replayShards.map((shard, index) => ({
      ...shard, version: '0.3.6', head40: priorCommit, base40, graphSha: '1'.repeat(64), recipeSha: '2'.repeat(64),
      graphEntry: 'gate-entry-v1', recipeCommand: 'bun scripts/release-loop/gate-node.ts --json', recipeTimeoutMs: 14_400_000,
      host: 'node-b', envKey: gateShardRuntimeIdentityKey(runtimeIdentity, lockfileHash)!, envFingerprint: fingerprint,
      imageDigest, runtimeIdentity, lockfileHash, testedFileHashes: Object.fromEntries(shard.files.map((file) => [file, `${(index % 9) + 1}`.repeat(64)])),
      executions: [{ branch: '', attemptId: `cut-replay-${index}`, host: 'node-b', imageDigest, runtimeIdentity }],
      status: 'complete', failureIds: [], errorIds: [], evidencePath: `${shard.id}.result.json`, evidenceSha256: 'f'.repeat(64),
      measuredAt: '2026-11-07T00:00:00.000Z', attempt: 1,
    }));
    for (const receipt of receipts) {
      const { recordSha256: _unused, ...record } = receipt;
      const valid = { ...record, recordSha256: createHash('sha256').update(JSON.stringify(record)).digest('hex') };
      writeFileSync(join(receiptRoot, `${receipt.id}.receipt.json`), `${JSON.stringify(valid)}\n`);
    }
    const records: Array<{ category: string; event: string; data?: unknown }> = [];
    let podCalls = 0;
    const dispatchedFilesByShard: string[][] = Array.from({ length: 81 }, () => []);
    const moduleUrl = pathToFileURL(join(historicalRepo, 'src/debug/log.ts')).href;
    const { debug } = await import(moduleUrl);
    const removeSink = debug.registerSink({ name: 'release-cut-test-capture', emit: (record: LogRecord) => records.push(record) });
    try {
      const { createGateRunner } = await import(pathToFileURL(join(historicalRepo, 'scripts/release-loop/gate-node.ts')).href);
      const command = async (cmd: string, args: string[], cwd: string) => {
        if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: replayTests.join('\n') };
        if (cmd === 'rg') return { rc: 1, output: '' };
        if (cmd === 'git' && args[0] === 'merge-base') return { rc: 0, output: priorCommit };
        const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        return { rc: result.status ?? 2, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
      };
      const runner = createGateRunner(historicalRepo, undefined, command, async (options: RunPodCommandOptions) => {
        const shardIndex = Number(/^([0-9]+)-of-/.exec(options.provenance?.shard ?? '')?.[1]) - 1;
        if (!replayShards[shardIndex]) throw new Error(`unexpected simulated shard label: ${options.provenance?.shard}`);
        const podShell = options.command[2] ?? '';
        const manifests = [...podShell.matchAll(/printf '%s\\n' ([^;]+) > "\$O\/part-\d+\.files";/g)];
        const files = manifests.flatMap(([, list]) => [...(list ?? '').matchAll(/'([^']*)'/g)].map(([, file]) => file!));
        expect(files).toEqual(replayShards[shardIndex]!.files);
        dispatchedFilesByShard[shardIndex] = files;
        const artifactsDir = join(temp, 'pod-results', `pod-${shardIndex}-${podCalls++}`);
        mkdirSync(artifactsDir, { recursive: true });
        const escapedFiles = files.map((file) => file.replaceAll('&', '&amp;').replaceAll('"', '&quot;'));
        const cases = escapedFiles.map((file, index) => `<testcase file="${file}" name="sim-${index}"/>`).join('');
        writeFileSync(join(artifactsDir, 'shard.log'), `${files.length} pass\n0 fail\nRan ${files.length} tests across ${files.length} files\n`);
        writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
        writeFileSync(join(artifactsDir, 'junit.xml'), `<testsuites><testsuite>${cases}</testsuite></testsuites>`);
        return { exitCode: 0, artifactsDir, job: `fake-pod-${shardIndex}`, artifacts: { files: 3, names: ['shard.log', 'shard.rc', 'junit.xml'], error: null } };
      }, new PodPoolScheduler([{ context: 'sim', capacity: 81, k3dCluster: 'sim' }]));
      const result = await runner.sweep(historicalRepo, undefined, { pool: 'sim', shards: 81, freshShards: false,
        durationSource: '', shardsFile: { path: join(temp, 'shards.json'), version: '0.3.6', receiptRoot, base40,
          envFingerprint: fingerprint, expectedImageDigest: imageDigest,
          executionIdentity: { ...runtimeIdentity, imageDigest },
          graphPins: { graphSha: '1'.repeat(64), recipeSha: '2'.repeat(64), graphEntry: 'gate-entry-v1',
            recipeCommand: 'bun scripts/release-loop/gate-node.ts --json', recipeTimeoutMs: 14_400_000 } },
      });
      expect(result.rc).toBe(0);
      expect(podCalls).toBe(81);
    } finally { removeSink(); }
    const decisions = records.filter((record) => record.category === 'gate.receipt' && record.event === 'reuse-decision');
    expect(decisions).toHaveLength(81);
    const decisionData = (record: typeof decisions[number]): Record<string, unknown> =>
      record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
    expect(decisions.every((record) => decisionData(record).reason === 'radius-invalidated')).toBe(true);
    expect(decisions.every((record) => decisionData(record).receiptCheckReason === 'changed-runtime-environment-input')).toBe(true);
    const reused = decisions.filter((record) => decisionData(record).decision === 'reuse').length;
    const invalidated = decisions.filter((record) => decisionData(record).decision === 'rerun' && decisionData(record).reason === 'radius-invalidated').length;
    expect(reused).toBe(0);
    expect(invalidated).toBe(81);
    const dispatchedFiles = dispatchedFilesByShard.flat();
    expect(dispatchedFiles).toHaveLength(6611);
    expect(new Set(dispatchedFiles).size).toBe(6611);
    expect([...dispatchedFiles].sort()).toEqual(tests);
    console.log(`CUT-RADIUS-REPLAY ${priorCommit.slice(0, 8)}..${incidentCommit.slice(0, 8)} reason=changed-runtime-environment-input changedNonTs=${nonTs.length} tests=${tests.length} dispatchTests=${replayTests.length} receiptsReused=${reused}/81 radiusInvalidated=${invalidated}/81`);
  } finally {
    let removeError: string | undefined;
    try {
      if (worktreeAdded) {
        const removed = gitRoot(['worktree', 'remove', '--force', historicalRepo]);
        if (removed.status !== 0) removeError = removed.stderr;
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
    if (removeError) throw new Error(`temporary incident worktree cleanup failed: ${removeError}`);
  }
});
