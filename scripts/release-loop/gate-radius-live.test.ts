import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateRepoDigestProbeRequest, hardRehearsalGateArgs, hardRehearsalGateVersion, parseGateRepoDigestResponse, partialGateImagesMatch, planHardRehearsalRadius } from './gate-radius-live';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('gate image probe uses the registry RepoDigest paired with, but distinct from, the host-local Image ID', () => {
  const imageId = `sha256:${'a'.repeat(64)}`;
  const repoDigest = `sha256:${'b'.repeat(64)}`;
  const probeFixture = { image: 'elanous-harness:local', commit: 'c'.repeat(40), imageId, repoDigest };
  const headers = `HTTP/1.1 200 OK\r\nContent-Type: application/vnd.oci.image.manifest.v1+json\r\nDocker-Content-Digest: ${probeFixture.repoDigest}\r\n\r\n`;
  expect(parseGateRepoDigestResponse(headers)).toBe(repoDigest);
  expect(parseGateRepoDigestResponse(headers)).not.toBe(probeFixture.imageId);
  expect(parseGateRepoDigestResponse('HTTP/1.1 200 OK\r\n\r\n')).toBeNull();
});

test('remote gate image probe sends Accept to a registry and parses its RepoDigest', async () => {
  const repoDigest = `sha256:${'b'.repeat(64)}`;
  let receivedAccept = '';
  const server = createServer((request, response) => {
    receivedAccept = request.headers.accept ?? '';
    response.writeHead(200, { 'Docker-Content-Digest': repoDigest });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, 'localhost', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test registry did not bind a TCP port');
    const request = gateRepoDigestProbeRequest(`localhost:${address.port}`, 'elanous-harness:local', 'c'.repeat(40));
    expect(request).not.toBeNull();
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn('sh', ['-c', request!.command], { stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout }));
    });
    expect(result.code).toBe(0);
    expect(receivedAccept).toContain('application/vnd.oci.image.index.v1+json');
    expect(parseGateRepoDigestResponse(result.stdout)).toBe(repoDigest);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'radius-live-repo-'));
  const root = mkdtempSync(join(tmpdir(), 'radius-live-ledger-'));
  dirs.push(repo, root);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q'); git('config', 'user.email', 'tc@test'); git('config', 'user.name', 'TC');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'package.json'), '{"version":"1.0.0"}\n');
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'src/a.test.ts'), "import { a } from './a'; test('a', () => a);\n");
  writeFileSync(join(repo, 'src/b.test.ts'), "test('b', () => require('../package.json').version);\n");
  writeFileSync(join(repo, 'src/c.test.ts'), "test('c', () => process.env.npm_package_version);\n");
  git('add', '.'); git('commit', '-qm', 'hard rehearsal');
  const priorCommit = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;\n');
  writeFileSync(join(repo, 'package.json'), '{"version":"1.0.1"}\n');
  git('add', '.'); git('commit', '-qm', 'release cut');
  const forCommit = git('rev-parse', 'HEAD');
  const version = '1.0.1';
  const runId = 'hard-12345678-1234-1234-1234-123456789abc';
  const gateVersion = hardRehearsalGateVersion(version, runId);
  const pins = { graphSha: 'c'.repeat(64), recipeSha: 'd'.repeat(64) };
  const envFingerprint = 'e'.repeat(64);
  const imageDigest = `sha256:${'f'.repeat(64)}`;
  const runtimeIdentity = { bunVersion: '1.4.2', platform: 'linux', architecture: 'x64', envFingerprint };
  const executionIdentity = { imageDigest, ...runtimeIdentity };
  const stampDir = join(root, 'release', version, 'rehearsal');
  const gateDir = join(root, 'release', gateVersion);
  mkdirSync(stampDir, { recursive: true }); mkdirSync(gateDir, { recursive: true });
  writeFileSync(join(stampDir, 'hard-5h.json'), JSON.stringify({ version, step: 'hard-5h', outcome: 'ok', sha: priorCommit,
    endedAt: '2026-10-20T10:00:00.000Z',
    hardGateRunId: runId, hardGate: { outcome: 'ok', commit: priorCommit, executor: 'pod', introduced: [] } }));
  writeFileSync(join(gateDir, 'gate-verdict.json'), JSON.stringify({ commit: priorCommit, outcome: 'ok',
    baselineReceipt: { schema: 2, valid: true, reason: 'complete clean full sweep', version: gateVersion, commit: priorCommit,
      ...pins, envFingerprint, imageDigest, executionIdentity: runtimeIdentity, files: 3, shards: 1 } }));
  writeFileSync(join(gateDir, 'gate-failures.json'), JSON.stringify({ commit: priorCommit, failures: [], errors: [] }));
  mkdirSync(join(gateDir, 'gate-logs', 'cut'), { recursive: true });
  writeFileSync(join(gateDir, 'gate-logs', 'cut', 'pod-0.json'), JSON.stringify({
    commit: priorCommit, files: ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'], imageDigest, runtimeIdentity,
    shardCount: 1, sweepId: 'sweep-one', attemptId: 'attempt-one',
  }));
  const input = { root, repo, version, forCommit, graphPins: pins, envFingerprint, imageDigest, executionIdentity };
  return { input, stampDir, gateDir, gateVersion, priorCommit };
}

test('hard rehearsal evidence uses a distinct rc path; its receipt selects only the changed import radius', () => {
  const { input, gateDir, gateVersion } = fixture();
  const releaseVerdict = join(input.root, 'release', input.version, 'gate-verdict.json');
  writeFileSync(releaseVerdict, '{"owner":"release"}\n');
  expect(gateVersion).not.toBe(input.version);
  expect(hardRehearsalGateVersion(input.version, 'hard-12345678-1234-1234-1234-123456789abd')).not.toBe(gateVersion);
  const args = hardRehearsalGateArgs(input.version, 'hard-12345678-1234-1234-1234-123456789abc', input.forCommit, '1.0.0', 'node-b:1');
  expect(args[args.indexOf('--version') + 1]).toBe(gateVersion);
  expect(args).toContain('--rehearsal-baseline');
  expect(planHardRehearsalRadius(input)).toMatchObject({ plan: { files: ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'], priorCommit: expect.any(String) },
    reason: 'hard rehearsal receipt and import radius verified' });
  expect(readFileSync(releaseVerdict, 'utf8')).toBe('{"owner":"release"}\n');
  expect(readFileSync(join(gateDir, 'gate-verdict.json'), 'utf8')).toContain('baselineReceipt');
});

test('missing or mismatched receipt identities return a full gate', () => {
  const { input, gateDir } = fixture();
  expect(planHardRehearsalRadius({ ...input, imageDigest: null }).plan).toBeNull();
  expect(planHardRehearsalRadius({ ...input, graphPins: { ...input.graphPins, graphSha: 'a'.repeat(64) } }).plan).toBeNull();
  expect(planHardRehearsalRadius({ ...input, envFingerprint: 'a'.repeat(64) }).plan).toBeNull();
  expect(planHardRehearsalRadius({ ...input, imageDigest: `sha256:${'a'.repeat(64)}` }).plan).toBeNull();
  expect(planHardRehearsalRadius({ ...input, executionIdentity: null }).plan).toBeNull();
  expect(planHardRehearsalRadius({ ...input, executionIdentity: { ...input.executionIdentity, bunVersion: '1.4.3' } }).plan).toBeNull();
  expect(planHardRehearsalRadius({ ...input, executionIdentity: { ...input.executionIdentity, architecture: 'arm64' } }).plan).toBeNull();
  const path = join(gateDir, 'gate-verdict.json');
  const verdict = JSON.parse(readFileSync(path, 'utf8'));
  verdict.baselineReceipt.files = 1;
  writeFileSync(path, JSON.stringify(verdict));
  expect(planHardRehearsalRadius(input)).toMatchObject({ plan: null, reason: expect.stringContaining('hard rehearsal Pod proof differs') });
  verdict.baselineReceipt.files = 3;
  verdict.baselineReceipt.executionIdentity.bunVersion = '1.4.3';
  writeFileSync(path, JSON.stringify(verdict));
  expect(planHardRehearsalRadius(input).plan).toBeNull();
  verdict.baselineReceipt.executionIdentity.bunVersion = input.executionIdentity.bunVersion;
  writeFileSync(path, JSON.stringify(verdict));
  writeFileSync(join(gateDir, 'gate-logs', 'cut', 'pod-0.json'), JSON.stringify({
    commit: input.forCommit, files: ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'], imageDigest: input.imageDigest,
    runtimeIdentity: { bunVersion: input.executionIdentity.bunVersion, platform: input.executionIdentity.platform,
      architecture: input.executionIdentity.architecture, envFingerprint: input.executionIdentity.envFingerprint },
    shardCount: 1, sweepId: 'sweep-one', attemptId: 'attempt-one',
  }));
  expect(planHardRehearsalRadius(input).plan).toBeNull();
});

test('a hard rehearsal with failures or a missing error ledger cannot authorize reuse', () => {
  const { input, gateDir } = fixture();
  const failures = join(gateDir, 'gate-failures.json');
  writeFileSync(failures, JSON.stringify({ commit: input.forCommit, failures: [], errors: [] }));
  expect(planHardRehearsalRadius(input).plan).toBeNull();
  writeFileSync(failures, JSON.stringify({ commit: JSON.parse(readFileSync(join(gateDir, 'gate-verdict.json'), 'utf8')).commit,
    failures: ['src/a.test.ts > known'] }));
  expect(planHardRehearsalRadius(input).plan).toBeNull();
});

test('actual partial Pod image drift blocks carried results', () => {
  const { input } = fixture();
  const dir = join(input.root, 'release', input.version, 'gate-logs', 'cut-partial');
  mkdirSync(dir, { recursive: true });
  const proof = { id: '12345678-1234-1234-1234-123456789abc', shards: 1, files: ['src/a.test.ts'] };
  const root = { commit: input.forCommit, imageDigest: input.imageDigest, sweepId: proof.id, shardCount: 1,
    attemptId: 'attempt-one', files: proof.files };
  expect(partialGateImagesMatch(input.root, input.version, input.imageDigest, input.forCommit, undefined)).toBe(false);
  writeFileSync(join(dir, 'pod-0.json'), JSON.stringify({ ...root, sweepId: 'stale-sweep' }));
  expect(partialGateImagesMatch(input.root, input.version, input.imageDigest, input.forCommit, proof)).toBe(false);
  writeFileSync(join(dir, 'pod-0.json'), JSON.stringify(root));
  expect(partialGateImagesMatch(input.root, input.version, input.imageDigest, input.forCommit, proof)).toBe(true);
  expect(partialGateImagesMatch(input.root, input.version, input.imageDigest, 'a'.repeat(40), proof)).toBe(false);
  writeFileSync(join(dir, 'pod-1.json'), JSON.stringify({ ...root, sweepId: 'old-sweep', imageDigest: `sha256:${'a'.repeat(64)}` }));
  expect(partialGateImagesMatch(input.root, input.version, input.imageDigest, input.forCommit, proof)).toBe(false);
  rmSync(join(dir, 'pod-1.json'));
  expect(partialGateImagesMatch(input.root, input.version, input.imageDigest, input.forCommit, proof)).toBe(true);
  writeFileSync(join(dir, 'pod-0-old-retry.json'), JSON.stringify({ commit: input.forCommit,
    parentAttempt: 'attempt-one', attemptId: 'attempt-unknown', imageDigest: `sha256:${'a'.repeat(64)}` }));
  expect(partialGateImagesMatch(input.root, input.version, input.imageDigest, input.forCommit, proof)).toBe(false);
  rmSync(join(dir, 'pod-0-old-retry.json'));
  writeFileSync(join(dir, 'pod-0-old-retry.json'), JSON.stringify({ parentAttempt: 'attempt-one',
    attemptId: 'attempt-unknown', imageDigest: `sha256:${'a'.repeat(64)}` }));
  expect(partialGateImagesMatch(input.root, input.version, input.imageDigest, input.forCommit, proof)).toBe(false);
  rmSync(join(dir, 'pod-0-old-retry.json'));
  expect(partialGateImagesMatch(input.root, input.version, input.imageDigest, input.forCommit,
    { ...proof, shards: 2 })).toBe(false);
  writeFileSync(join(dir, 'pod-0-retry.json'), JSON.stringify({ sweepId: proof.id,
    parentAttempt: 'attempt-one', attemptId: 'attempt-two', imageDigest: `sha256:${'a'.repeat(64)}` }));
  expect(partialGateImagesMatch(input.root, input.version, input.imageDigest, input.forCommit, proof)).toBe(false);
});

test('a hard rehearsal receipt cannot omit an eligible test even when its counts agree', () => {
  const { input, gateDir } = fixture();
  const verdictPath = join(gateDir, 'gate-verdict.json');
  const verdict = JSON.parse(readFileSync(verdictPath, 'utf8'));
  verdict.baselineReceipt.files = 2;
  writeFileSync(verdictPath, JSON.stringify(verdict));
  const podPath = join(gateDir, 'gate-logs', 'cut', 'pod-0.json');
  const pod = JSON.parse(readFileSync(podPath, 'utf8'));
  pod.files = pod.files.slice(0, 2);
  writeFileSync(podPath, JSON.stringify(pod));
  expect(planHardRehearsalRadius(input)).toMatchObject({ plan: null,
    reason: 'hard rehearsal file inventory differs from receipt' });
});

for (const withDocs of [false, true]) test(`version-only bump ${withDocs ? 'with docs' : 'alone'} selects its readers`, () => {
  const { input } = fixture();
  writeFileSync(join(input.repo, 'src/a.ts'), 'export const a = 1;\n');
  if (withDocs) writeFileSync(join(input.repo, 'README.md'), '# release notes\n');
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: input.repo, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  git('add', '.'); git('-c', 'user.name=TC', '-c', 'user.email=tc@test', 'commit', '-qm', 'version and docs');
  const decision = planHardRehearsalRadius({ ...input, forCommit: git('rev-parse', 'HEAD') });
  expect(decision).toMatchObject({ reason: 'hard rehearsal receipt and import radius verified',
    plan: { files: ['src/b.test.ts', 'src/c.test.ts'] } });
  expect(decision.plan?.kind).toBeUndefined();
});

test('a newer failed hard rehearsal prevents reuse of an older green one', () => {
  const { input, stampDir } = fixture();
  const five = JSON.parse(readFileSync(join(stampDir, 'hard-5h.json'), 'utf8'));
  writeFileSync(join(stampDir, 'hard-mid.json'), JSON.stringify({ ...five, step: 'hard-mid', endedAt: '2026-10-20T08:00:00.000Z' }));
  writeFileSync(join(stampDir, 'hard-5h.json'), JSON.stringify({ ...five, outcome: 'error' }));
  expect(planHardRehearsalRadius(input)).toMatchObject({ plan: null, reason: 'latest hard rehearsal is not clean' });
});

test('a later failed hard-mid prevents reuse of an earlier green hard-5h', () => {
  const { input, stampDir } = fixture();
  const five = JSON.parse(readFileSync(join(stampDir, 'hard-5h.json'), 'utf8'));
  writeFileSync(join(stampDir, 'hard-mid.json'), JSON.stringify({ ...five, step: 'hard-mid', outcome: 'error',
    endedAt: '2026-10-20T11:00:00.000Z' }));
  expect(planHardRehearsalRadius(input)).toMatchObject({ plan: null, reason: 'latest hard rehearsal is not clean' });
});
