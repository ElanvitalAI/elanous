import { describe, expect, test } from 'bun:test';
import { boundaryGlobs, boundaryViolations } from './goal-boundary.js';

describe('boundaryGlobs', () => {
  test('extracts only backtick-wrapped paths and globs from 경계 lines', () => {
    const document = [
      '대상: src/kept.ts 와 `src/also-kept.ts`',
      '경계: `src/nexus/**` 와 `apps/pwa` 는 이 골이 아니다. src/plain.ts 는 백틱이 아니다.',
      '경계: 괄호 안(`src/nested/file.ts`)도 뽑는다.',
      '- 경계: `docs/manual/*.md`',
      '## 다른 줄',
      '`src/not-a-boundary.ts`',
    ].join('\n');

    expect(boundaryGlobs(document)).toEqual([
      'src/nexus/**',
      'apps/pwa',
      'src/nested/file.ts',
      'docs/manual/*.md',
    ]);
  });

  test('returns an empty list when no boundary line has a backtick path', () => {
    expect(boundaryGlobs('경계: src/nexus/** 는 백틱이 없다\nImplement `src/kept.ts`')).toEqual([]);
    expect(boundaryGlobs('')).toEqual([]);
  });

  test('keeps backtick paths inside parentheses and ignores non-path backticks', () => {
    const document = [
      '  - 경계: 이유(`not a path`)와 경로(`apps/pwa/src/**`)',
      '> 경계: `./src/relative.ts` 와 `` 빈 백틱',
    ].join('\n');

    expect(boundaryGlobs(document)).toEqual(['apps/pwa/src/**', './src/relative.ts']);
  });
});

describe('boundaryViolations', () => {
  test('returns changed files that land on a boundary glob and ignores the rest', () => {
    const document = [
      '경계: `src/nexus/**` 와 `apps/pwa` 는 이 골이 아니다.',
      '경계: `docs/manual/*.md`',
    ].join('\n');

    expect(boundaryViolations(boundaryGlobs(document), [
      'src/nexus/gateway.ts',
      'src/self-implement/orchestrator.ts',
      'apps/pwa/index.html',
      'docs/manual/one.md',
      'docs/manual/nested/two.md',
      './src/nexus/again.ts',
    ])).toEqual([
      'src/nexus/gateway.ts',
      'apps/pwa/index.html',
      'docs/manual/one.md',
      'src/nexus/again.ts',
    ]);
  });

  test('returns an empty list when nothing was declared or nothing hit', () => {
    expect(boundaryViolations([], ['src/nexus/gateway.ts'])).toEqual([]);
    expect(boundaryViolations(['src/nexus/**'], ['src/self-implement/orchestrator.ts'])).toEqual([]);
    expect(boundaryViolations(boundaryGlobs('경계: 백틱 없는 src/nexus/**'), ['src/nexus/gateway.ts'])).toEqual([]);
  });
});
