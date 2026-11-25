import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { citeSourcePath, loadSearchSources, resolveSearchRoots, resolveSearchSources } from './search-roots.js';

// Expected values are literals — never built from product constants.
const noEnv = {} as NodeJS.ProcessEnv;

describe('search sources — schema normalize', () => {
  test('legacy docsRoots/refRoots become repo/ref objects and are flagged legacy', () => {
    const loaded = loadSearchSources({ env: noEnv, configRaw: { knowledge: { docsRoots: ['/w/latest'], refRoots: ['/w/ref', '/x/ref'] } } });
    expect(loaded.origin).toBe('config');
    expect(loaded.legacy).toBe(true);
    expect(loaded.sources).toEqual([
      { id: 'latest', type: 'repo', path: '/w/latest' },
      { id: 'ref', type: 'ref', path: '/w/ref' },
      { id: 'ref-2', type: 'ref', path: '/x/ref' },
    ]);
  });

  test('knowledge.sources objects are kept; bad entries are reported, not used', () => {
    const loaded = loadSearchSources({ env: noEnv, configRaw: { knowledge: { sources: [
      { id: 'main', type: 'repo', path: '/w/main', label: 'Main', enabled: true },
      { id: 'lib', type: 'ref', path: '/w/lib', exclude: ['dist'] },
      { id: 'bad', type: 'docs', path: '/w/bad' },
      { type: 'ref', path: '/w/noid' },
    ] } } });
    expect(loaded.legacy).toBe(false);
    expect(loaded.sources.map((s) => `${s.type}:${s.id}`)).toEqual(['repo:main', 'ref:lib']);
    expect(loaded.invalid.length).toBe(2);
  });
});

describe('search sources — precedence', () => {
  const config = { knowledge: { sources: [{ id: 'cfg', type: 'repo', path: '/cfg/repo' }] } };

  test('env ELANOUS_SOURCES beats config', () => {
    const env = { ELANOUS_SOURCES: JSON.stringify([{ id: 'envrepo', type: 'repo', path: '/env/repo' }]) } as NodeJS.ProcessEnv;
    const loaded = loadSearchSources({ env, configRaw: config });
    expect(loaded.origin).toBe('env');
    expect(loaded.sources.map((s) => s.id)).toEqual(['envrepo']);
  });

  test('env shortcuts ELANOUS_DOCS_ROOTS / ELANOUS_REF_ROOTS map to repo/ref objects and beat config', () => {
    const env = { ELANOUS_DOCS_ROOTS: '/e/one:/e/two', ELANOUS_REF_ROOTS: '/e/refs' } as NodeJS.ProcessEnv;
    const roots = resolveSearchRoots({ env, configRaw: config, exists: () => false });
    expect(roots.docsSource).toBe('env');
    expect(roots.docsRoots).toEqual(['/e/one', '/e/two']);
    expect(roots.refRoots).toEqual(['/e/refs']);
  });

  test('config used when env is empty', () => {
    const roots = resolveSearchRoots({ env: noEnv, configRaw: config, exists: () => false });
    expect(roots.docsSource).toBe('config');
    expect(roots.docsRoots).toEqual(['/cfg/repo']);
  });

  test('nothing configured = none (cwd only)', () => {
    const roots = resolveSearchRoots({ env: noEnv, configRaw: {}, exists: () => false });
    expect(roots.docsSource).toBe('none');
    expect(roots.docsRoots).toBeUndefined();
    expect(roots.refRoots).toEqual([]);
  });
});

describe('search sources — scope enum', () => {
  const configRaw = { knowledge: { sources: [
    { id: 'a', type: 'repo', path: '/s/a' },
    { id: 'b', type: 'repo', path: '/s/b' },
    { id: 'r1', type: 'ref', path: '/s/r1' },
    { id: 'off', type: 'ref', path: '/s/off', enabled: false },
  ] } };
  const ids = (scope: 'repo' | 'ref' | 'both') => resolveSearchSources({ env: noEnv, configRaw, scope }).map((s) => s.id);

  test('repo · ref · both (disabled sources skipped)', () => {
    expect(ids('repo')).toEqual(['a', 'b']);
    expect(ids('ref')).toEqual(['r1']);
    expect(ids('both')).toEqual(['a', 'b', 'r1']);
  });

  test('custom takes explicit paths (must exist) and source ids (even disabled)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'src-custom-'));
    const got = resolveSearchSources({ env: noEnv, configRaw, scope: 'custom', paths: [dir], sourceIds: ['off'] });
    expect(got).toEqual([
      { id: 'off', type: 'ref', path: '/s/off' },
      { id: 'custom1', type: 'custom', path: dir },
    ]);
  });

  test('custom rejects a missing path, an unknown id, and an empty request', () => {
    expect(() => resolveSearchSources({ env: noEnv, configRaw, scope: 'custom', paths: ['/no/such/dir-zz'] })).toThrow('custom path does not exist: /no/such/dir-zz');
    expect(() => resolveSearchSources({ env: noEnv, configRaw, scope: 'custom', sourceIds: ['nope'] })).toThrow('unknown source id: nope');
    expect(() => resolveSearchSources({ env: noEnv, configRaw, scope: 'custom' })).toThrow('scope custom needs paths or source ids');
  });

  test('an unknown scope is refused', () => {
    expect(() => resolveSearchSources({ env: noEnv, configRaw, scope: 'all' as never })).toThrow('scope must be one of repo|ref|both|custom');
  });
});

describe('search sources — citation prefix', () => {
  test('repo:<id>/<rel> · ref:<id>/<rel> · deepest source wins · outside = absolute', () => {
    const sources = [
      { id: 'main', type: 'repo' as const, path: '/s/main' },
      { id: 'vendored', type: 'ref' as const, path: '/s/main/vendor/lib' },
      { id: 'up', type: 'ref' as const, path: '/s/up' },
    ];
    expect(citeSourcePath('/s/main/docs/A.md', sources)).toBe('repo:main/docs/A.md');
    expect(citeSourcePath('/s/main/vendor/lib/README.md', sources)).toBe('ref:vendored/README.md');
    expect(citeSourcePath('/s/up/x/y.md', sources)).toBe('ref:up/x/y.md');
    expect(citeSourcePath('/elsewhere/z.md', sources)).toBe('/elsewhere/z.md');
  });

  test('latest repo roots = repo sources that are git checkouts', () => {
    const repo = mkdtempSync(join(tmpdir(), 'src-latest-'));
    mkdirSync(join(repo, '.git'));
    const roots = resolveSearchRoots({ env: { ELANOUS_DOCS_ROOTS: repo } as NodeJS.ProcessEnv });
    expect(roots.latestRepoRoots).toEqual([repo]);
  });
});
