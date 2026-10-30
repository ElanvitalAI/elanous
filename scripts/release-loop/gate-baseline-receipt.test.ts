import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actualGatePodImageDigest, gateBaselineReceipt, gateEnvFingerprint, gateGraphPins, gateSourcePins } from './gate-baseline-receipt';

const roots: string[] = [];
const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const pins = { graphSha: 'c'.repeat(64), recipeSha: 'd'.repeat(64) };
const testEnvFingerprint = gateEnvFingerprint({ ELANOUS_TEST_FAKE_LLM: '1' });
const runtimeIdentity = { bunVersion: '1.4.2', platform: 'linux', architecture: 'x64', envFingerprint: testEnvFingerprint };
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'gate-receipt-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('direct rehearsal source pins are hashes of the measured Git commit, not mutable checkout files', () => {
  const repo = root();
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  git('init', '-q'); git('config', 'user.email', 'tc@test'); git('config', 'user.name', 'TC');
  mkdirSync(join(repo, 'graphs/release'), { recursive: true });
  writeFileSync(join(repo, 'graphs/release/release-loop.yaml'), 'graph_id: release-loop\n');
  writeFileSync(join(repo, 'graphs/release/recipes.yaml'), 'recipes: {}\n');
  git('add', '.'); git('commit', '-qm', 'graph');
  const commit = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'graphs/release/release-loop.yaml'), 'graph_id: changed\n');
  expect(gateSourcePins(repo, commit)).toEqual({
    graphSha: createHash('sha256').update('graph_id: release-loop\n').digest('hex'),
    recipeSha: createHash('sha256').update('recipes: {}\n').digest('hex'),
  });
  expect(gateSourcePins(repo, 'not-a-sha')).toBeNull();
});

test('the observed child imageID matches the pinned registry RepoDigest, not the host-local Image ID or a tag', () => {
  const localImageId = `sha256:${'c'.repeat(64)}`;
  const repoDigest = `sha256:${'d'.repeat(64)}`;
  const pod = (imageID: string) => JSON.stringify({ items: [{ status: { containerStatuses: [
    { name: 'sidecar', imageID: `docker://sha256:${'e'.repeat(64)}` }, { name: 'child', imageID },
  ] } }] });
  expect(actualGatePodImageDigest(pod(`docker-pullable://registry/harness@${repoDigest}`))).toBe(repoDigest);
  expect(repoDigest).not.toBe(localImageId);
  expect(actualGatePodImageDigest(pod(`containerd://${digest}`))).toBe(digest);
  expect(actualGatePodImageDigest(pod('registry/harness:latest'))).toBeNull();
  expect(actualGatePodImageDigest('{}')).toBeNull();
  const first = JSON.parse(pod(`containerd://${digest}`)) as { items: unknown[] };
  expect(actualGatePodImageDigest(JSON.stringify({ items: [...first.items, ...first.items] }))).toBeNull();
});

test('only a pinned, complete, clean full cut with one observed Pod digest earns a reusable receipt', () => {
  const dir = root();
  const logs = join(dir, 'release', '0.2.34', 'gate-logs', 'cut');
  mkdirSync(logs, { recursive: true });
  const row = (n: number, files: string[], imageDigest?: string, sweepId = 'sweep-now', shardCount = 2) =>
    writeFileSync(join(logs, `pod-${n}.json`), JSON.stringify({ commit: sha, files, shardCount, sweepId, attemptId: `attempt-${n}`,
      runtimeIdentity,
      ...(imageDigest ? { imageDigest } : {}) }));
  row(0, ['a.test.ts'], digest);
  row(1, ['b.test.ts'], digest);
  const input = { root: dir, version: '0.2.34', commit: sha, fullSweep: true, graphPins: pins,
    envFingerprint: testEnvFingerprint };
  expect(gateBaselineReceipt(input)).toMatchObject({ schema: 2, valid: true, imageDigest: digest, executionIdentity: runtimeIdentity, files: 2, shards: 2,
    graphSha: pins.graphSha, recipeSha: pins.recipeSha });
  writeFileSync(join(logs, 'pod-0-c0.json'), JSON.stringify({ commit: 'f'.repeat(40), files: ['old.test.ts'],
    parentAttempt: 'old-attempt', attemptId: 'old-child' }));
  expect(gateBaselineReceipt(input).valid).toBe(true);
  writeFileSync(join(logs, 'pod-0-c1.json'), JSON.stringify({ commit: sha, files: ['a.test.ts'],
    parentAttempt: 'attempt-0', attemptId: 'current-child', sweepId: 'sweep-now' }));
  expect(gateBaselineReceipt(input)).toMatchObject({ valid: false, reason: 'actual Pod image digest absent: pod-0-c1.json' });
  writeFileSync(join(logs, 'pod-0-c1.json'), JSON.stringify({ commit: sha, files: ['a.test.ts'],
    parentAttempt: 'attempt-0', attemptId: 'current-child', sweepId: 'sweep-now', imageDigest: digest, runtimeIdentity }));
  row(1, ['b.test.ts']);
  expect(gateBaselineReceipt(input)).toMatchObject({ valid: false, reason: 'actual Pod image digest absent: pod-1.json' });
  row(1, ['b.test.ts'], digest);
  row(1, ['b.test.ts'], digest, 'older-sweep');
  expect(gateBaselineReceipt(input)).toMatchObject({ valid: false, reason: 'root cut shards belong to different sweeps' });
  row(1, ['b.test.ts'], digest, 'sweep-now', 3);
  expect(gateBaselineReceipt(input)).toMatchObject({ valid: false, reason: 'root cut shards belong to different sweeps' });
  row(1, ['b.test.ts'], digest);
  expect(gateBaselineReceipt({ ...input, fullSweep: false })).toMatchObject({ valid: false, reason: 'gate was not a complete clean full sweep' });
  expect(gateBaselineReceipt({ ...input, graphPins: null })).toMatchObject({ valid: false, reason: 'pinned graph or recipe SHA absent' });
});

test('missing, malformed, or mismatched Pod runtime identity cannot mint a reusable receipt', () => {
  const dir = root();
  const logs = join(dir, 'release', '0.2.34', 'gate-logs', 'cut');
  mkdirSync(logs, { recursive: true });
  const input = { root: dir, version: '0.2.34', commit: sha, fullSweep: true, graphPins: pins,
    envFingerprint: testEnvFingerprint };
  const write = (identity: unknown) => writeFileSync(join(logs, 'pod-0.json'), JSON.stringify({ commit: sha,
    files: ['a.test.ts'], shardCount: 1, sweepId: 'sweep-now', attemptId: 'attempt-0', imageDigest: digest,
    ...(identity === undefined ? {} : { runtimeIdentity: identity }) }));
  write(undefined);
  expect(gateBaselineReceipt(input)).toMatchObject({ valid: false, reason: 'actual Pod runtime identity absent: pod-0.json' });
  write({ ...runtimeIdentity, architecture: '' });
  expect(gateBaselineReceipt(input)).toMatchObject({ valid: false, reason: 'actual Pod runtime identity absent: pod-0.json' });
  write({ ...runtimeIdentity, envFingerprint: 'e'.repeat(64) });
  expect(gateBaselineReceipt(input)).toMatchObject({ valid: false, reason: 'actual Pod environment differs: pod-0.json' });
});

test('an unresolved failure attribution recheck cannot mint or mislabel a reusable receipt', () => {
  expect(gateBaselineReceipt({ root: root(), version: '0.2.41', commit: sha, fullSweep: false, graphPins: pins,
    envFingerprint: gateEnvFingerprint({}), attributionRecheck: { summary: 39, observed: 78, identified: 39,
      baselineResult: 'completed', targetFiles: ['src/a.test.ts'] } }))
    .toMatchObject({ valid: false, reason: 'failure attribution unresolved after baseline recheck (completed): summary=39, observed=78, identified=39',
      attributionRecheck: { summary: 39, observed: 78, identified: 39, baselineResult: 'completed', targetFiles: ['src/a.test.ts'] } });
});

test('graph and recipe pins come from the exact release graph run state', () => {
  const dir = root();
  const runs = join(dir, 'graph-runs', 'release-loop');
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, 'run-1.json'), JSON.stringify({ graphId: 'release-loop', runId: 'run-1',
    graphSnapshot: { graphSha: pins.graphSha, recipesSha: pins.recipeSha } }));
  expect(gateGraphPins(dir, 'run-1')).toEqual(pins);
  expect(gateGraphPins(dir, '../run-1')).toBeNull();
  expect(gateGraphPins(dir, 'missing')).toBeNull();
});

test('a current sweep child with a missing or corrupt parent cannot vanish from image validation', () => {
  const dir = root();
  const logs = join(dir, 'release', '0.2.34', 'gate-logs', 'cut');
  mkdirSync(logs, { recursive: true });
  for (const n of [0, 1]) writeFileSync(join(logs, `pod-${n}.json`), JSON.stringify({
    commit: sha, files: [`${n}.test.ts`], shardCount: 2, sweepId: 'sweep-now', attemptId: `attempt-${n}`, imageDigest: digest, runtimeIdentity,
  }));
  const input = { root: dir, version: '0.2.34', commit: sha, fullSweep: true, graphPins: pins,
    envFingerprint: testEnvFingerprint };
  const child = join(logs, 'pod-0-c0.json');
  expect(gateBaselineReceipt(input).valid).toBe(true);
  writeFileSync(child, JSON.stringify({ commit: sha, sweepId: 'sweep-now', attemptId: 'orphan', imageDigest: `sha256:${'e'.repeat(64)}` }));
  expect(gateBaselineReceipt(input)).toMatchObject({ valid: false, reason: 'cut Pod pod-0-c0.json has no connected parent attempt' });
  writeFileSync(child, JSON.stringify({ commit: sha, sweepId: 'sweep-now', parentAttempt: 'wrong-parent', attemptId: 'orphan', imageDigest: `sha256:${'e'.repeat(64)}` }));
  expect(gateBaselineReceipt(input)).toMatchObject({ valid: false, reason: 'cut Pod pod-0-c0.json has no connected parent attempt' });
  writeFileSync(child, JSON.stringify({ commit: sha, parentAttempt: 'wrong-parent', attemptId: 'orphan', imageDigest: `sha256:${'e'.repeat(64)}` }));
  expect(gateBaselineReceipt(input)).toMatchObject({ valid: false, reason: 'cut Pod pod-0-c0.json has no sweep identity' });
  writeFileSync(child, JSON.stringify({ commit: sha, sweepId: 'older-sweep', parentAttempt: 'old-parent', attemptId: 'old-child' }));
  expect(gateBaselineReceipt(input).valid).toBe(true);
});
