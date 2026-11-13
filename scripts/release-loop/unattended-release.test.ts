import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import { APPROVED_RELEASE_EXEC_PATCH_MANIFEST_SHA256, assertReleaseCliCurrent, buildReleaseRunInput, latestPublishedPreviousVersion, runUnattendedRelease } from './unattended-release.js';
import { parseOptions } from './gate-node.js';
import { enableLandingFreeze, disableLandingFreeze } from '../../src/release-loop/landing-freeze.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { opSeatFlockPath } from '../../src/steward/resync-tick.js';
import { readLatestMorningRlaScorecard } from '../../src/domains/morning-detail.js';
import { debug } from '../../src/debug/log.js';
import { psProcessStartMs } from '../../src/harness/harness-stop.js';

const instanceRoots: string[] = [];
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'unattended-instance-'));
  instanceRoots.push(root);
  setElanousConfigDir(root);
});
afterEach(() => {
  resetElanousConfigDir();
  for (const dir of instanceRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(body: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'unattended-release-'));
  try { body(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function record(root: string, dir: string, data: unknown) {
  const path = join(root, 'release', dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'release.json'), JSON.stringify(data));
}

test('previous version is the greatest earlier published ledger version, not newest directory or current version', () => fixture((root) => {
  record(root, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
  record(root, '0.9.0', { version: '0.9.0', publishedAt: 'now' });
  record(root, '0.10.0', { version: '0.10.0', publishedAt: 'now' });
  record(root, '0.11.0', { version: '0.11.0', preparedAt: 'now' });
  record(root, '0.12.0', { version: '0.12.0', publishedAt: 'now' });
  record(root, '0.10.1', { version: '0.9.0', publishedAt: 'now' });
  record(root, '0.10.2', { version: '0.10.2', publishedAt: '' });
  expect(latestPublishedPreviousVersion('0.12.0', root)).toBe('0.10.0');
  expect(() => latestPublishedPreviousVersion('0.2.3', root)).toThrow('no published previous release');
  expect(() => latestPublishedPreviousVersion('../0.12.0', root)).toThrow('release version must be x.y.z');
}));

test('previous version preserves precision beyond Number.MAX_SAFE_INTEGER', () => fixture((root) => {
  record(root, '9007199254740991.0.0', { version: '9007199254740991.0.0', publishedAt: 'now' });
  record(root, '9007199254740992.0.0', { version: '9007199254740992.0.0', publishedAt: 'now' });
  expect(latestPublishedPreviousVersion('9007199254740993.0.0', root)).toBe('9007199254740992.0.0');
}));

test('incident 0306: release launch rejects a CLI checkout behind origin/main', () => fixture((root) => {
  const remote = join(root, 'origin.git'), repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'release-sim'); git(repo, 'config', 'user.email', 'release-sim@example.invalid');
  writeFileSync(join(repo, 'sentinel'), 'old'); git(repo, 'add', 'sentinel'); git(repo, 'commit', '-m', 'old');
  const old = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-u', 'origin', 'main');
  writeFileSync(join(repo, 'sentinel'), 'new'); git(repo, 'commit', '-am', 'new');
  const cut = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', 'origin', 'main');
  git(repo, 'reset', '--hard', old);
  expect(() => assertReleaseCliCurrent(repo, cut)).not.toThrow();
  expect(() => assertReleaseCliCurrent(repo)).toThrow(/stale release CLI/);
  writeFileSync(join(repo, 'untracked-source'), 'modified');
  expect(() => assertReleaseCliCurrent(repo, cut)).toThrow(/uncommitted changes/);
  rmSync(join(repo, 'untracked-source'));
  git(repo, 'push', 'origin', `${old}:refs/heads/release/0.2.3`);
  expect(() => assertReleaseCliCurrent(repo)).not.toThrow();
}));

const APPROVED_RELEASE_EXEC_PATCH_MANIFEST_BYTES = `{
  "baseHead": "06c67bdd0b1143391fd3801596c8bf2a360d3c72",
  "paths": [
    "scripts/release-loop/publish-node.ts",
    "scripts/release-loop/unattended-release.ts",
    "scripts/release-loop/version-node.ts"
  ],
  "diffSha256": "5b1e0deda2d77c50e8e9cd2ed8f358199ac9618db72cf610ca760a59fb50ef96",
  "recordedAt": "2026-11-11T22:12:27.326848+00:00",
  "note": "OP approved #37063 and #37070 append; release-only execution patches carried to final cut tip"
}
`;

test('forged execution patch manifest is rejected even when its diff hash matches the dirty CLI', () => fixture((root) => {
  const remote = join(root, 'origin.git'), repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '--bare', remote], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main'); git('config', 'user.name', 'release-sim'); git('config', 'user.email', 'release-sim@example.invalid');
  const paths = ['scripts/release-loop/publish-node.ts', 'scripts/release-loop/unattended-release.ts', 'scripts/release-loop/version-node.ts'];
  for (const path of paths) { mkdirSync(join(repo, 'scripts', 'release-loop'), { recursive: true }); writeFileSync(join(repo, path), 'before\n'); }
  git('add', '.'); git('commit', '-m', 'base'); git('remote', 'add', 'origin', remote); git('push', '-u', 'origin', 'main');
  for (const path of paths) writeFileSync(join(repo, path), 'after\n');
  const forgedBody = JSON.stringify({ baseHead: git('rev-parse', 'HEAD'), paths,
    diffSha256: createHash('sha256').update(git('diff', '--binary', '--', ...paths)).digest('hex') });
  const forged = join(root, 'manifest.json');
  const forgedNamed = join(root, 'release-exec-patch-manifest-0623.json');
  writeFileSync(forged, forgedBody);
  writeFileSync(forgedNamed, forgedBody);
  const approvedDir = join(root, 'approved');
  mkdirSync(approvedDir, { recursive: true });
  const approved = join(approvedDir, 'release-exec-patch-manifest-0623.json');
  writeFileSync(approved, APPROVED_RELEASE_EXEC_PATCH_MANIFEST_BYTES);
  expect(createHash('sha256').update(readFileSync(approved)).digest('hex')).toBe(APPROVED_RELEASE_EXEC_PATCH_MANIFEST_SHA256);
  const previous = process.env.ELANOUS_RELEASE_EXEC_PATCH_MANIFEST;
  try {
    process.env.ELANOUS_RELEASE_EXEC_PATCH_MANIFEST = forged;
    expect(() => assertReleaseCliCurrent(repo)).toThrow(/unapproved release CLI execution patch manifest/);
    process.env.ELANOUS_RELEASE_EXEC_PATCH_MANIFEST = forgedNamed;
    expect(() => assertReleaseCliCurrent(repo)).toThrow(/unapproved release CLI execution patch manifest/);
    process.env.ELANOUS_RELEASE_EXEC_PATCH_MANIFEST = approved;
    expect(() => assertReleaseCliCurrent(repo)).toThrow(/manifest does not match checkout/);
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_RELEASE_EXEC_PATCH_MANIFEST;
    else process.env.ELANOUS_RELEASE_EXEC_PATCH_MANIFEST = previous;
  }
}));

test('incident 0306: a new request resumes the saved same-version failed run id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unattended-resume-same-cut-'));
  try {
    record(root, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    const runId = 'failed-run-for-0-2-4';
    const runsDir = join(root, 'graph-runs', 'release-loop');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, `${runId}.json`), JSON.stringify({ graphId: 'release-loop', runId, startedAt: '2026-11-07T00:00:00Z',
      status: 'failed', input: { version: '0.2.4', previousVersion: '0.2.3', gatePodPool: 'pool', gateExecutor: 'pod', branchCut: true },
      path: ['version-release', 'gate'], nodes: [
        { nodeId: 'version-release', ok: true, output: JSON.stringify({ outcome: 'ok', version: '0.2.4', commit: 'c'.repeat(40), branch: 'release/0.2.4' }) },
        { nodeId: 'gate', ok: false, output: JSON.stringify({ outcome: 'fail' }) },
      ], executed: 2 }));
    const observed: Record<string, unknown>[] = [];
    const deps = { ledgerRoot: root, assertCliCurrent: (repo: string) => { expect(repo).toBe(resolve(import.meta.dir, '../..')); },
      config: { gatePodPool: 'pool' }, checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
      graph: async (_path: string, options: unknown) => { observed.push(options as Record<string, unknown>); return { status: 'failed', runId } as never; } };
    let first: Awaited<ReturnType<typeof runUnattendedRelease>>;
    let second: Awaited<ReturnType<typeof runUnattendedRelease>>;
    first = await runUnattendedRelease({ version: '0.2.4' }, deps);
    second = await runUnattendedRelease({ version: '0.2.4' }, deps);
    const unreadablePath = join(runsDir, 'malformed.json');
    writeFileSync(unreadablePath, '{');
    await expect(runUnattendedRelease({ version: '0.2.4' }, deps)).rejects.toThrow('graph run ledger(s) are unreadable');
    expect(observed).toHaveLength(2);
    rmSync(unreadablePath);
    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatchObject({ resumeRunId: runId, fromNodeId: 'gate', useCurrentGraph: true, resumeInputPatch: { gateImagePin: 'cut-commit' } });
    expect(typeof (observed[0]?.deps as { dispatchGraphSubscription?: unknown } | undefined)?.dispatchGraphSubscription).toBe('function');
    expect(observed[0]).not.toHaveProperty('runId');
    expect(observed[1]).toMatchObject({ resumeRunId: runId, fromNodeId: 'gate', useCurrentGraph: true, resumeInputPatch: { gateImagePin: 'cut-commit' } });
    expect(typeof (observed[1]?.deps as { dispatchGraphSubscription?: unknown } | undefined)?.dispatchGraphSubscription).toBe('function');
    expect(first.state?.runId).toBe(runId);
    expect(second.state?.runId).toBe(runId);
    const savedPath = join(runsDir, `${runId}.json`);
    const saved = JSON.parse(readFileSync(savedPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(savedPath, JSON.stringify({ ...saved, status: 'done' }));
    const completed = await runUnattendedRelease({ version: '0.2.4' }, deps);
    expect(observed).toHaveLength(2);
    expect(completed.state?.runId).toBe(runId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('force-new ignores a finished fan-out child and still blocks a real root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unattended-child-done-'));
  try {
    record(root, '0.3.15', { version: '0.3.15', publishedAt: 'now' });
    const runsDir = join(root, 'graph-runs', 'release-loop');
    mkdirSync(runsDir, { recursive: true });
    const cut = { outcome: 'ok', version: '0.3.16', commit: 'c'.repeat(40), branch: 'release/0.3.16' };
    const input = { version: '0.3.16', previousVersion: '0.3.15', gatePodPool: 'pool', gateExecutor: 'pod', branchCut: true };
    const child = (runId: string, entry: 'prefetch' | 'checklist-gate' | 'regression-suite') => ({
      graphId: 'release-loop', runId, parentRunId: 'root-live', entryNodeId: entry, startedAt: '2026-11-13T00:00:00Z', status: 'done', input,
      path: ['version-release', entry, 'done'],
      nodes: [
        { nodeId: 'version-release', ok: true, output: JSON.stringify(cut) },
        { nodeId: entry, ok: true },
        { nodeId: 'done', ok: true },
      ], executed: 3,
    });
    writeFileSync(join(runsDir, 'b66e1251.json'), JSON.stringify({ ...child('b66e1251', 'prefetch'), parentRunId: undefined }));
    for (const [runId, entry] of [['child-check', 'checklist-gate'], ['child-reg', 'regression-suite']] as const) {
      writeFileSync(join(runsDir, `${runId}.json`), JSON.stringify(child(runId, entry)));
    }
    let graphCalls = 0;
    const deps = { ledgerRoot: root, assertCliCurrent: () => {}, config: { gatePodPool: 'pool' },
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
      graph: async () => { graphCalls++; return { status: 'running', runId: 'fresh-root', path: ['version-release'], nodes: [], executed: 0 } as never; } };
    const launched = await runUnattendedRelease({ version: '0.3.16', forceNew: true }, deps);
    expect(launched.state?.runId).toBe('fresh-root');
    expect(graphCalls).toBe(1);
    writeFileSync(join(runsDir, 'root-done.json'), JSON.stringify({ graphId: 'release-loop', runId: 'root-done', startedAt: '2026-11-13T00:00:00Z',
      status: 'done', input, path: ['version-release', 'done'],
      nodes: [{ nodeId: 'version-release', ok: true, output: JSON.stringify(cut) }, { nodeId: 'done', ok: true }], executed: 2 }));
    const blocked = await runUnattendedRelease({ version: '0.3.16', forceNew: true }, deps);
    expect(blocked.state?.runId).toBe('root-done');
    expect(graphCalls).toBe(1);
    const pidStartedAt = psProcessStartMs(process.pid);
    expect(pidStartedAt).not.toBeNull();
    writeFileSync(join(runsDir, 'root-live.json'), JSON.stringify({ graphId: 'release-loop', runId: 'root-live', startedAt: new Date().toISOString(),
      pid: process.pid, pidStartedAt: new Date(pidStartedAt!).toISOString(), status: 'running', input, path: ['version-release'], nodes: [], executed: 0 }));
    rmSync(join(runsDir, 'root-done.json'));
    await expect(runUnattendedRelease({ version: '0.3.16', forceNew: true }, deps)).rejects.toThrow('release run claim already exists');
    expect(graphCalls).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('force-new refuses to resume a live same-version graph run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unattended-live-force-new-'));
  try {
    record(root, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    const pidStartedAt = psProcessStartMs(process.pid);
    expect(pidStartedAt).not.toBeNull();
    const runId = 'live-run-for-0-2-4';
    const runsDir = join(root, 'graph-runs', 'release-loop');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, runId + '.json'), JSON.stringify({ graphId: 'release-loop', runId,
      startedAt: new Date().toISOString(), pid: process.pid, pidStartedAt: new Date(pidStartedAt!).toISOString(),
      status: 'running', input: { version: '0.2.4' }, path: ['version-release'], nodes: [], executed: 0 }));
    let graphCalls = 0;
    await expect(runUnattendedRelease({ version: '0.2.4', forceNew: true }, {
      ledgerRoot: root, assertCliCurrent: () => {}, config: { gatePodPool: 'pool' },
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
      graph: async () => { graphCalls++; return { status: 'failed' } as never; },
    })).rejects.toThrow('release run claim already exists');
    expect(graphCalls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same-version resume rejects a changed cut mode or gate pool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unattended-incompatible-resume-'));
  try {
    record(root, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    const runId = 'failed-run-for-0-2-4';
    const runsDir = join(root, 'graph-runs', 'release-loop');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, runId + '.json'), JSON.stringify({ graphId: 'release-loop', runId,
      startedAt: '2026-11-07T00:00:00Z', status: 'failed',
      input: { version: '0.2.4', previousVersion: '0.2.3', gatePodPool: 'pool', gateExecutor: 'pod', branchCut: true },
      path: ['version-release', 'gate'], nodes: [
        { nodeId: 'version-release', ok: true, output: JSON.stringify({ outcome: 'ok', version: '0.2.4', commit: 'c'.repeat(40), branch: 'release/0.2.4' }) },
        { nodeId: 'gate', ok: false, output: JSON.stringify({ outcome: 'fail' }) },
      ], executed: 2 }));
    let graphCalls = 0;
    const deps = (gatePodPool: string) => ({ ledgerRoot: root, assertCliCurrent: () => {}, config: { gatePodPool },
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
      graph: async () => { graphCalls++; return { status: 'failed' } as never; } });
    await expect(runUnattendedRelease({ version: '0.2.4', cutCommit: 'abc1234' }, deps('pool'))).rejects.toThrow(/incompatible input fields.*branchCut|incompatible input fields.*cutCommit/);
    await expect(runUnattendedRelease({ version: '0.2.4' }, deps('different-pool'))).rejects.toThrow(/incompatible input fields.*gatePodPool/);
    expect(graphCalls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same-version resume rejects a missing or mismatched saved version cut', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unattended-invalid-cut-resume-'));
  try {
    record(root, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    const runId = 'failed-run-for-0-2-4';
    const runsDir = join(root, 'graph-runs', 'release-loop');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, runId + '.json'), JSON.stringify({ graphId: 'release-loop', runId,
      startedAt: '2026-11-07T00:00:00Z', status: 'failed',
      input: { version: '0.2.4', previousVersion: '0.2.3', gatePodPool: 'pool', gateExecutor: 'pod', branchCut: true },
      path: ['version-release', 'gate'], nodes: [
        { nodeId: 'version-release', ok: true, output: JSON.stringify({ outcome: 'ok', version: '0.2.4', commit: 'c'.repeat(40), branch: 'release/0.2.5' }) },
        { nodeId: 'gate', ok: false, output: JSON.stringify({ outcome: 'fail' }) },
      ], executed: 2 }));
    let graphCalls = 0;
    await expect(runUnattendedRelease({ version: '0.2.4' }, {
      ledgerRoot: root, assertCliCurrent: () => {}, config: { gatePodPool: 'pool' },
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
      graph: async () => { graphCalls++; return { status: 'failed' } as never; },
    })).rejects.toThrow('saved version-release cut is incompatible');
    expect(graphCalls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('release.loop config builds the full graph input with ledger previousVersion', () => fixture((root) => {
  record(root, '0.10.0', { version: '0.10.0', publishedAt: 'now' });
  const configPath = join(root, 'config.json');
  const loop = { gatePodPool: 'gate-pool', gatePodBunCache: '/var/cache/elanous-bun', gatePodShards: 4, gatePodShardTimeoutSeconds: 240, autoAppendRepair: true,
    gateRemote: 'node-b', gateRemoteMirror: '/mirror/repo.git', opsHosts: ['local', 'node-b'], internalDist: '~/dist', opsRestart: true };
  writeFileSync(configPath, JSON.stringify({ release: { loop } }));
  expect(buildReleaseRunInput('0.11.0', { ledgerRoot: root, configPath })).toEqual({ version: '0.11.0', previousVersion: '0.10.0', gateExecutor: 'pod', gateImagePin: 'cut-commit', graphCutover: 'legacy', ...loop });
}));

test('cold shard opt-in reaches pod runs only', () => fixture((root) => {
  record(root, '0.10.0', { version: '0.10.0', publishedAt: 'now' });
  const previous = process.env.ELANOUS_RELEASE_FORCE_FRESH_SHARDS;
  process.env.ELANOUS_RELEASE_FORCE_FRESH_SHARDS = '1';
  try {
    expect(buildReleaseRunInput('0.11.0', { ledgerRoot: root, config: { gatePodPool: 'pool' } })).toMatchObject({ gateExecutor: 'pod', gatePodFreshShards: true });
    process.env.ELANOUS_RELEASE_FORCE_FRESH_SHARDS = '0';
    expect(buildReleaseRunInput('0.11.0', { ledgerRoot: root, config: { gatePodPool: 'pool' } })).not.toHaveProperty('gatePodFreshShards');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_RELEASE_FORCE_FRESH_SHARDS;
    else process.env.ELANOUS_RELEASE_FORCE_FRESH_SHARDS = previous;
  }
}));

test('freeze stops gate and publish graph; force-freeze records bypass and off resumes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-freeze-'));
  try {
    enableLandingFreeze({ reason: 'drill', by: 'MK' }, root);
    record(root, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    let gates = 0;
    let published = 0;
    const deps = { freezeRoot: root, ledgerRoot: root, assertCliCurrent: () => {}, config: { gatePodPool: 'pool' },
      checklist: () => { gates++; return { ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }; },
      graph: async () => { published++; return { status: 'done' } as never; } };
    await expect(runUnattendedRelease({ version: '0.2.4' }, deps)).rejects.toThrow('동결 중 · drill');
    expect([gates, published]).toEqual([0, 0]);
    await runUnattendedRelease({ version: '0.2.4', forceFreeze: true }, deps);
    expect([gates, published]).toEqual([1, 1]);
    disableLandingFreeze(root);
    await runUnattendedRelease({ version: '0.2.4' }, deps);
    expect([gates, published]).toEqual([2, 2]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RELEASE-POLICY-PACK: production run input selects the measured Pod method and rejects a hand host override', () => fixture((root) => {
  record(root, '0.2.40', { version: '0.2.40', publishedAt: 'now' });
  const rehearsalDir = join(root, 'release', '0.2.40', 'rehearsal');
  mkdirSync(rehearsalDir, { recursive: true });
  writeFileSync(join(rehearsalDir, 'hard-5h.json'), JSON.stringify({ version: '0.2.40', step: 'hard-5h', endedAt: '2026-10-27T12:00:00Z', outcome: 'ok',
    hardGate: { outcome: 'ok', commit: 'a'.repeat(40), executor: 'pod', introduced: [], preexisting: 0 } }));
  const base = buildReleaseRunInput('0.2.41', { ledgerRoot: root, config: { gatePodPool: 'release-pool' } });
  expect(base).toMatchObject({ version: '0.2.41', previousVersion: '0.2.40', gateExecutor: 'pod', gatePodPool: 'release-pool', gateImagePin: 'cut-commit' });
  expect(() => buildReleaseRunInput('0.2.41', { ledgerRoot: root, config: { gatePodPool: 'release-pool' } }, undefined,
    { executor: 'host', host: 'node-b' })).toThrow('gate executor host conflicts with release policy pod');
}));

test('dry run reports input but never invokes the checklist or graph; completed release refreshes morning RLA scorecard', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unattended-release-'));
  try {
    record(root, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    let graphCalls = 0;
    let checklistCalls = 0;
    const runIds: string[] = [];
    const sinkSurfaces: string[] = [];
    const pins: unknown[] = [];
    const policyHandlers: string[] = [];
    const deps = { ledgerRoot: root, assertCliCurrent: () => {}, config: { gatePodPool: 'pool' },
      checklist: () => { checklistCalls++; return { ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }; },
      registerLogSink: async (surface: string) => { sinkSurfaces.push(surface); return false; },
      graph: async (_path: string, options: Parameters<NonNullable<import("./unattended-release.js").UnattendedReleaseDeps["graph"]>>[1]) => {
        graphCalls++; pins.push([options.pinChildUniverse, options.deps?.root]);
        policyHandlers.push(typeof options.deps?.dispatchGraphSubscription);
        if (!options.runId) throw new Error("graph run id missing");
        runIds.push(options.runId);
        const runDir = join(root, 'graph-runs', 'release-loop');
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, `${options.runId}.json`), JSON.stringify({ runId: options.runId, status: 'done', input: options.input }));
        return { input: options.input, status: 'done' } as never;
      } };
    const preview = await runUnattendedRelease({ version: '0.2.4', dryRun: true }, deps);
    expect(preview).toMatchObject({ dryRun: true, input: { version: '0.2.4', previousVersion: '0.2.3', gatePodPool: 'pool' } });
    expect([checklistCalls, graphCalls]).toEqual([0, 0]);
    expect(sinkSurfaces).toEqual([]);
    const run = await runUnattendedRelease({ version: '0.2.4' }, deps);
    expect(run).toMatchObject({ dryRun: false, state: { status: 'done', input: preview.input } });
    expect([checklistCalls, graphCalls]).toEqual([1, 1]);
    expect(policyHandlers).toEqual(['function']);
    const morningScorecard = readLatestMorningRlaScorecard(join(root, 'release'));
    expect(morningScorecard).toMatchObject({ releaseVersion: '0.2.4', runId: runIds[0], liveReleaseMeasurement: false });
    expect(morningScorecard?.source.knowledgePackIncidentCount).toBe(33);
    expect(morningScorecard?.scores).toHaveLength(10);
    expect(sinkSurfaces).toEqual(['release-loop']);
    // RELEASE-LEDGER-UNIVERSE: every node subprocess is pinned to the run's universe, not re-resolved from its cwd tree.
    expect(pins).toEqual([[true, root]]);
    await expect(runUnattendedRelease({ version: '0.2.4' }, { ...deps, checklist: () => ({ ok: false, red: ['K13'], undecided: [], blocked: [], moved: [], knownIssues: [] }) })).rejects.toThrow('K13');
    expect(graphCalls).toBe(1);
    expect(sinkSurfaces).toEqual(['release-loop']);
    for (const invalid of [{}, { gatePodPool: '  ' }]) {
      await expect(runUnattendedRelease({ version: '0.2.4' }, { ...deps, config: invalid })).rejects.toThrow('release.loop.gatePodPool');
    }
    expect(graphCalls).toBe(1);
    await expect(runUnattendedRelease({ version: '0.2.4', dryRun: true }, { ...deps, config: {} })).rejects.toThrow('release.loop.gatePodPool');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RLA scorecard refresh failure is logged and does not change completed release verdict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unattended-release-scorecard-failure-'));
  try {
    record(root, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    const scorecardFailureRunIds: string[] = [];
    const run = await runUnattendedRelease({ version: '0.2.4' }, {
      ledgerRoot: root, assertCliCurrent: () => {}, config: { gatePodPool: 'pool' },
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
      registerLogSink: async () => false,
      graph: async (_path: string, options: Parameters<NonNullable<import("./unattended-release.js").UnattendedReleaseDeps["graph"]>>[1]) => {
        if (!options.runId) throw new Error("graph run id missing");
        scorecardFailureRunIds.push(options.runId);
        const runDir = join(root, 'graph-runs', 'release-loop');
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, `${options.runId}.json`), JSON.stringify({ runId: options.runId, status: 'done', input: options.input }));
        return { status: 'done', input: options.input } as never;
      },
      refreshScorecard: () => { throw new Error('simulated report failure'); },
    });
    expect(run.state?.status).toBe('done');
    const failedEvent = debug.events(500).find(event => event.category === 'release.run' && event.event === 'rla-scorecard-refresh-failed'
      && JSON.stringify(event).includes(scorecardFailureRunIds[0]!));
    expect(JSON.stringify(failedEvent)).toContain(scorecardFailureRunIds[0]);
    expect(JSON.stringify(failedEvent)).toContain('simulated report failure');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RLA scorecard is not refreshed when the release graph has not completed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unattended-release-scorecard-incomplete-'));
  let refreshCalls = 0;
  try {
    record(root, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    const run = await runUnattendedRelease({ version: '0.2.4' }, {
      ledgerRoot: root, assertCliCurrent: () => {}, config: { gatePodPool: 'pool' },
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
      registerLogSink: async () => false,
      graph: async () => ({ status: 'failed', nodes: [] } as never),
      refreshScorecard: () => { refreshCalls++; },
    });
    expect(run.state?.status).toBe('failed');
    expect(refreshCalls).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RELEASE-BRANCH: the default run cuts a release branch; --cut-commit and --main-cut keep the main path; a freeze stays the emergency stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-branch-'));
  try {
    record(root, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    const inputs: unknown[] = [];
    const deps = { freezeRoot: root, ledgerRoot: root, assertCliCurrent: () => {}, config: { gatePodPool: 'pool' },
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
      graph: async (_p: string, o: { input?: unknown }) => { inputs.push(o.input); return { status: 'done' } as never; } };
    await runUnattendedRelease({ version: '0.2.4' }, deps);
    await runUnattendedRelease({ version: '0.2.4', cutCommit: 'abc1234' }, deps);
    await runUnattendedRelease({ version: '0.2.4', mainCut: true }, deps);
    expect(inputs).toEqual([
      { gatePodPool: 'pool', graphCutover: 'legacy', gateExecutor: 'pod', gateImagePin: 'cut-commit', version: '0.2.4', previousVersion: '0.2.3', branchCut: true },
      { gatePodPool: 'pool', graphCutover: 'legacy', gateExecutor: 'pod', gateImagePin: 'cut-commit', version: '0.2.4', previousVersion: '0.2.3', cutCommit: 'abc1234' },
      { gatePodPool: 'pool', graphCutover: 'legacy', gateExecutor: 'pod', gateImagePin: 'cut-commit', version: '0.2.4', previousVersion: '0.2.3' },
    ]);
    enableLandingFreeze({ reason: 'emergency', by: 'OP' }, root);
    await expect(runUnattendedRelease({ version: '0.2.4' }, deps)).rejects.toThrow('동결 중 · emergency');
    expect(inputs).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RELEASE-REHEARSAL-RC: --prerelease rc numbers the next free rc, skips the checklist and never allows a main cut', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-rc-'));
  try {
    record(root, '0.2.17', { version: '0.2.17', publishedAt: 'now' });
    record(root, '0.2.18-rc.0', { version: '0.2.18-rc.0', publishedAt: 'now' });
    let checklists = 0;
    const inputs: Array<Record<string, unknown>> = [];
    const asked: string[] = [];
    const deps = { ledgerRoot: root, assertCliCurrent: () => {}, config: { gatePodPool: 'pool' },
      releaseRefs: (base: string, kind: string) => { asked.push(`${base}/${kind}`); return ['refs/heads/release/0.2.18-rc.0', 'refs/tags/v0.2.18-rc.1', 'refs/tags/v0.2.18-rc.1^{}', 'refs/heads/release/0.2.18-rc.x', 'refs/heads/release/0.2.19-rc.7']; },
      checklist: () => { checklists++; return { ok: false, red: ['K1'], undecided: [], blocked: [], moved: [], knownIssues: [] }; },
      graph: async (_p: string, o: { input?: unknown }) => { inputs.push(o.input as Record<string, unknown>); return { status: 'done' } as never; } };
    const preview = await runUnattendedRelease({ version: '0.2.18', prerelease: 'rc', dryRun: true }, deps);
    expect(preview.input).toEqual({ gatePodPool: 'pool', graphCutover: 'legacy', gateExecutor: 'pod', gateImagePin: 'cut-commit', version: '0.2.18-rc.2', previousVersion: '0.2.17', branchCut: true });
    await runUnattendedRelease({ version: '0.2.18', prerelease: 'rc' }, deps);
    expect(inputs[0]!.version).toBe('0.2.18-rc.2');
    expect(checklists).toBe(0);
    expect(asked).toEqual(['0.2.18/rc', '0.2.18/rc']);
    await expect(runUnattendedRelease({ version: '0.2.18', prerelease: 'rc', mainCut: true }, deps)).rejects.toThrow('never bump main');
    await expect(runUnattendedRelease({ version: '0.2.18', prerelease: 'rc', cutCommit: 'abc1234' }, deps)).rejects.toThrow('never bump main');
    await expect(runUnattendedRelease({ version: '0.2.18-rc.0', prerelease: 'rc', dryRun: true }, deps)).rejects.toThrow('base version x.y.z');
    expect(inputs).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-MEM-ADMIT: release.loop.gatePodAdmissionWaitSeconds becomes graph input, and the gate reads it as the shard admission bound', () => fixture((root) => {
  record(root, '0.2.98', { version: '0.2.98', publishedAt: 'now' });
  const input = buildReleaseRunInput('0.2.99', { ledgerRoot: root, config: { gatePodPool: 'pool-x@h:1', gatePodAdmissionWaitSeconds: 45, gatePodIsolationConcurrency: 2, gateRecheckFileLimit: 128 } });
  expect(input).toMatchObject({ gatePodPool: 'pool-x@h:1', gatePodAdmissionWaitSeconds: 45, gatePodIsolationConcurrency: 2, gateRecheckFileLimit: 128 });
  const context = join(root, 'graph-context.json');
  writeFileSync(context, JSON.stringify({ input, outputs: {} }));
  const opts = parseOptions(['--json'], { ELANOUS_GRAPH_CONTEXT: context });
  if (opts === 'help') throw new Error('unexpected help');
  expect(opts.pod).toMatchObject({ pool: 'pool-x@h:1', admissionWaitSeconds: 45, isolationConcurrency: 2 });
  expect(opts.recheckFileLimit).toBe(128);
  // Omitted config: no bound reaches the gate, which then uses GATE_ADMISSION_WAIT_SECONDS_DEFAULT.
  writeFileSync(context, JSON.stringify({ input: buildReleaseRunInput('0.2.99', { ledgerRoot: root, config: { gatePodPool: 'pool-x@h:1' } }), outputs: {} }));
  const plain = parseOptions(['--json'], { ELANOUS_GRAPH_CONTEXT: context });
  if (plain === 'help') throw new Error('unexpected help');
  expect(plain.pod?.admissionWaitSeconds).toBeUndefined();
  expect(plain.recheckFileLimit).toBeUndefined();
}));

test('GATE-SPEED A3①: release.loop.gatePodCpu becomes graph input gatePodCpu, and the gate reads it as shard cpu request/limit', () => fixture((root) => {
  record(root, '0.2.98', { version: '0.2.98', publishedAt: 'now' });
  const input = buildReleaseRunInput('0.2.99', { ledgerRoot: root, config: { gatePodPool: 'pool-x@h:1', gatePodCpu: 2 } });
  expect(input).toMatchObject({ version: '0.2.99', previousVersion: '0.2.98', gatePodPool: 'pool-x@h:1', gatePodCpu: 2 });
  const context = join(root, 'graph-context.json');
  writeFileSync(context, JSON.stringify({ input, outputs: {} }));
  const opts = parseOptions(['--json'], { ELANOUS_GRAPH_CONTEXT: context });
  if (opts === 'help') throw new Error('unexpected help');
  expect(opts.pod).toMatchObject({ pool: 'pool-x@h:1', cpu: { request: '2', limit: '2' } });
  // Omitted config keeps today's default: no cpu override reaches the gate (request 1 / limit 4).
  writeFileSync(context, JSON.stringify({ input: buildReleaseRunInput('0.2.99', { ledgerRoot: root, config: { gatePodPool: 'pool-x@h:1' } }), outputs: {} }));
  const plain = parseOptions(['--json'], { ELANOUS_GRAPH_CONTEXT: context });
  if (plain === 'help') throw new Error('unexpected help');
  expect(plain.pod?.cpu).toBeUndefined();
}));

function tryNonBlockingFlock(path: string): (() => void) | null {
  const libc = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
  const lib = dlopen(libc, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  const flock = lib.symbols.flock as (fd: number, op: number) => number;
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  if (flock(fd, 2 | 4) !== 0) { closeSync(fd); return null; }
  return () => { try { flock(fd, 8); } finally { closeSync(fd); } };
}

test('runUnattendedRelease acquires the shared OP-seat flock for HEAD, index, and workfile mutation and releases it on every exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unattended-flock-'));
  setElanousConfigDir(root);
  try {
    record(root, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    let heldDuringGraph = false;
    const deps = { ledgerRoot: root, assertCliCurrent: () => {}, config: { gatePodPool: 'pool' },
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
      graph: async () => {
        heldDuringGraph = tryNonBlockingFlock(opSeatFlockPath(root)) === null;
        return { status: 'done' } as never;
      } };
    const run = await runUnattendedRelease({ version: '0.2.4' }, deps);
    expect(run).toMatchObject({ dryRun: false, state: { status: 'done' } });
    expect(heldDuringGraph).toBe(true);
    const after = tryNonBlockingFlock(opSeatFlockPath(root));
    expect(after).not.toBeNull();
    after!();
    let heldDuringReject = false;
    await expect(runUnattendedRelease({ version: '0.2.4' }, { ...deps, checklist: () => {
      heldDuringReject = tryNonBlockingFlock(opSeatFlockPath(root)) === null;
      return { ok: false, red: ['K13'], undecided: [], blocked: [], moved: [], knownIssues: [] };
    } })).rejects.toThrow('K13');
    expect(heldDuringReject).toBe(true);
    const afterReject = tryNonBlockingFlock(opSeatFlockPath(root));
    expect(afterReject).not.toBeNull();
    afterReject!();
  } finally {
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dry run neither creates nor needs the OP-seat lock: an unusable lock path does not fail the preview', async () => {
  const seatRoot = mkdtempSync(join(tmpdir(), 'unattended-dry-seat-'));
  const ledger = mkdtempSync(join(tmpdir(), 'unattended-dry-ledger-'));
  setElanousConfigDir(seatRoot);
  try {
    record(ledger, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    // A directory where the lock file belongs: any acquisition attempt would fail.
    mkdirSync(opSeatFlockPath(), { recursive: true });
    let graphCalls = 0;
    const preview = await runUnattendedRelease({ version: '0.2.4', dryRun: true }, { ledgerRoot: ledger, config: { gatePodPool: 'pool' },
      graph: async () => { graphCalls++; return { status: 'done' } as never; } });
    expect(preview).toMatchObject({ dryRun: true, input: { version: '0.2.4', previousVersion: '0.2.3' } });
    expect(graphCalls).toBe(0);
    expect(existsSync(join(ledger, 'steward'))).toBe(false);
    // The same unusable lock refuses a real run before any graph mutation.
    await expect(runUnattendedRelease({ version: '0.2.4' }, { ledgerRoot: ledger, config: { gatePodPool: 'pool' },
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
      graph: async () => { graphCalls++; return { status: 'done' } as never; } })).rejects.toThrow();
    expect(graphCalls).toBe(0);
  } finally {
    resetElanousConfigDir();
    rmSync(seatRoot, { recursive: true, force: true });
    rmSync(ledger, { recursive: true, force: true });
  }
});

test('an injected ledger root different from the OP-seat root still locks the one shared OP-seat lock file', async () => {
  const seatRoot = mkdtempSync(join(tmpdir(), 'unattended-seat-'));
  const ledger = mkdtempSync(join(tmpdir(), 'unattended-ledger-'));
  setElanousConfigDir(seatRoot);
  try {
    record(ledger, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    let sharedHeld = false;
    const run = await runUnattendedRelease({ version: '0.2.4' }, { ledgerRoot: ledger, assertCliCurrent: () => {}, config: { gatePodPool: 'pool' },
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
      graph: async () => {
        sharedHeld = tryNonBlockingFlock(opSeatFlockPath()) === null;
        return { status: 'done' } as never;
      } });
    expect(run).toMatchObject({ dryRun: false, state: { status: 'done' } });
    expect(sharedHeld).toBe(true);
    expect(opSeatFlockPath()).toBe(join(seatRoot, 'steward', 'op-seat.flock'));
    expect(existsSync(join(ledger, 'steward', 'op-seat.flock'))).toBe(false);
  } finally {
    resetElanousConfigDir();
    rmSync(seatRoot, { recursive: true, force: true });
    rmSync(ledger, { recursive: true, force: true });
  }
});
