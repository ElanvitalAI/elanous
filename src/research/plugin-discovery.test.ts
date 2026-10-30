import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MarketIndex } from '../plugins/install/market-fetch.js';
import { installPlugin } from '../plugins/install/plugin-install.js';
import { discoverResearchPlugin, rerunInstalledPluginResearch } from './plugin-discovery.js';

function signedMarket(): MarketIndex {
  return {
    market: { name: 'elanous', url: 'https://example.test/signed/' }, signature: 'ok',
    index: { name: 'elanous', interface: { displayName: 'Elanous' }, sequence: 1, plugins: [{
      name: 'premium-data', version: '1.0.0', description: 'period premium data series',
      source: { source: 'local' }, artifact: { key: 'premium.tgz', sha256: 'a'.repeat(64), bytes: 1 },
      'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'free' } },
    }] },
    directory: '/tmp/signed-market', keyId: '12345678',
  };
}

test('a verified, unique market package installs and reports reason, permissions and undo', async () => {
  const specs: string[] = [];
  const result = await discoverResearchPlugin('period premium data', {
    market: async () => signedMarket(), search: async () => [],
    install: async (spec) => {
      specs.push(spec);
      return { name: 'premium-data', version: '1.0.0', market: 'elanous', path: '/isolated/premium-data', sha256: 'a'.repeat(64) };
    },
  });
  expect(specs).toEqual(['premium-data@elanous']);
  expect(result.outcome).toBe('installed');
  expect(result.card).toContain('Reason: missing research capability period premium data');
  expect(result.card).toContain('permissions: none declared');
  expect(result.card).toContain('Undo: eln plugin remove premium-data');
});

test('a high-star GitHub result remains proposal-only without a verified install package', async () => {
  let installed = false;
  const result = await discoverResearchPlugin('period premium data', {
    market: async () => { throw new Error('offline'); },
    search: async () => [{ url: 'https://github.com/acme/premium-data', title: 'premium data',
      snippet: 'period premium data skill', source: 'web' }],
    githubPackage: async () => ({ stars: 4_000 }), githubStarThreshold: 1_000,
    install: async () => { installed = true; throw new Error('must not install'); },
  });
  expect(installed).toBe(false);
  expect(result.outcome).toBe('proposed');
  expect(result.candidates[0]?.trusted).toBe(true);
  expect(result.candidates[0]?.installSpec).toBeUndefined();
  expect(result.card).toContain('stars: 4000');
});

test('a high-star GitHub package with a verified root manifest and pinned SHA installs', async () => {
  const specs: string[] = [];
  const result = await discoverResearchPlugin('period premium data', {
    market: async () => { throw new Error('offline'); },
    search: async () => [{ url: 'https://github.com/acme/premium-data', title: 'premium data',
      snippet: 'period premium data skill', source: 'web' }],
    githubPackage: async () => ({ stars: 4_000, sha: 'a'.repeat(40), license: 'MIT', permissions: [] }),
    githubStarThreshold: 1_000,
    install: async (spec) => {
      specs.push(spec);
      return { name: 'premium-data', version: '1.0.0', market: 'local', path: '/isolated/premium-data', sha256: null };
    },
  });
  expect(specs).toEqual([`https://github.com/acme/premium-data.git#${'a'.repeat(40)}`]);
  expect(result.outcome).toBe('installed');
  expect(result.card).toContain('license: MIT');
});

test('the real installer accepts a pinned git package with no capabilities and denies capability-bearing packages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-discovery-git-'));
  const source = join(root, 'source');
  const remote = join(root, 'plugin.git');
  const git = (args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  try {
    mkdirSync(source);
    git(['init', '-q']);
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'research-pack', version: '1.0.0', main: './plugin.ts', capabilities: [] }));
    writeFileSync(join(source, 'plugin.ts'), 'export default {};\n');
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);
    const sha = git(['rev-parse', 'HEAD']);
    execFileSync('git', ['clone', '-q', '--bare', source, remote]);
    const installed = await installPlugin(`${remote}#${sha}`, { root: join(root, 'state'),
      consent: () => false, allowUnsigned: false });
    expect(installed.name).toBe('research-pack');
    expect(installed.market).toBe('local');
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'research-pack', version: '1.0.1', main: './plugin.ts', capabilities: ['network'] }));
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'capability']);
    const deniedSha = git(['rev-parse', 'HEAD']);
    git(['push', '-q', remote, 'HEAD:refs/heads/master']);
    await expect(installPlugin(`${remote}#${deniedSha}`, { root: join(root, 'denied'),
      consent: () => false, allowUnsigned: false })).rejects.toMatchObject({ reason: 'consent-denied' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('untrusted hits are proposals, and an empty search suggests a draft', async () => {
  const deps = { market: async () => { throw new Error('offline'); } };
  const proposal = await discoverResearchPlugin('period premium data', {
    ...deps, search: async () => [{ url: 'https://example.test/premium', title: 'premium data',
      snippet: 'period premium data skill', source: 'web' }],
  });
  expect(proposal.outcome).toBe('proposed');
  expect(proposal.card).toContain('proposal only');
  const missing = await discoverResearchPlugin('period premium data', { ...deps, search: async () => [] });
  expect(missing.outcome).toBe('create-suggestion');
  expect(missing.card).toContain('creating a skill or plugin draft');
});

test('credential-like gap text never reaches external discovery', async () => {
  let calls = 0;
  const result = await discoverResearchPlugin('period premium data token=sk-secret123', {
    market: async () => { calls++; throw new Error('unexpected'); },
    search: async () => { calls++; return []; },
  });
  expect(result.outcome).toBe('invalid-gap');
  expect(calls).toBe(0);
  expect(result.card).not.toContain('sk-secret123');
});

test('records bounded stage and total latency without changing discovery output', async () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const result = await discoverResearchPlugin('period premium data', {
    market: async () => { throw new Error('offline'); },
    search: async () => [{ url: 'https://example.test/premium', title: 'premium data',
      snippet: 'period premium data skill', source: 'web' }],
    log: (event, data) => { events.push([event, data]); },
  });
  expect(result.outcome).toBe('proposed');
  expect(events[0]?.[0]).toBe('started');
  expect(events.filter(([event]) => event === 'stage-complete').map(([, data]) => data.stage))
    .toEqual(['signed-market', 'capability-search']);
  for (const [event, data] of events.filter(([event]) => event === 'stage-complete' || event === 'completed')) {
    expect(data.elapsedMs).toEqual(expect.any(Number));
  }
  expect(events.at(-1)?.[0]).toBe('completed');
  expect(events.at(-1)?.[1]).toMatchObject({ outcome: 'proposed', candidateCount: 1, installed: false });
});

test('expired discovery budget prevents a late search result from installing', async () => {
  const controller = new AbortController();
  let installed = false;
  const result = await discoverResearchPlugin('period premium data', {
    signal: controller.signal,
    market: async () => signedMarket(),
    search: async () => { controller.abort(); return []; },
    install: async () => { installed = true; throw new Error('must not install'); },
  });
  expect(installed).toBe(false);
  expect(result.card).toContain('time budget exhausted');
});

test('an installed skill with write effects is never run for automatic re-research', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-discovery-test-'));
  try {
    const skill = join(root, 'skills', 'unsafe');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: unsafe\nsideEffects: write\n---\nWrite local files.\n');
    const result = await rerunInstalledPluginResearch('period premium data',
      { name: 'unsafe', path: root, notice: '', undo: '' }, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no unique declared read-only skill');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
