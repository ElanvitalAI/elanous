import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReleaseRunInput, latestPublishedPreviousVersion, runUnattendedRelease } from './unattended-release.js';
import { parseOptions } from './gate-node.js';
import { enableLandingFreeze, disableLandingFreeze } from '../../src/release-loop/landing-freeze.js';

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

test('release.loop config builds the full graph input with ledger previousVersion', () => fixture((root) => {
  record(root, '0.10.0', { version: '0.10.0', publishedAt: 'now' });
  const configPath = join(root, 'config.json');
  const loop = { gatePodPool: 'gate-pool', gatePodBunCache: '/var/cache/elanous-bun', gatePodShards: 4, gatePodShardTimeoutSeconds: 240,
    gateRemote: 'node-b', gateRemoteMirror: '/mirror/repo.git', opsHosts: ['local', 'node-b'], internalDist: '~/dist', opsRestart: true };
  writeFileSync(configPath, JSON.stringify({ release: { loop } }));
  expect(buildReleaseRunInput('0.11.0', { ledgerRoot: root, configPath })).toEqual({ version: '0.11.0', previousVersion: '0.10.0', ...loop });
}));

test('freeze stops gate and publish graph; force-freeze records bypass and off resumes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-freeze-'));
  try {
    enableLandingFreeze({ reason: 'drill', by: 'MK' }, root);
    record(root, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    let gates = 0;
    let published = 0;
    const deps = { freezeRoot: root, ledgerRoot: root, config: { gatePodPool: 'pool' },
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

test('dry run reports input but never invokes the checklist or graph; execution enforces both', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unattended-release-'));
  try {
    record(root, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    let graphCalls = 0;
    let checklistCalls = 0;
    const pins: unknown[] = [];
    const deps = { ledgerRoot: root, config: { gatePodPool: 'pool' },
      checklist: () => { checklistCalls++; return { ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }; },
      graph: async (_path: string, options: { input: unknown; pinChildUniverse?: boolean; deps?: { root?: string } }) => { graphCalls++; pins.push([options.pinChildUniverse, options.deps?.root]); return { input: options.input, status: 'done' } as never; } };
    const preview = await runUnattendedRelease({ version: '0.2.4', dryRun: true }, deps);
    expect(preview).toMatchObject({ dryRun: true, input: { version: '0.2.4', previousVersion: '0.2.3', gatePodPool: 'pool' } });
    expect([checklistCalls, graphCalls]).toEqual([0, 0]);
    const run = await runUnattendedRelease({ version: '0.2.4' }, deps);
    expect(run).toMatchObject({ dryRun: false, state: { status: 'done', input: preview.input } });
    expect([checklistCalls, graphCalls]).toEqual([1, 1]);
    // RELEASE-LEDGER-UNIVERSE: every node subprocess is pinned to the run's universe, not re-resolved from its cwd tree.
    expect(pins).toEqual([[true, root]]);
    await expect(runUnattendedRelease({ version: '0.2.4' }, { ...deps, checklist: () => ({ ok: false, red: ['K13'], undecided: [], blocked: [], moved: [], knownIssues: [] }) })).rejects.toThrow('K13');
    expect(graphCalls).toBe(1);
    for (const invalid of [{}, { gatePodPool: '  ' }]) {
      await expect(runUnattendedRelease({ version: '0.2.4' }, { ...deps, config: invalid })).rejects.toThrow('release.loop.gatePodPool');
    }
    expect(graphCalls).toBe(1);
    await expect(runUnattendedRelease({ version: '0.2.4', dryRun: true }, { ...deps, config: {} })).rejects.toThrow('release.loop.gatePodPool');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RELEASE-BRANCH: the default run cuts a release branch; --cut-commit and --main-cut keep the main path; a freeze stays the emergency stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-branch-'));
  try {
    record(root, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    const inputs: unknown[] = [];
    const deps = { freezeRoot: root, ledgerRoot: root, config: { gatePodPool: 'pool' },
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
      graph: async (_p: string, o: { input: unknown }) => { inputs.push(o.input); return { status: 'done' } as never; } };
    await runUnattendedRelease({ version: '0.2.4' }, deps);
    await runUnattendedRelease({ version: '0.2.4', cutCommit: 'abc1234' }, deps);
    await runUnattendedRelease({ version: '0.2.4', mainCut: true }, deps);
    expect(inputs).toEqual([
      { gatePodPool: 'pool', version: '0.2.4', previousVersion: '0.2.3', branchCut: true },
      { gatePodPool: 'pool', version: '0.2.4', previousVersion: '0.2.3', cutCommit: 'abc1234' },
      { gatePodPool: 'pool', version: '0.2.4', previousVersion: '0.2.3' },
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
    const deps = { ledgerRoot: root, config: { gatePodPool: 'pool' },
      releaseRefs: (base: string, kind: string) => { asked.push(`${base}/${kind}`); return ['refs/heads/release/0.2.18-rc.0', 'refs/tags/v0.2.18-rc.1', 'refs/tags/v0.2.18-rc.1^{}', 'refs/heads/release/0.2.18-rc.x', 'refs/heads/release/0.2.19-rc.7']; },
      checklist: () => { checklists++; return { ok: false, red: ['K1'], undecided: [], blocked: [], moved: [], knownIssues: [] }; },
      graph: async (_p: string, o: { input: unknown }) => { inputs.push(o.input as Record<string, unknown>); return { status: 'done' } as never; } };
    const preview = await runUnattendedRelease({ version: '0.2.18', prerelease: 'rc', dryRun: true }, deps);
    expect(preview.input).toEqual({ gatePodPool: 'pool', version: '0.2.18-rc.2', previousVersion: '0.2.17', branchCut: true });
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
  const input = buildReleaseRunInput('0.2.99', { ledgerRoot: root, config: { gatePodPool: 'pool-x@h:1', gatePodAdmissionWaitSeconds: 45 } });
  expect(input).toMatchObject({ gatePodPool: 'pool-x@h:1', gatePodAdmissionWaitSeconds: 45 });
  const context = join(root, 'graph-context.json');
  writeFileSync(context, JSON.stringify({ input, outputs: {} }));
  const opts = parseOptions(['--json'], { ELANOUS_GRAPH_CONTEXT: context });
  if (opts === 'help') throw new Error('unexpected help');
  expect(opts.pod).toMatchObject({ pool: 'pool-x@h:1', admissionWaitSeconds: 45 });
  // Omitted config: no bound reaches the gate, which then uses GATE_ADMISSION_WAIT_SECONDS_DEFAULT.
  writeFileSync(context, JSON.stringify({ input: buildReleaseRunInput('0.2.99', { ledgerRoot: root, config: { gatePodPool: 'pool-x@h:1' } }), outputs: {} }));
  const plain = parseOptions(['--json'], { ELANOUS_GRAPH_CONTEXT: context });
  if (plain === 'help') throw new Error('unexpected help');
  expect(plain.pod?.admissionWaitSeconds).toBeUndefined();
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
