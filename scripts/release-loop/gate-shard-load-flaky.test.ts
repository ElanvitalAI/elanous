import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readShardArtifacts } from './gate-node';
import { cleanRetryVerdict, failedJunitFiles, junitFailedCaseIds, junitPassedCaseIds, junitTestcaseFiles } from './gate-shard-load-flaky';

describe('same-Pod standalone retry evidence', () => {
  test('selects only attributed failed files from the shard allowlist', () => {
    const xml = '<testsuites><testsuite file="src/a.test.ts"><testcase name="a"><failure/></testcase></testsuite><testsuite file="src/b.test.ts"><testcase name="b"/></testsuite></testsuites>';
    expect(failedJunitFiles(xml, ['src/a.test.ts', 'src/b.test.ts'])).toEqual(['src/a.test.ts']);
    expect(failedJunitFiles(xml, ['src/b.test.ts'])).toBeNull();
    expect(failedJunitFiles('<testsuites tests="2"><testsuite file="src/a.test.ts" tests="1"><testcase><failure/></testcase></testsuite><testsuite file="src/b.test.ts" tests="1"><testcase/></testsuite></testsuites>', ['src/a.test.ts', 'src/b.test.ts'])).toEqual(['src/a.test.ts']);
  });

  test('malformed or unlisted failure evidence fails closed', () => {
    expect(failedJunitFiles('<testsuites><testsuite file="src/a.test.ts"><testcase><failure/></testsuite>', ['src/a.test.ts'])).toBeNull();
    expect(failedJunitFiles('<testsuites><testsuite file="src/other.test.ts"><testcase><failure/></testcase></testsuite></testsuites>', ['src/a.test.ts'])).toBeNull();
    expect(failedJunitFiles('<testsuites><!bogus><testsuite file="src/a.test.ts"><testcase/></testsuite></testsuites>', ['src/a.test.ts'])).toBeNull();
    const testcaseOutsideSuite = '<testsuites><testsuite file="src/a.test.ts"/><testcase file="src/a.test.ts"><failure/></testcase></testsuites>';
    expect(failedJunitFiles(testcaseOutsideSuite, ['src/a.test.ts'])).toBeNull();
    const cleanTestcaseOutsideSuite = '<testsuites><testsuite file="src/a.test.ts"/><testcase file="src/a.test.ts"/></testsuites>';
    expect(cleanRetryVerdict(0, '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n', cleanTestcaseOutsideSuite, 'src/a.test.ts').clean).toBe(false);
    expect(failedJunitFiles('<testsuites><testsuite file="src/a.test.ts"><failure/></testsuite></testsuites>', ['src/a.test.ts'])).toBeNull();
    expect(cleanRetryVerdict(0, '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n',
      '<testsuites><!bogus><testsuite file="src/a.test.ts"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    const commentInsideAttribute = '<testsuites><testsuite fi<!--x-->le="src/a.test.ts"><testcase><failure/></testcase></testsuite></testsuites>';
    expect(failedJunitFiles(commentInsideAttribute, ['src/a.test.ts'])).toBeNull();
    expect(cleanRetryVerdict(0, '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n', commentInsideAttribute, 'src/a.test.ts').clean).toBe(false);
    expect(failedJunitFiles('<testsuites><testsuite file="src/a.test.ts" failures="2"><testcase><failure/></testcase></testsuite></testsuites>', ['src/a.test.ts'])).toBeNull();
    expect(failedJunitFiles('<testsuites failures="2"><testsuite file="src/a.test.ts"><testcase><failure/></testcase></testsuite></testsuites>', ['src/a.test.ts'])).toBeNull();
    expect(failedJunitFiles('<testsuites><testsuite file="src/a.test.ts" failures="1"><testcase><failure/><failure/></testcase></testsuite></testsuites>', ['src/a.test.ts'])).toBeNull();
    expect(failedJunitFiles('<testsuites><testsuite file="src/a.test.ts" errors="1"><testcase><error/><error/></testcase></testsuite></testsuites>', ['src/a.test.ts'])).toBeNull();
  });

  test('PI-like text inside legal comments and CDATA remains content', () => {
    const wrap = (content: string) => `<testsuites><testsuite file="src/a.test.ts"><testcase>${content}</testcase></testsuite></testsuites>`;
    expect(failedJunitFiles(wrap('<!-- <?worker?> -->'), ['src/a.test.ts'])).toEqual([]);
    expect(failedJunitFiles(wrap('<![CDATA[<?worker?>]]>'), ['src/a.test.ts'])).toEqual([]);
  });

  test('only the leading XML declaration is accepted; markup processing instructions fail closed', () => {
    const wrap = (content: string) => `<testsuites><testsuite file="src/a.test.ts"><testcase>${content}</testcase></testsuite></testsuites>`;
    expect(failedJunitFiles('<?xml version="1.0"?>' + wrap('pass'), ['src/a.test.ts'])).toEqual([]);
    expect(failedJunitFiles(wrap('<?worker?>'), ['src/a.test.ts'])).toBeNull();
  });

  test('malformed, foreign, or count-mismatched retry JUnit cannot become clean', () => {
    const cleanLog = '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n';
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts"><testcase/></testsuite>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts"><testcase/><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts"><testcase/></testsuite><testsuite file="src/other.test.ts"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts"><testcase/></testsuites></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, 'junk<testsuites><testsuite file="src/a.test.ts"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts"><failure/></testsuite><testsuite file="src/a.test.ts"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts"><testcase name="bad &entity;"/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites tests="2"><testsuite file="src/a.test.ts" tests="2"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts" failures="1"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites failures="1"><testsuite file="src/a.test.ts"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts"><testcase name="bad &#1;"/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><!-- bad -- comment --><testsuite file="src/a.test.ts"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    const badDeclaration = '<?xml nope?><testsuites><testsuite file="src/a.test.ts"><testcase/></testsuite></testsuites>';
    const rawControl = '<testsuites><testsuite file="src/a.test.ts"><testcase>\u0001</testcase></testsuite></testsuites>';
    const rawLessThan = '<testsuites><testsuite file="src/a.test.ts"><testcase>bad <x</testcase></testsuite></testsuites>';
    const malformedFailure = '<testsuites><testsuite file="src/a.test.ts"><testcase>bad <x</testcase><testcase><failure/></testcase></testsuite></testsuites>';
    expect(cleanRetryVerdict(0, cleanLog, badDeclaration, 'src/a.test.ts').clean).toBe(false);
    expect(failedJunitFiles(badDeclaration, ['src/a.test.ts'])).toBeNull();
    expect(cleanRetryVerdict(0, cleanLog, rawControl, 'src/a.test.ts').clean).toBe(false);
    expect(failedJunitFiles(rawControl, ['src/a.test.ts'])).toBeNull();
    expect(cleanRetryVerdict(0, cleanLog, rawLessThan, 'src/a.test.ts').clean).toBe(false);
    expect(failedJunitFiles(malformedFailure, ['src/a.test.ts'])).toBeNull();
  });

  test('a retry must rerun the originally failed testcase identity; another passing case in the file is insufficient', () => {
    const cleanLog = '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n';
    const passingOtherCase = '<testsuites><testsuite file="src/a.test.ts"><testcase name="other"/></testsuite></testsuites>';
    expect(cleanRetryVerdict(0, cleanLog, passingOtherCase, 'src/a.test.ts', ['src/a.test.ts > failed']).clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, passingOtherCase, 'src/a.test.ts', ['src/a.test.ts > other']).clean).toBe(true);
    expect(junitPassedCaseIds(passingOtherCase)).toEqual(['src/a.test.ts > other']);
    expect(junitTestcaseFiles(passingOtherCase)).toEqual(['src/a.test.ts']);
    expect(junitTestcaseFiles('<testsuites><testsuite><testcase name="missing-file"/></testsuite></testsuites>')).toBeNull();
    const duplicateFail = '<testsuites><testsuite file="src/a.test.ts"><testcase name="same"><failure/></testcase><testcase name="same"><failure/></testcase></testsuite></testsuites>';
    expect(junitFailedCaseIds(duplicateFail)).toBeNull();
    const oneDuplicateFails = '<testsuites><testsuite file="src/a.test.ts"><testcase name="same"><failure/></testcase><testcase name="same"/></testsuite></testsuites>';
    expect(junitFailedCaseIds(oneDuplicateFails)).toBeNull();
    const onePass = '<testsuites><testsuite file="src/a.test.ts"><testcase name="same"/></testsuite></testsuites>';
    const twoPasses = '<testsuites><testsuite file="src/a.test.ts"><testcase name="same"/><testcase name="same"/></testsuite></testsuites>';
    expect(cleanRetryVerdict(0, cleanLog, onePass, 'src/a.test.ts', ['src/a.test.ts > same', 'src/a.test.ts > same']).clean).toBe(false);
    expect(cleanRetryVerdict(0, '2 pass\n0 fail\n0 errors\nRan 2 tests across 1 file.\n', twoPasses, 'src/a.test.ts', ['src/a.test.ts > same', 'src/a.test.ts > same']).clean).toBe(true);

    const failedInOtherSuite = '<testsuites><testsuite name="first" file="src/a.test.ts"><testcase name="same"><failure/></testcase></testsuite><testsuite name="second" file="src/a.test.ts"><testcase name="same"/></testsuite></testsuites>';
    const passingOnlyOtherSuite = '<testsuites><testsuite name="second" file="src/a.test.ts"><testcase name="same"/></testsuite></testsuites>';
    const originalFailureId = junitFailedCaseIds(failedInOtherSuite)?.[0];
    expect(originalFailureId).toBe('src/a.test.ts > first > same');
    expect(cleanRetryVerdict(0, cleanLog, passingOnlyOtherSuite, 'src/a.test.ts', [originalFailureId!]).clean).toBe(false);
  });

  test('a complete clean standalone retry is loadFlaky; persistent failure is not', () => {
    const cleanXml = '<testsuites><testsuite file="src/a.test.ts"><testcase name="works"/></testsuite></testsuites>';
    const failXml = '<testsuites><testsuite file="src/a.test.ts"><testcase name="works"><failure/></testcase></testsuite></testsuites>';
    const cleanLog = '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n';
    const failLog = '0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.\n';
    expect(cleanRetryVerdict(0, cleanLog, cleanXml, 'src/a.test.ts').clean).toBe(true);
    expect(cleanRetryVerdict(1, failLog, failXml, 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, undefined, 'src/a.test.ts').clean).toBe(false);
  });

  test('artifact reader filters only a clean per-file retry; persistent failures stay failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-load-flaky-'));
    try {
      const parts = [['src/a.test.ts', 'src/b.test.ts']];
      const setup = (retryFail: boolean) => {
        const dir = join(root, retryFail ? 'persistent' : 'flaky');
        mkdirSync(dir);
        writeFileSync(join(dir, 'install.rc'), '0\n');
        writeFileSync(join(dir, 'install.log'), '');
        writeFileSync(join(dir, 'part-0.rc'), '1\n');
        writeFileSync(join(dir, 'part-0.log'), 'src/a.test.ts:\n(fail) A [1ms]\n1 pass\n1 fail\nRan 2 tests across 2 files.\n');
        writeFileSync(join(dir, 'part-0.junit.xml'), '<testsuites><testsuite file="src/a.test.ts"><testcase name="A"><failure/></testcase></testsuite><testsuite file="src/b.test.ts"><testcase name="B"/></testsuite></testsuites>');
        writeFileSync(join(dir, 'part-0.retry-files'), 'src/a.test.ts\n');
        writeFileSync(join(dir, 'part-0.retry-0.rc'), retryFail ? '1\n' : '0\n');
        writeFileSync(join(dir, 'part-0.retry-0.log'), retryFail ? '0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.\n' : '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n');
        writeFileSync(join(dir, 'part-0.retry-0.junit.xml'), retryFail
          ? '<testsuites><testsuite file="src/a.test.ts"><testcase name="A"><failure/></testcase></testsuite></testsuites>'
          : '<testsuites><testsuite file="src/a.test.ts"><testcase name="A"/></testsuite></testsuites>');
        return readShardArtifacts(dir, parts);
      };
      expect(setup(false)).toMatchObject({ loadFlaky: ['src/a.test.ts > A'] });
      expect(setup(true).loadFlaky).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('started retry remains recorded when the pod dies before writing rc', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-load-flaky-started-'));
    try {
      writeFileSync(join(root, 'install.rc'), '0\n');
      writeFileSync(join(root, 'install.log'), '');
      writeFileSync(join(root, 'part-0.log'), '0 pass\n1 fail\nRan 1 test across 1 file.\n');
      writeFileSync(join(root, 'part-0.junit.xml'), '<testsuites><testsuite file="src/a.test.ts"><testcase name="A"><failure/></testcase></testsuite></testsuites>');
      writeFileSync(join(root, 'part-0.retry-files'), 'src/a.test.ts\n');
      writeFileSync(join(root, 'part-0.retry-0.started'), '');
      expect(readShardArtifacts(root, [['src/a.test.ts']])).toMatchObject({ loadFlakyAttemptedFiles: ['src/a.test.ts'] });
      expect(readShardArtifacts(root, [['src/a.test.ts']]).loadFlaky).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a complete timeout JUnit plus clean same-Pod retry propagates loadFlaky', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-load-flaky-timeout-'));
    try {
      writeFileSync(join(root, 'install.rc'), '0\n');
      writeFileSync(join(root, 'install.log'), '');
      writeFileSync(join(root, 'part-0.rc'), '124\n');
      writeFileSync(join(root, 'part-0.log'), '1 pass\n1 fail\nRan 2 tests across 2 files.\n');
      writeFileSync(join(root, 'part-0.junit.xml'), '<testsuites tests="2"><testsuite file="src/a.test.ts" tests="1"><testcase name="A"/></testsuite><testsuite file="src/b.test.ts" tests="1" failures="1"><testcase name="B"><failure/></testcase></testsuite></testsuites>');
      writeFileSync(join(root, 'part-0.retry-files'), 'src/b.test.ts\n');
      writeFileSync(join(root, 'part-0.retry-0.started'), '');
      writeFileSync(join(root, 'part-0.retry-0.rc'), '0\n');
      writeFileSync(join(root, 'part-0.retry-0.log'), '1 pass\n0 fail\nRan 1 test across 1 file.\n');
      writeFileSync(join(root, 'part-0.retry-0.junit.xml'), '<testsuites tests="1"><testsuite file="src/b.test.ts" tests="1"><testcase name="B"/></testsuite></testsuites>');
      expect(readShardArtifacts(root, [['src/a.test.ts', 'src/b.test.ts']])).toMatchObject({
        rc: 1, loadFlaky: ['src/b.test.ts > B'], loadFlakyAttemptedFiles: ['src/b.test.ts'],
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
