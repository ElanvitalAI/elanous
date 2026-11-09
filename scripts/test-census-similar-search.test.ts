import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSimilarSearchReport, caseRowsFromSelection, parseArgs, runSimilarSearchCli } from './test-census-similar-search.js';
import { searchableText } from './test-census/similar-search.js';
import type { EmbedFn } from '../src/domains/knowledge.js';

describe('test-census similar-search CLI input', () => {
  test('selects exact file and case identities from the census and derives source-module context', () => {
    const cases = caseRowsFromSelection({ rows: [
      { file: 'src/auth/token.test.ts', name: 'refresh keeps session', contract: 'toEqual', owner: 'SEC', numericCandidateProvenance: [{ literal: '4', line: 12, blameCommit: 'a'.repeat(40), reason: 'Provider permits four retries.' }] },
      { file: 'src/ledger/receipt.test.ts', name: 'commit writes receipt', contract: 'toBe' },
      { file: 'src/cli/options.test.ts', suitePath: ['remote option entrypoint'], name: 'rejects an unknown option', contract: 'toThrow' },
    ] }, ['src/auth/token.test.ts > refresh keeps session', 'src/cli/options.test.ts > remote option entrypoint > rejects an unknown option']);
    expect(cases).toEqual([{
      id: 'src/auth/token.test.ts#refresh keeps session',
      file: 'src/auth/token.test.ts',
      name: 'refresh keeps session',
      assertions: 'toEqual',
      targetSummary: 'toEqual',
      module: 'src/auth',
      owner: 'SEC',
      numericCandidateProvenance: [{ literal: '4', line: 12, blameCommit: 'a'.repeat(40), reason: 'Provider permits four retries.' }],
    }, {
      id: 'src/cli/options.test.ts#remote option entrypoint > rejects an unknown option',
      file: 'src/cli/options.test.ts',
      name: 'rejects an unknown option',
      assertions: 'toThrow',
      targetSummary: 'toThrow',
      module: 'src/cli',
      owner: undefined,
    }]);
    const indexedText = searchableText(cases[0]!);
    expect(indexedText).toContain('numeric literal 4 at line 12');
    expect(indexedText).toContain(`blame commit ${'a'.repeat(40)}`);
    expect(indexedText).toContain('commit reason Provider permits four retries.');
  });

  test('rejects duplicate and missing rows instead of silently shrinking the measurement', () => {
    expect(() => caseRowsFromSelection({ rows: [] }, ['missing.test.ts > absent']))
      .toThrow('selection cases absent from census');
    expect(() => caseRowsFromSelection({ rows: [] }, ['same.test.ts > case', 'same.test.ts > case']))
      .toThrow('duplicate cases');
  });

  test('parses only supported flags and rejects missing, duplicate, and option-shaped values', () => {
    expect(parseArgs(['--census', 'census.json', '--selection', 'cases.txt', '--out', 'result.json']))
      .toEqual({ censusPath: 'census.json', selectionPath: 'cases.txt', outputPath: 'result.json' });
    expect(() => parseArgs(['--census', 'census.json', '--selection', 'cases.txt', '--out', '--limit']))
      .toThrow('--out requires a path');
    expect(() => parseArgs(['--census', 'census.json', '--selection', 'cases.txt', '--out', '-x']))
      .toThrow('--out requires a path');
    expect(() => parseArgs(['--census', 'a', '--census', 'b', '--selection', 'cases.txt']))
      .toThrow('duplicate argument');
    expect(() => parseArgs(['--census', 'a', '--selection', 'cases.txt', '--limit', '4']))
      .toThrow('unknown argument');
  });

  test('builds fixed top-three output through all indexes with an injected embedder', async () => {
    const embed: EmbedFn = async () => ({ vector: new Float32Array([1, 0, 0, 0]), model: 'fixture' });
    const report = await buildSimilarSearchReport([
      { id: 'a', file: 'src/auth/a.test.ts', name: 'session refresh preserves caller', assertions: 'toEqual session', targetSummary: 'session stays active', module: 'src/auth', contractId: 'auth', numericCandidateProvenance: [{ literal: '4', line: 12, blameCommit: 'a'.repeat(40), reason: 'Provider permits four retries.' }] },
      { id: 'b', file: 'src/auth/b.test.ts', name: 'credential renewal retains context', assertions: 'toEqual caller', targetSummary: 'session remains active', module: 'src/auth', contractId: 'auth' },
      { id: 'c', file: 'src/ledger/c.test.ts', name: 'write durable receipt', assertions: 'toBe receipt', targetSummary: 'receipt persisted', module: 'src/ledger', contractId: 'ledger' },
      { id: 'd', file: 'src/queue/d.test.ts', name: 'retry failed job', assertions: 'toHaveBeenCalled', targetSummary: 'job retry', module: 'src/queue', contractId: 'queue' },
    ], embed, { census: 'census.json', selection: 'cases.txt' });
    expect(report.casesIndexed).toBe(4);
    expect(report.candidateLimit).toBe(3);
    expect(report.interpretation).toContain('union');
    expect(report.auditQuestions.expectedValueJustification).toContain('Which git blame commit introduced the literal, and what reason does that commit record?');
    expect(report.cases).toHaveLength(4);
    expect(report.cases.find((result) => result.caseId === 'a')?.numericCandidateProvenance).toEqual([{ literal: '4', line: 12, blameCommit: 'a'.repeat(40), reason: 'Provider permits four retries.' }]);
    for (const result of report.cases) {
      expect(result.top3.bm25.length).toBeLessThanOrEqual(3);
      expect(result.top3.vector.length).toBeLessThanOrEqual(3);
      expect(result.top3.ontology.length).toBeLessThanOrEqual(3);
      expect(result.top3.bm25).not.toContain(result.caseId);
      expect(result.top3.vector).not.toContain(result.caseId);
      expect(result.top3.ontology).not.toContain(result.caseId);
    }
    await expect(buildSimilarSearchReport([
      { id: 'broken', file: 'src/x.test.ts', name: 'broken vector', assertions: '', targetSummary: 'broken', module: 'src' },
    ], async () => { throw new Error('embedding unavailable'); }, { census: 'c', selection: 's' }))
      .rejects.toThrow('embedding unavailable');
  });

  test('runs the CLI path with a fake embedder and leaves output untouched on argument or embed failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-census-similar-search-'));
    try {
      const censusPath = join(dir, 'census.json');
      const selectionPath = join(dir, 'selection.txt');
      const outputPath = join(dir, 'result.json');
      writeFileSync(censusPath, JSON.stringify({ rows: [
        { file: 'src/auth/a.test.ts', name: 'refresh preserves session', contract: 'toEqual session' },
        { file: 'src/auth/b.test.ts', name: 'renewal retains session', contract: 'toEqual caller' },
        { file: 'src/ledger/c.test.ts', name: 'write receipt', contract: 'toBe receipt' },
      ] }));
      writeFileSync(selectionPath, 'src/auth/a.test.ts > refresh preserves session\nsrc/auth/b.test.ts > renewal retains session\nsrc/ledger/c.test.ts > write receipt\n');
      const embed: EmbedFn = async () => ({ vector: new Float32Array([1, 0, 0, 0]), model: 'fixture' });
      await runSimilarSearchCli(['--census', censusPath, '--selection', selectionPath, '--out', outputPath], embed);
      const report = JSON.parse(readFileSync(outputPath, 'utf8')) as { casesIndexed: number; candidateLimit: number; cases: unknown[] };
      expect(report).toMatchObject({ casesIndexed: 3, candidateLimit: 3 });
      expect(report.cases).toHaveLength(3);

      writeFileSync(outputPath, 'preserve me');
      await expect(runSimilarSearchCli([
        '--census', censusPath, '--selection', selectionPath, '--out', outputPath, '--limit', '5',
      ], embed)).rejects.toThrow('unknown argument');
      expect(readFileSync(outputPath, 'utf8')).toBe('preserve me');
      await expect(runSimilarSearchCli([
        '--census', censusPath, '--selection', selectionPath, '--out', outputPath,
      ], async () => { throw new Error('embedding unavailable'); })).rejects.toThrow('embedding unavailable');
      expect(readFileSync(outputPath, 'utf8')).toBe('preserve me');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
