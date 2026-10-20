import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { checkCitedReviewPathsAtHead, citedReviewPaths, citedReviewSymbols, MAX_CITED_REVIEW_SYMBOL_CHARS, measureReviewFindingKeyOverlap, normalizeCitedReviewSymbolForComparison, normalizeReviewFindingKey, REVIEW_FINDING_KEY_VERSION, reviewFindingKey, shortNormalizedReviewFindingHash } from './review-finding-key.js';

describe('review finding key', () => {
  test('preserves the review finding key version used by historical observations', () => {
    expect(REVIEW_FINDING_KEY_VERSION).toBe('reviewFindingKey-v1');
  });

  test('normalizes prose keys and hashes them deterministically', () => {
    const normalized = normalizeReviewFindingKey('  FIX `Symbol99` 42\n NOW  ');
    expect(normalized).toBe('fix now');
    expect(shortNormalizedReviewFindingHash(normalized)).toBe('0d563489');
    expect(shortNormalizedReviewFindingHash(normalized)).toMatch(/^[0-9a-f]{8}$/);
    expect(reviewFindingKey('  FIX `Symbol99` 42\n NOW  ')).toEqual({ key: 'symbol:["Symbol99"]', source: 'symbol' });
    expect(reviewFindingKey('  FIX 42\n NOW  ')).toEqual({ key: 'fix now', source: 'prose' });
  });

  test('uses a sorted cited-symbol set instead of prose and omits empty citations', () => {
    const first = 'Verify arrival logs from `debug.log` and `.elanous-test/logs.db`';
    const second = 'Confirm both ` .elanous-test/logs.db ` and `debug.log` receive the event';
    const symbolKey = 'symbol:[".elanous-test/logs.db","debug.log"]';
    expect(reviewFindingKey(first)).toEqual({ key: symbolKey, source: 'symbol' });
    expect(reviewFindingKey(second)).toEqual({ key: symbolKey, source: 'symbol' });
    expect(reviewFindingKey('Only `` is cited')).toEqual({ key: 'only is cited', source: 'prose' });
    expect(shortNormalizedReviewFindingHash(symbolKey)).toBe(createHash('sha256').update(symbolKey).digest('hex').slice(0, 8));
  });

  test('normalizes only the comparison identity of a dotted id member', () => {
    const terminalId = normalizeCitedReviewSymbolForComparison('terminalId');
    expect(normalizeCitedReviewSymbolForComparison('terminal.id')).toBe(terminalId);
    expect(normalizeCitedReviewSymbolForComparison('terminal.name')).not.toBe(terminalId);
    expect(normalizeCitedReviewSymbolForComparison('debug.csv')).not.toBe(normalizeCitedReviewSymbolForComparison('debugCsv'));
    expect(normalizeCitedReviewSymbolForComparison('schema.graphql')).not.toBe(normalizeCitedReviewSymbolForComparison('schemaGraphql'));
    expect(normalizeCitedReviewSymbolForComparison('artifact.unregisteredExtension')).not.toBe(normalizeCitedReviewSymbolForComparison('artifactUnregisteredExtension'));
    expect(terminalId).toMatch(/^[0-9a-f]{16}$/);
    expect(terminalId).not.toContain('terminal');
  });

  test('deduplicates cited symbols by full identity while preserving bounded previews', () => {
    const oversized = 'x'.repeat(MAX_CITED_REVIEW_SYMBOL_CHARS + 1);
    const symbols = citedReviewSymbols(`Use \`${oversized}\` twice: \`${oversized}\`.`);
    expect(symbols).toEqual([expect.objectContaining({
      hash: createHash('sha256').update(oversized).digest('hex').slice(0, 16),
      symbol: 'x'.repeat(MAX_CITED_REVIEW_SYMBOL_CHARS),
    })]);
  });

  test('measures complete, partial, and absent cited-symbol overlap without a threshold', () => {
    const left = 'Check `alpha`, `beta`, and `gamma`.';
    const partial = 'Check `beta`, `gamma`, and `delta`.';
    const identical = 'Recheck `gamma`, `beta`, and `alpha`.';
    const disjoint = 'Check `delta`, `epsilon`, and `zeta`.';

    expect(measureReviewFindingKeyOverlap(left, partial)).toEqual({
      comparable: true,
      sharedSymbolCount: 2,
      leftSymbolCount: 3,
      rightSymbolCount: 3,
      overlapRatio: 2 / 3,
    });
    expect(measureReviewFindingKeyOverlap(left, identical)).toEqual({
      comparable: true,
      sharedSymbolCount: 3,
      leftSymbolCount: 3,
      rightSymbolCount: 3,
      overlapRatio: 1,
    });
    expect(measureReviewFindingKeyOverlap(left, disjoint)).toEqual({
      comparable: true,
      sharedSymbolCount: 0,
      leftSymbolCount: 3,
      rightSymbolCount: 3,
      overlapRatio: 0,
    });
  });

  test('compares full cited symbols using the existing normalized identity and keeps previews bounded', () => {
    const oversizedPrefix = 'x'.repeat(MAX_CITED_REVIEW_SYMBOL_CHARS + 1);
    const oversizedDottedId = `${oversizedPrefix}.id`;
    const oversizedId = `${oversizedPrefix}Id`;
    const overlap = measureReviewFindingKeyOverlap(
      `Inspect \`mergePreviewTerminals\`, \`terminalId\`, and \`${oversizedDottedId}\`.`,
      `Inspect \`mergePreviewTerminals\`, \`terminal.id\`, and \`${oversizedId}\`.`,
    );

    expect(overlap).toEqual({
      comparable: true,
      sharedSymbolCount: 3,
      leftSymbolCount: 3,
      rightSymbolCount: 3,
      overlapRatio: 1,
    });
    expect(citedReviewSymbols(`Inspect \`${oversizedDottedId}\`.`)[0]!.symbol).toHaveLength(MAX_CITED_REVIEW_SYMBOL_CHARS);
  });

  test('deduplicates normalized comparison aliases before measuring overlap', () => {
    const aliases = 'Check `terminalId` and `terminal.id`.';
    const canonical = 'Check `terminalId`.';
    const expected = {
      comparable: true,
      sharedSymbolCount: 1,
      overlapRatio: 1,
    };

    expect(measureReviewFindingKeyOverlap(aliases, canonical)).toMatchObject({
      ...expected,
      leftSymbolCount: 2,
      rightSymbolCount: 1,
    });
    expect(measureReviewFindingKeyOverlap(canonical, aliases)).toMatchObject({
      ...expected,
      leftSymbolCount: 1,
      rightSymbolCount: 2,
    });
  });

  test('keeps findings without cited symbols distinguishable as unmeasurable', () => {
    expect(measureReviewFindingKeyOverlap('Use `alpha`.', 'No cited symbol here.')).toEqual({
      comparable: false,
      sharedSymbolCount: 0,
      leftSymbolCount: 1,
      rightSymbolCount: 0,
      overlapRatio: undefined,
    });
  });

  test('an old-head-only cited file is missing at the exact new head, not a verified finding', () => {
    const repo = mkdtempSync(join(tmpdir(), 'review-finding-head-'));
    const git = (...args: string[]): string => {
      const result = spawnSync('git', ['-C', repo, ...args], {
        encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
      });
      if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    try {
      git('init', '-q');
      mkdirSync(join(repo, 'src'));
      writeFileSync(join(repo, 'src/old.ts'), 'export const old = true;\n');
      git('add', 'src/old.ts');
      git('commit', '-qm', 'old head');
      const oldHead = git('rev-parse', 'HEAD');
      git('rm', 'src/old.ts');
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src/new.ts'), 'export const current = true;\n');
      git('add', 'src/new.ts');
      git('commit', '-qm', 'new head');
      const newHead = git('rev-parse', 'HEAD');
      const treeObject = git('rev-parse', 'HEAD^{tree}');
      const finding = 'Must fix `src/old.ts` in this PR';

      expect(citedReviewPaths('`terminal.id`, `https://example.test/page`, and `src/old.ts:17`')).toEqual(['src/old.ts']);
      expect(citedReviewPaths('`src/worker.go`, `queries/read.sql`, `src/run-task()`')).toEqual(['src/worker.go', 'queries/read.sql']);
      expect(checkCitedReviewPathsAtHead(finding, repo, oldHead)).toMatchObject({
        status: 'verified', paths: [{ path: 'src/old.ts', status: 'present' }],
      });
      expect(checkCitedReviewPathsAtHead(finding, repo, newHead)).toMatchObject({
        status: 'path-missing', paths: [{ path: 'src/old.ts', status: 'missing' }],
      });
      expect(checkCitedReviewPathsAtHead('`src/new.ts` and `src/old.ts`', repo, newHead)).toMatchObject({
        status: 'path-missing', paths: [{ status: 'present' }, { status: 'missing' }],
      });
      expect(checkCitedReviewPathsAtHead(finding, repo, 'not-a-head').status).toBe('unreadable');
      expect(checkCitedReviewPathsAtHead(finding, repo, '0'.repeat(40)).status).toBe('unreadable');
      expect(checkCitedReviewPathsAtHead(finding, repo, treeObject).status).toBe('unreadable');
      expect(checkCitedReviewPathsAtHead('Check `terminal.id`', repo, newHead).status).toBe('no-cited-path');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
