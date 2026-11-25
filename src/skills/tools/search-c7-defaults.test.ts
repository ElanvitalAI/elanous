// Search tool defaults from search-bench #40045 (C7): Glob case-insensitive · Grep head_limit 1000 with an explicit
// «truncated: N more» · ko↔en expansion (Grep files mode, DocsSearch) · identifier → defining files first (ast-grep,
// else a logged regex fallback) · seat surfaces expose Glob → Grep → Read first. Expected values are literals.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchGlob } from './glob.js';
import { dispatchGrep } from './grep.js';
import { dispatchDocsSearch } from './docs-search.js';
import { resetSearchLoopGuardForTest } from './search-loop-guard.js';
import { expandGrepPattern, expandQueryWords, termVariants, topLevelAlternatives } from './search-terms.js';
import { identifierAlternatives, setStructuralSpawnForTesting } from './search-structural.js';
import { SEAT_SEARCH_NATIVE_FAMILY_IDS, resolveDynamicSessionNativeToolSpecs } from '../../session-runtime/index.js';
import { SEARCH_TOOLKIT_CORE } from '../../agent/search-toolkit.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'search-c7-'));
  mkdirSync(join(dir, 'ui'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, 'many'), { recursive: true });
  mkdirSync(join(dir, 'ko'), { recursive: true });
  writeFileSync(join(dir, 'ko', 'aa-english.md'), 'server load is high\n');
  writeFileSync(join(dir, 'ko', 'zz-korean.md'), '판정국 부하 줄이기\n');
  writeFileSync(join(dir, 'ui', 'GraphApprovalCard.tsx'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'docs', 'APPROVAL-flow.md'), '# Approval flow\nThe approval queue.\n');
  writeFileSync(join(dir, 'docs', 'unrelated.md'), '# Nothing here\n');
  writeFileSync(join(dir, 'aa-use.ts'), 'import { buildWidget } from "./zz-def";\nbuildWidget();\n');
  writeFileSync(join(dir, 'zz-def.ts'), 'export function buildWidget() { return 1; }\n');
  for (let i = 0; i < 1003; i += 1) writeFileSync(join(dir, 'many', `m${String(i).padStart(4, '0')}.txt`), 'haystackword\n');
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { resetSearchLoopGuardForTest(); setStructuralSpawnForTesting(null); });

describe('Glob — case-insensitive by default', () => {
  test('lower-case pattern finds PascalCase and UPPER-case files', async () => {
    const r = await dispatchGlob({ pattern: '**/*approval*', path: dir });
    expect(r.numFiles).toBe(2);
    expect(r.output).toContain('GraphApprovalCard.tsx');
    expect(r.output).toContain('APPROVAL-flow.md');
  });
});

describe('Grep — head_limit 1000 and explicit truncation', () => {
  test('default cap is 1000 and the cut is spelled out', async () => {
    const r = await dispatchGrep({ pattern: 'haystackword', path: join(dir, 'many') });
    expect(r.numFiles).toBe(1000);
    expect(r.truncated).toBe(true);
    expect(r.output).toContain('[truncated: 3 more matching files — offset:1000');
  });
  test('content mode says «truncated: N more matches»', async () => {
    const r = await dispatchGrep({ pattern: 'haystackword', path: join(dir, 'many'), output_mode: 'content', head_limit: 1000 });
    expect(r.numMatches).toBe(1000);
    expect(r.output).toContain('[truncated: 3 more matches — offset:1000');
  });
});

describe('ko↔en expansion', () => {
  test('glossary variants, particles stripped, one-syllable variants dropped', () => {
    expect(termVariants('착지를')).toEqual(['land', 'landing']);
    expect(termVariants('approval')).toEqual(['승인']);
    expect(termVariants('queue')).toEqual([]);
  });
  test('top-level alternatives respect escapes, classes and groups', () => {
    expect(topLevelAlternatives('[|]|x\\|y|(p|q)')).toEqual(['[|]', 'x\\|y', '(p|q)']);
  });
  test('only plain-word alternatives expand', () => {
    expect(expandGrepPattern('승인|foo.*bar')).toEqual({ pattern: '승인|foo.*bar|approval', added: ['approval'], from: ['승인'] });
    expect(expandGrepPattern('승인.*').added).toEqual([]);
    expect(expandQueryWords('판정국 부하').query).toBe('판정국 부하 judge load');
  });
  test('Grep files mode finds the English doc for a Korean word; content mode stays literal', async () => {
    const r = await dispatchGrep({ pattern: '승인', path: join(dir, 'docs') });
    expect(r.numFiles).toBe(1);
    expect(r.output).toContain('APPROVAL-flow.md');
    expect(r.output).toContain('[expanded: 승인 → approval]');
    const c = await dispatchGrep({ pattern: '승인', path: join(dir, 'docs'), output_mode: 'content' });
    expect(c.output).toBe('No matches');
  });
  test('files that say the word as written come before glossary-only hits', async () => {
    const r = await dispatchGrep({ pattern: '부하', path: join(dir, 'ko') });
    expect(r.output.split('\n').filter((l) => l.startsWith(dir))).toEqual([join(dir, 'ko', 'zz-korean.md'), join(dir, 'ko', 'aa-english.md')]);
  });
  test('DocsSearch expands the query too', async () => {
    const r = await dispatchDocsSearch({ query: '승인', scope: 'custom', paths: [join(dir, 'docs')] }, { indexSearch: null });
    expect(r.output).toContain('[expanded: + approval]');
    expect(r.hits.map((h) => h.path)).toEqual([join(dir, 'docs', 'APPROVAL-flow.md')]);
  });
});

describe('identifier → defining files first', () => {
  test('identifier detection', () => {
    expect(identifierAlternatives('buildWidget|plain|SEARCH_KIT|snake_case|GraphCard')).toEqual(['buildWidget', 'SEARCH_KIT', 'snake_case']);
  });
  test('ast-grep missing → regex fallback, said out loud', async () => {
    setStructuralSpawnForTesting((cmd, args, cwd) => {
      if (cmd === 'ast-grep' || cmd === 'sg') return { status: null, stdout: '', stderr: '', missing: true };
      const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    });
    const r = await dispatchGrep({ pattern: 'buildWidget', path: dir });
    const listed = r.output.split('\n').filter((l) => l.startsWith(dir));
    expect(listed[0]).toBe(join(dir, 'zz-def.ts'));
    expect(listed[1]).toBe(join(dir, 'aa-use.ts'));
    expect(r.output).toContain('[definitions first: 1 file define buildWidget · via regex (ast-grep not installed)]');
  });
  test('ast-grep present → its answer orders the list', async () => {
    const calls: string[] = [];
    setStructuralSpawnForTesting((cmd, args) => {
      calls.push(`${cmd} ${args[0]}`);
      if (cmd === 'ast-grep' && args[0] === '--version') return { status: 0, stdout: 'ast-grep 0.39.0\n', stderr: '' };
      if (cmd === 'ast-grep' && args[0] === 'scan') return { status: 0, stdout: `${join(dir, 'zz-def.ts')}\n`, stderr: '' };
      return { status: 2, stdout: '', stderr: 'unexpected' };
    });
    const r = await dispatchGrep({ pattern: 'buildWidget', path: dir });
    expect(r.output.split('\n').filter((l) => l.startsWith(dir))[0]).toBe(join(dir, 'zz-def.ts'));
    expect(r.output).toContain('· via ast-grep]');
    expect(calls).toEqual(['ast-grep --version', 'ast-grep scan']);
  });
});

describe('seat surface exposure order', () => {
  test('Glob → Grep → Read first, DocsSearch last', () => {
    expect([...SEAT_SEARCH_NATIVE_FAMILY_IDS]).toEqual(['code-glob', 'code-grep', 'code-read', 'code-list-dir', 'docs-search']);
    expect([...SEARCH_TOOLKIT_CORE]).toEqual(['Glob', 'Grep', 'Read', 'ListDir']);
    const names = resolveDynamicSessionNativeToolSpecs({ userText: 'hello', surfaceId: 'ops-ui/agent' }).map((s) => s.name);
    expect(names.slice(0, 3)).toEqual(['Glob', 'Grep', 'Read']);
  });
});
