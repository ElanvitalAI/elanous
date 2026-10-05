import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { intakeCheckReportJson, renderIntakeCheckReport, runIntakeCheck } from '../src/intake-plane/check.js';
import { createIntakeFakeRepo } from './helpers/intake-fake-repo.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const deps = () => createIntakeFakeRepo(roots, 'intake-replacement-');

const possibility = '`crawlerkit` 이 유료 `firecrawl` 을 대체할 수 있다';

test('a paid-dependency replacement is a candidate requiring a hands-on trial, never an approved replacement or a gap draft', () => {
  const report = runIntakeCheck([{ text: possibility, quote: 'external comparison' }], deps());
  const item = report.items[0]!;
  expect(item.verdict).toBe('판단 필요');
  expect(item.replacementCandidate).toEqual({
    tool: 'crawlerkit',
    paidDependency: 'firecrawl',
    status: '현장 시험 필요',
    trial: { installation: '미검증', sampleRun: '미검증', license: '미검증', maintenanceStatus: '미검증' },
  });
  expect(item.current).toContain('설치·샘플 실행·라이선스·유지보수 상태 현장 시험 필요');
  expect(item.line).toContain('→ 판단 필요');
  expect(report.goalDraftPaths).toEqual([]);
  expect(report.harnessLaunches).toBe(0);
  const json = intakeCheckReportJson(report);
  expect((json.items as Array<{ replacementCandidate?: unknown }>)[0]?.replacementCandidate).toEqual(item.replacementCandidate);
  expect(renderIntakeCheckReport(report)).toContain('대체 후보: crawlerkit → 유료 의존성 firecrawl (현장 시험 필요)');
  expect(renderIntakeCheckReport(report)).toContain('설치 미검증 · 샘플 실행 미검증 · 라이선스 미검증 · 유지보수 상태 미검증');
});

test('missing paid-dependency attribution, ambiguous tool, and negated replacement cannot become candidates', () => {
  const report = runIntakeCheck([
    { text: '`crawlerkit` 을 설치한다' },
    { text: '`crawlerkit` 이 `otherpaid` 을 대체한다' },
    { text: '`crawlerkit` 과 `otherkit` 이 유료 `firecrawl` 을 대체할 수 있다' },
    { text: '`crawlerkit` 은 유료 `firecrawl` 을 대체할 수 없다' },
  ], deps());
  expect(report.items.map((item) => item.replacementCandidate)).toEqual([undefined, undefined, undefined, undefined]);
  expect(report.items[0]?.verdict).toBe('없음');
});

test('a named firecrawl replacement needs a trial even when paid is not written explicitly', () => {
  const item = runIntakeCheck([{ text: '`crawlerkit` 이 `firecrawl` 을 대체한다' }], deps()).items[0]!;
  expect(item.replacementCandidate?.tool).toBe('crawlerkit');
  expect(item.replacementCandidate?.paidDependency).toBe('firecrawl');
  expect(item.verdict).toBe('판단 필요');
});

test('existing implementation evidence alone cannot certify a paid-dependency replacement', () => {
  const report = runIntakeCheck([{ text: possibility }], {
    ...deps(),
    comparer: () => ({ verdict: '있음', current: 'src/crawler.ts:3 implements crawlerkit', evidence: [
      { axis: 'repo', path: 'src/crawler.ts', line: 3, repoKind: 'behavior', summary: 'crawlerkit' },
    ], patterns: ['crawlerkit'], failures: [] }),
  });
  expect(report.items[0]?.verdict).toBe('판단 필요');
  expect(report.items[0]?.current).toContain('src/crawler.ts:3 implements crawlerkit');
  expect(report.items[0]?.replacementCandidate?.trial.sampleRun).toBe('미검증');
  expect(report.goalDraftPaths).toEqual([]);
});

test('a failed search remains unmeasured even for a potential replacement', () => {
  const report = runIntakeCheck([{ text: possibility }], { ...deps(), listFiles: () => { throw new Error('search failed'); } });
  expect(report.items[0]?.verdict).toBe('못 쟀다');
  expect(report.items[0]?.failures).toContain('search failed');
  expect(report.items[0]?.replacementCandidate?.trial.license).toBe('미검증');
  expect(report.goalDraftPaths).toEqual([]);
});
