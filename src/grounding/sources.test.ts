import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig, saveUserConfig, userConfigPath } from '../user-config.js';
import {
  addGroundingSource,
  discoverReferenceSources,
  GroundingSourceError,
  listGroundingSources,
  removeGroundingSource,
  sourceStatus,
  type GroundingSource,
} from './sources.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('grounding sources', () => {
  test('discover yields two candidates, rejects duplicate id and missing path, and reports dirtiness', () => {
    const home = mkdtempSync(join(tmpdir(), 'grounding-sources-'));
    try {
      const alpha = join(home, 'source', 'ref', 'alpha');
      const beta = join(home, 'docs', 'ref', 'beta');
      mkdirSync(alpha, { recursive: true });
      mkdirSync(beta, { recursive: true });
      git(alpha, ['init', '-b', 'main']);
      git(alpha, ['config', 'user.email', 'sources@example.test']);
      git(alpha, ['config', 'user.name', 'sources']);
      writeFileSync(join(alpha, 'README'), 'alpha\n');
      git(alpha, ['add', 'README']);
      git(alpha, ['commit', '-m', 'init']);

      const discovered = discoverReferenceSources(home);
      expect(discovered).toHaveLength(2);
      expect(discovered.map((item) => ({ id: item.id, kind: item.kind }))).toEqual([
        { id: 'alpha', kind: 'local-repo' },
        { id: 'beta', kind: 'local-docs' },
      ]);

      let config: { grounding?: { sources?: GroundingSource[] } } = {};
      config = addGroundingSource(config, discovered[0]!);
      config = addGroundingSource(config, discovered[1]!);
      expect(listGroundingSources(config).map((item) => item.id)).toEqual(['alpha', 'beta']);
      expect(config.grounding?.sources).toHaveLength(2);

      expect(() => addGroundingSource(config, discovered[0]!)).toThrow(GroundingSourceError);
      expect(() => addGroundingSource(config, {
        id: 'missing',
        kind: 'local-repo',
        path: join(home, 'source', 'ref', 'nope'),
      })).toThrow(/missing path/);

      const clean = sourceStatus(listGroundingSources(config)[0]!);
      expect(clean.dirty).toBe(false);
      expect(clean.branch).toBe('main');
      expect(typeof clean.lastCommitAt).toBe('string');

      writeFileSync(join(alpha, 'dirty.txt'), 'changed\n');
      const dirty = sourceStatus(listGroundingSources(config)[0]!);
      expect(dirty.dirty).toBe(true);

      config = removeGroundingSource(config, 'alpha');
      expect(listGroundingSources(config).map((item) => item.id)).toEqual(['beta']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('grounding.sources config parse', () => {
  test('valid entries round-trip, each sync form is accepted, invalid entries are skipped, and an explicit config directory does not modify the default path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grounding-sources-cfg-'));
    const configPath = join(dir, 'config.json');
    const beforeDefault = userConfigPath();
    let defaultBytes: string | undefined;
    try { defaultBytes = readFileSync(beforeDefault, 'utf8'); } catch { defaultBytes = undefined; }
    try {
      writeFileSync(configPath, JSON.stringify({
        grounding: {
          sources: [
            { id: 'alpha', kind: 'local-repo', path: '/tmp/alpha', sync: 'manual', tags: ['ref'] },
            { id: 'daily', kind: 'web', url: 'https://example.test/daily', sync: 'daily' },
            { id: 'fresh', kind: 'url', url: 'https://example.test/fresh', sync: { beforeUse: { maxAgeHours: 6 } } },
            { id: 'bad-kind', kind: 'nope', path: '/tmp/x', sync: 'manual' },
            { id: '', kind: 'local-docs', path: '/tmp/empty', sync: 'manual' },
            { kind: 'local-docs', path: '/tmp/noid', sync: 'manual' },
            'not-an-object',
          ],
        },
        llm: { provider: 'auto' },
      }));
      const loaded = buildUserConfig(configPath);
      expect(loaded.grounding?.sources?.map((item) => item.id)).toEqual(['alpha', 'daily', 'fresh']);
      expect(loaded.grounding?.sources?.[0]).toEqual({
        id: 'alpha', kind: 'local-repo', path: '/tmp/alpha', sync: 'manual', tags: ['ref'],
      });
      expect(loaded.grounding?.sources?.[1]?.sync).toBe('daily');
      expect(loaded.grounding?.sources?.[2]?.sync).toEqual({ beforeUse: { maxAgeHours: 6 } });

      saveUserConfig(loaded, configPath);
      const again = buildUserConfig(configPath);
      expect(again.grounding?.sources).toEqual(loaded.grounding?.sources);
      expect(userConfigPath()).toBe(beforeDefault);
      let afterDefault: string | undefined;
      try { afterDefault = readFileSync(beforeDefault, 'utf8'); } catch { afterDefault = undefined; }
      expect(afterDefault).toBe(defaultBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
