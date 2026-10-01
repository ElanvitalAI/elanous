import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReleaseRunInput, latestPublishedPreviousVersion, runUnattendedRelease } from './unattended-release.js';

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

test('dry run reports input but never invokes the checklist or graph; execution enforces both', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unattended-release-'));
  try {
    record(root, '0.2.3', { version: '0.2.3', publishedAt: 'now' });
    let graphCalls = 0;
    let checklistCalls = 0;
    const deps = { ledgerRoot: root, config: { gatePodPool: 'pool' },
      checklist: () => { checklistCalls++; return { ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }; },
      graph: async (_path: string, options: { input: unknown }) => { graphCalls++; return { input: options.input, status: 'done' } as never; } };
    const preview = await runUnattendedRelease({ version: '0.2.4', dryRun: true }, deps);
    expect(preview).toMatchObject({ dryRun: true, input: { version: '0.2.4', previousVersion: '0.2.3', gatePodPool: 'pool' } });
    expect([checklistCalls, graphCalls]).toEqual([0, 0]);
    const run = await runUnattendedRelease({ version: '0.2.4' }, deps);
    expect(run).toMatchObject({ dryRun: false, state: { status: 'done', input: preview.input } });
    expect([checklistCalls, graphCalls]).toEqual([1, 1]);
    await expect(runUnattendedRelease({ version: '0.2.4' }, { ...deps, checklist: () => ({ ok: false, red: ['K13'], undecided: [], blocked: [], moved: [], knownIssues: [] }) })).rejects.toThrow('K13');
    expect(graphCalls).toBe(1);
    for (const invalid of [{}, { gatePodPool: '  ' }]) {
      await expect(runUnattendedRelease({ version: '0.2.4' }, { ...deps, config: invalid })).rejects.toThrow('release.loop.gatePodPool');
    }
    expect(graphCalls).toBe(1);
    await expect(runUnattendedRelease({ version: '0.2.4', dryRun: true }, { ...deps, config: {} })).rejects.toThrow('release.loop.gatePodPool');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
