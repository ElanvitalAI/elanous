import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReadOnlySearchCatalog, searchToolkitNames, setAstGrepProbeForTesting, withSearchToolkit } from './search-toolkit.js';
import { buildCliAgentTools } from '../cli/agent-cli.js';
import { applyToolProfile, parseToolProfile } from './tool-profile.js';

// Expected tool names are literals (rule 11) — not read from product constants.
const TOOLKIT_WITH_AST = ['Glob', 'Grep', 'Read', 'ListDir', 'AstGrep', 'DirectiveSearch', 'DocsSearch'];
const TOOLKIT_NO_AST = ['Glob', 'Grep', 'Read', 'ListDir', 'DirectiveSearch', 'DocsSearch'];

afterEach(() => setAstGrepProbeForTesting(null));

describe('search toolkit', () => {
  test('names follow the cached ast-grep probe', () => {
    setAstGrepProbeForTesting(() => true);
    expect(searchToolkitNames()).toEqual(TOOLKIT_WITH_AST);
    setAstGrepProbeForTesting(() => false);
    expect(searchToolkitNames()).toEqual(TOOLKIT_NO_AST);
  });

  test('buildCliAgentTools carries the whole toolkit and the coding profile keeps it', () => {
    setAstGrepProbeForTesting(() => true);
    const cwd = mkdtempSync(join(tmpdir(), 'toolkit-cli-'));
    const cli = buildCliAgentTools(undefined, undefined, cwd);
    const names = cli.specs.map((s) => s.name);
    for (const n of TOOLKIT_WITH_AST) expect(names).toContain(n);
    const coding = applyToolProfile(cli.specs, parseToolProfile('coding')).tools!.map((s) => s.name);
    for (const n of TOOLKIT_WITH_AST) expect(coding).toContain(n);
  });

  test('AstGrep is absent when the binary is missing', () => {
    setAstGrepProbeForTesting(() => false);
    const cli = buildCliAgentTools(undefined, undefined, mkdtempSync(join(tmpdir(), 'toolkit-noast-')));
    const names = cli.specs.map((s) => s.name);
    expect(names).not.toContain('AstGrep');
    expect(names).toContain('DocsSearch');
    expect(names).toContain('DirectiveSearch');
  });

  test('general-purpose definition lists the toolkit', () => {
    const md = readFileSync(join(import.meta.dir, '..', 'agents', 'general-purpose.md'), 'utf8');
    expect(md).toContain('tools: [Bash, Read, Edit, Grep, WebFetch, Glob, ListDir, AstGrep, DirectiveSearch, DocsSearch]');
  });

  test('seat Agent children: missing toolkit tools are added and routed; existing ones untouched', async () => {
    setAstGrepProbeForTesting(() => false);
    const calls: string[] = [];
    const host = [{ name: 'Bash', description: 'b', parameters: {} }, { name: 'Read', description: 'r', parameters: {} }];
    const r = withSearchToolkit(host, async (name) => { calls.push(name); return 'parent'; }, () => '/tmp');
    expect(r.tools.map((t) => t.name)).toEqual(['Bash', 'Read', 'DirectiveSearch', 'DocsSearch']);
    expect(r.added).toEqual(['DirectiveSearch', 'DocsSearch']);
    expect(await r.dispatch!('Read', {})).toBe('parent');
    expect(calls).toEqual(['Read']);
    await expect(r.dispatch!('DocsSearch', {})).rejects.toThrow('query is required');
  });

  test('read-only catalog (fan-out extras) = toolkit only, write tools refused', async () => {
    setAstGrepProbeForTesting(() => false);
    const cat = buildReadOnlySearchCatalog(mkdtempSync(join(tmpdir(), 'toolkit-ro-')));
    expect(cat.specs.map((s) => s.name).sort()).toEqual(['DirectiveSearch', 'DocsSearch', 'Glob', 'Grep', 'ListDir', 'Read']);
    await expect(cat.dispatch('Bash', { command: 'true' })).rejects.toThrow('read-only search catalog does not allow: Bash');
    await expect(cat.dispatch('Write', {})).rejects.toThrow('read-only search catalog does not allow: Write');
  });
});
