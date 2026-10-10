import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCapabilityIndex, listLocalSkills, readLocalPlugins, readLocalSkills, type CapabilityIndexReaders } from './capability-index.js';
import { readClaudePackageLedger } from '../plugins/adapters/claude-package.js';
import type { MarketplaceIndex } from '../market/signed-index.js';
import type { SkillIndexEntry } from '../skills/index.js';
import type { ClaudeInstalledPackage } from '../plugins/adapters/claude-package.js';

const market: MarketplaceIndex = {
  name: 'elanous', interface: { displayName: 'Official' }, sequence: 1,
  plugins: [{ name: 'pdfsift', version: '1.0.0', source: { source: 'git-subdir' },
    artifact: { key: 'pdf.tgz', sha256: '0'.repeat(64), bytes: 0 },
    'ai.elanous': { capabilities: ['pdf text'], connectors: [{ id: 'pdf-api', kind: 'mcp', userConfig: [{ key: 'token', label: 'Token', secret: true }] }], pricing: { model: 'free' } },
  }, { name: 'paid-tool', version: '1.0.0', source: { source: 'url' }, policy: { installation: 'manual', authentication: 'api-key' },
    artifact: { key: 'paid.tgz', sha256: '0'.repeat(64), bytes: 0 },
    'ai.elanous': { capabilities: ['paid'], connectors: [], pricing: { model: 'subscription' } },
  }, { name: 'purchase-tool', version: '1.0.0', source: { source: 'url' }, policy: { installation: 'manual', authentication: 'paid' },
    artifact: { key: 'purchase.tgz', sha256: '0'.repeat(64), bytes: 0 },
    'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'one-time' } },
  }], knowledgePacks: [{ name: 'public-pack', version: '1.0.0', visibility: 'public', artifact: { key: 'pub', bytes: 0, sha256: '0'.repeat(64) } },
    { name: 'private-pack', version: '1.0.0', visibility: 'internal', enterpriseId: 'private', artifact: { key: 'priv', bytes: 0, sha256: '0'.repeat(64) } }],
};
const readers: CapabilityIndexReaders = {
  skills: () => [{ name: 'omni-crawl', rootDir: '/skills' } as SkillIndexEntry], skillProblems: () => [],
  plugins: () => [{ name: 'pdfsift', market: 'elanous' }], knowledge: () => [{ name: 'course@1', provenance: '/kgs.db' }],
  codex: async () => ({ status: 'ok', plugins: [{ name: 'codex-tool', marketplace: 'curated', enabled: true }] }),
  claude: () => ({ status: 'ok', packages: [{ plugin: 'claude-tool', marketplace: 'claude-market', source: 'github:owner/repo' } as ClaudeInstalledPackage] }),
  market: async () => market, matrix: () => [{ backend: 'codex', service: 'github', state: 'ready' }],
};

describe('read-only capability index', () => {
  test('combines six independently attributed inventories and classifies observed auth, never credential values', async () => {
    const result = await buildCapabilityIndex(readers);
    expect(Object.values(result.sources)).toEqual(Array(6).fill('ok'));
    expect(result.entries.map(row => row.source)).toEqual(['skills', 'plugins', 'knowledge', 'codex', 'claude', 'market', 'market', 'market', 'market', 'market', 'codex']);
    expect(result.entries.find(row => row.id === 'omni-crawl')).toMatchObject({ provenance: '/skills', auth: 'unknown', state: 'installed' });
    expect(result.entries.find(row => row.id === 'course@1')).toMatchObject({ provenance: '/kgs.db', auth: 'unknown', state: 'installed' });
    expect(result.entries.find(row => row.id === 'pdfsift' && row.source === 'plugins')).toMatchObject({ provenance: 'elanous', auth: 'unknown', state: 'installed' });
    expect(result.entries.find(row => row.id === 'pdfsift' && row.source === 'market')).toMatchObject({ provenance: 'elanous:git-subdir', auth: 'unknown', state: 'installed', capabilities: ['pdfsift', 'pdf text'] });
    expect(result.entries.find(row => row.id === 'pdf-api')).toMatchObject({ auth: 'unknown', state: 'candidate' });
    expect(result.entries.find(row => row.id === 'paid-tool')).toMatchObject({ auth: 'api-key' });
    expect(result.entries.find(row => row.id === 'purchase-tool')).toMatchObject({ auth: 'paid' });
    const subscription = await buildCapabilityIndex({ ...readers, verifiedMarket: { ...market, plugins: [{ ...market.plugins[0]!,
      policy: { installation: 'manual', authentication: 'subscription' },
    }] } });
    expect(subscription.entries.find(row => row.id === 'pdfsift' && row.source === 'market')?.auth).toBe('subscription');
    const oauth = await buildCapabilityIndex({ ...readers, verifiedMarket: { ...market, plugins: [{ ...market.plugins[0]!,
      policy: { installation: 'manual', authentication: 'oauth' },
    }] } });
    expect(oauth.entries.find(row => row.id === 'pdfsift' && row.source === 'market')?.auth).toBe('unknown');
    const freeAuth = await buildCapabilityIndex({ ...readers, verifiedMarket: { ...market, plugins: [{ ...market.plugins[0]!,
      policy: { installation: 'manual', authentication: 'none' },
    }] } });
    expect(freeAuth.entries.find(row => row.id === 'pdfsift' && row.source === 'market')?.auth).toBe('free');
    expect(result.entries.find(row => row.id === 'codex-tool')).toMatchObject({ auth: 'unknown', provenance: 'curated' });
    expect(result.entries.find(row => row.id === 'claude-tool')).toMatchObject({ auth: 'unknown', provenance: 'claude-market:github:owner/repo' });
    expect(result.entries.find(row => row.id === 'github')).toMatchObject({ auth: 'unknown', state: 'ready' });
    expect(result.entries.find(row => row.id === 'public-pack')).toMatchObject({ source: 'market', auth: 'unknown', state: 'candidate' });
    expect(result.entries.map(row => row.id)).not.toContain('private-pack');
    expect(JSON.stringify(result)).not.toContain('Token');
  });

  test('each unreadable source is unknown while other source candidates survive', async () => {
    const result = await buildCapabilityIndex({ ...readers,
      skills: () => { throw new Error('no skill root'); },
      plugins: () => { throw new Error('no ledger'); },
      knowledge: () => { throw new Error('no database'); },
      codex: async () => ({ status: 'unknown', plugins: [] }),
      claude: () => ({ status: 'known-marketplaces-unreadable', packages: [] }),
      market: async () => { throw new Error('bad signature'); }, matrix: () => [],
    });
    expect(result.sources).toEqual({ skills: 'unknown', plugins: 'unknown', knowledge: 'unknown', codex: 'unknown', claude: 'unknown', market: 'unknown' });
    expect(result.entries).toEqual([]);
    const partial = await buildCapabilityIndex({ ...readers, plugins: () => { throw new Error('ledger'); } });
    expect(partial.entries.find(row => row.id === 'pdfsift' && row.source === 'market')?.state).toBe('unknown');
    expect(partial.entries.find(row => row.id === 'omni-crawl')?.state).toBe('installed');
    const skipped = await buildCapabilityIndex({ ...readers, skillProblems: () => [{ name: 'broken', dir: '/skills' }] });
    expect(skipped.sources.skills).toBe('unknown');
    expect(skipped.entries.find(row => row.id === 'broken')).toMatchObject({ state: 'unknown', provenance: '/skills' });
  });

  test('preserves installed Claude candidates while marketplace metadata is unreadable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'capability-claude-'));
    try {
      writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({ plugins: {
        'existing@offline-market': [{ installPath: '/local/existing', scope: 'user' }],
      } }));
      const result = await buildCapabilityIndex({ ...readers, claude: () => readClaudePackageLedger({ pluginsRoot: root }) });
      expect(result.sources.claude).toBe('unknown');
      expect(result.entries.find(row => row.id === 'existing' && row.source === 'claude')).toMatchObject({
        provenance: 'offline-market:없다', state: 'installed', auth: 'unknown',
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('distinguishes absent skill roots from unreadable root metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'capability-skills-'));
    try {
      const absent = join(root, 'absent');
      const inaccessible = join(root, 'inaccessible');
      symlinkSync(join(root, 'loop'), join(root, 'loop'));
      symlinkSync(join(root, 'loop'), inaccessible);
      expect(existsSync(inaccessible)).toBe(false);
      expect(listLocalSkills([absent])).toEqual([]);
      expect(() => listLocalSkills([inaccessible])).toThrow();
      const result = await buildCapabilityIndex({ ...readers, skills: () => listLocalSkills([inaccessible]) });
      expect(result.sources.skills).toBe('unknown');
      expect(result.entries.filter(row => row.source === 'skills')).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('one unreadable skill root keeps the readable roots\' candidates and marks skills unknown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'capability-skill-roots-'));
    try {
      const good = join(root, 'good');
      mkdirSync(join(good, 'alpha'), { recursive: true });
      writeFileSync(join(good, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: alpha skill\n---\nbody\n');
      const inaccessible = join(root, 'inaccessible');
      symlinkSync(join(root, 'loop'), join(root, 'loop'));
      symlinkSync(join(root, 'loop'), inaccessible);
      const observed = readLocalSkills([inaccessible, good]);
      expect(observed.unreadableRoots).toEqual([inaccessible]);
      expect(observed.entries.map(row => row.name)).toEqual(['alpha']);
      const { skills: _injected, ...rest } = readers;
      const result = await buildCapabilityIndex({ ...rest, localSkills: () => readLocalSkills([inaccessible, good]) });
      expect(result.sources.skills).toBe('unknown');
      expect(result.entries.find(row => row.id === 'alpha')).toMatchObject({ source: 'skills', provenance: good, state: 'installed' });
      expect(result.entries.find(row => row.id === inaccessible)).toMatchObject({ source: 'skills', state: 'unknown' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('plugin inventory distinguishes absent paths from unreadable ones and keeps readable rows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'capability-plugins-'));
    try {
      const ledger = join(root, 'installed.json');
      writeFileSync(ledger, JSON.stringify([{ name: 'pdfsift', market: 'elanous' }]));
      const absentDir = join(root, 'absent-plugins');
      const inaccessible = join(root, 'inaccessible');
      symlinkSync(join(root, 'loop'), join(root, 'loop'));
      symlinkSync(join(root, 'loop'), inaccessible);
      expect(existsSync(inaccessible)).toBe(false);
      expect(readLocalPlugins(ledger, [absentDir])).toEqual({ plugins: [{ name: 'pdfsift', market: 'elanous' }], ledger: 'ok', unreadableDirs: [] });
      const observed = readLocalPlugins(ledger, [inaccessible]);
      expect(observed.unreadableDirs).toEqual([inaccessible]);
      expect(observed.plugins).toEqual([{ name: 'pdfsift', market: 'elanous' }]);
      expect(readLocalPlugins(inaccessible, []).ledger).toBe('unreadable');
      expect(readLocalPlugins(join(root, 'none.json'), []).ledger).toBe('absent');
      const { plugins: _injected, ...rest } = readers;
      const result = await buildCapabilityIndex({ ...rest, localPlugins: () => readLocalPlugins(ledger, [inaccessible]) });
      expect(result.sources.plugins).toBe('unknown');
      expect(result.entries.find(row => row.id === 'pdfsift' && row.source === 'plugins')).toMatchObject({ state: 'installed', provenance: 'elanous' });
      expect(result.entries.find(row => row.id === inaccessible)).toMatchObject({ source: 'plugins', state: 'unknown' });
      // A plugin dir whose manifest cannot be stat'ed (ELOOP) is unreadable, not "no candidate".
      const pluginsDir = join(root, 'local-plugins');
      mkdirSync(join(pluginsDir, 'broken'), { recursive: true });
      symlinkSync(join(root, 'loop'), join(pluginsDir, 'broken', 'plugin.ts'));
      mkdirSync(join(pluginsDir, 'fine'));
      writeFileSync(join(pluginsDir, 'fine', 'plugin.json'), '{}');
      mkdirSync(join(pluginsDir, 'dir-manifest', 'plugin.json'), { recursive: true });
      const manifestUnreadable = readLocalPlugins(join(root, 'none.json'), [pluginsDir]);
      expect(manifestUnreadable.unreadableDirs).toEqual([join(pluginsDir, 'broken')]);
      expect(manifestUnreadable.plugins).toEqual([{ name: 'fine', market: pluginsDir }]);
      const clean = await buildCapabilityIndex({ ...rest, localPlugins: () => readLocalPlugins(ledger, [absentDir]) });
      expect(clean.sources.plugins).toBe('ok');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('matrix services are attributed only to their own backend source; grok is not relabelled as codex', async () => {
    const result = await buildCapabilityIndex({ ...readers, matrix: () => [
      { backend: 'codex', service: 'github', state: 'ready' }, { backend: 'claude', service: 'slack', state: 'ready' },
      { backend: 'grok', service: 'x-search', state: 'ready' }] });
    expect(result.entries.find(row => row.id === 'github')?.source).toBe('codex');
    expect(result.entries.find(row => row.id === 'slack')?.source).toBe('claude');
    expect(result.entries.map(row => row.id)).not.toContain('x-search');
  });
});
