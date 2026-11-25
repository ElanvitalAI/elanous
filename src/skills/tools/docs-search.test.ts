import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDocsSearchTool, dispatchDocsSearch } from './docs-search.js';

// Fixture repo + ref source; expected values are literals.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'docs-search-'));
  const repo = join(base, 'alpha');
  mkdirSync(join(repo, 'docs', 'conductor'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'conductor', 'CAPSULE-TOOLKIT.md'), '# Capsule toolkit\n\nThe zebrafinch rule keeps capsules searching.\n');
  writeFileSync(join(repo, 'docs', 'conductor', 'OTHER.md'), '# Other\n\nnothing here\n');
  const ref = join(base, 'upstream');
  mkdirSync(ref, { recursive: true });
  writeFileSync(join(ref, 'NOTES.md'), '# Notes\n\nzebrafinch appears upstream too.\n');
  const env = { ELANOUS_SOURCES: JSON.stringify([
    { id: 'alpha', type: 'repo', path: repo },
    { id: 'up', type: 'ref', path: ref },
  ]) } as NodeJS.ProcessEnv;
  return { base, repo, ref, env };
}

describe('DocsSearch tool', () => {
  test('spec advertises the scope enum and custom params', () => {
    const spec = buildDocsSearchTool();
    expect(spec.name).toBe('DocsSearch');
    const props = (spec.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.scope!.enum).toEqual(['repo', 'ref', 'both', 'custom']);
    expect(Object.keys(props).sort()).toEqual(['limit', 'paths', 'query', 'scope', 'source_ids']);
  });

  test('scope repo returns the fixture doc by filename with a repo: citation (index off → fallback)', async () => {
    const f = fixture();
    const r = await dispatchDocsSearch({ query: 'capsule toolkit' }, { sourcesOpts: { env: f.env }, indexSearch: null });
    expect(r.hits[0]!.cite).toBe('repo:alpha/docs/conductor/CAPSULE-TOOLKIT.md');
    expect(r.hits[0]!.via).toBe('fallback');
    expect(r.output).toContain('repo:alpha/docs/conductor/CAPSULE-TOOLKIT.md');
  });

  test('scope both finds repo and ref by content; ref hits cite ref:<id>/', async () => {
    const f = fixture();
    const r = await dispatchDocsSearch({ query: 'zebrafinch', scope: 'both' }, { sourcesOpts: { env: f.env }, indexSearch: null });
    expect(r.hits.map((h) => h.cite).sort()).toEqual(['ref:up/NOTES.md', 'repo:alpha/docs/conductor/CAPSULE-TOOLKIT.md']);
  });

  test('scope ref searches only ref sources', async () => {
    const f = fixture();
    const r = await dispatchDocsSearch({ query: 'zebrafinch', scope: 'ref' }, { sourcesOpts: { env: f.env }, indexSearch: null });
    expect(r.hits.map((h) => h.cite)).toEqual(['ref:up/NOTES.md']);
  });

  test('scope custom takes an explicit path and cites custom1', async () => {
    const f = fixture();
    const r = await dispatchDocsSearch({ query: 'zebrafinch', scope: 'custom', paths: [f.ref] }, { sourcesOpts: { env: f.env }, indexSearch: null });
    expect(r.hits.map((h) => h.cite)).toEqual(['custom:custom1/NOTES.md']);
  });

  test('scope custom with a missing path fails loudly', async () => {
    const f = fixture();
    await expect(dispatchDocsSearch({ query: 'x', scope: 'custom', paths: ['/no/such/zz-dir'] }, { sourcesOpts: { env: f.env }, indexSearch: null }))
      .rejects.toThrow('custom path does not exist: /no/such/zz-dir');
  });

  test('index hits come first; fallback only when the index is weak', async () => {
    const f = fixture();
    const strong = join(f.repo, 'docs', 'conductor', 'OTHER.md');
    const r = await dispatchDocsSearch({ query: 'capsule toolkit' }, {
      sourcesOpts: { env: f.env },
      indexSearch: async () => [{ path: strong, snippet: 'indexed line', matchedBy: 'both' }],
    });
    expect(r.hits).toEqual([{ path: strong, cite: 'repo:alpha/docs/conductor/OTHER.md', snippet: 'indexed line', via: 'index' }]);
  });

  test('nothing configured says so once in the output and searches the auto (cwd) roots', async () => {
    const f = fixture();
    const r = await dispatchDocsSearch({ query: 'capsule toolkit' }, {
      sourcesOpts: { env: {} as NodeJS.ProcessEnv, configRaw: {} },
      indexSearch: null,
      autoRepoRoots: () => [join(f.repo, 'docs')],
    });
    expect(r.output.split('\n')[0]).toBe('no search sources configured (knowledge.sources or ELANOUS_SOURCES / ELANOUS_DOCS_ROOTS / ELANOUS_REF_ROOTS) — searching the cwd tree only');
    expect(r.hits[0]!.path).toBe(join(f.repo, 'docs', 'conductor', 'CAPSULE-TOOLKIT.md'));
  });
});
