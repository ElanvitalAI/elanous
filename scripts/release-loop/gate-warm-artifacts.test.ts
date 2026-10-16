import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warmReferenceFromJobArtifacts, writeWarmJobManifest } from './gate-warm-artifacts.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const file = 'src/example/worker.test.ts';
const defaultExpected = { cutSha: 'a'.repeat(40), attemptId: 'attempt-1' };
const parse = (prefix: string, testFile: string, expected = defaultExpected) => warmReferenceFromJobArtifacts(prefix, testFile, expected);
function artifacts(rc: string, log: string, inner: string, tests = 1): string {
  const dir = mkdtempSync(join(tmpdir(), 'warm-job-reference-'));
  dirs.push(dir);
  const prefix = join(dir, 'pod-1-c0-file-0');
  writeFileSync(`${prefix}.rc`, rc);
  const needsPassName = /(?:^|\n)[1-9]\d* pass/.test(log) && !log.includes('(pass)');
  const namedLog = !needsPassName ? log : log.includes(`${file}:`)
    ? log.replace(`${file}:`, `${file}:\n(pass) works`)
    : `(pass) works\n${log}`;
  writeFileSync(`${prefix}.log`, `[warm-worker] file=${file}\n[warm-worker] cut=${defaultExpected.cutSha} attempt=${defaultExpected.attemptId}\nbun test v1.4.2\n${namedLog.includes(`${file}:`) ? namedLog : `${file}:\n${namedLog}`}`);
  writeFileSync(`${prefix}.junit.xml`, `<testsuites tests="${tests}"><testsuite name="${file}" file="${file}" tests="${tests}"><testcase name="works" file="${file}">${inner}</testcase></testsuite></testsuites>`);
  if (rc === '0' || rc === '1') stampSource(prefix);
  writeFileSync(`${prefix}.json`, JSON.stringify({ rc: Number(rc), files: [file], commit: defaultExpected.cutSha,
    attemptId: defaultExpected.attemptId, jobExitCode: 0, jobFailed: false }));
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  return prefix;
}
function stampSource(prefix: string): void {
  const log = readFileSync(`${prefix}.log`, 'utf8').replace(/\n\[warm-worker\] junit-sha256=[0-9a-f]{64}\s*$/, '');
  const digest = createHash('sha256').update(readFileSync(`${prefix}.junit.xml`)).digest('hex');
  writeFileSync(`${prefix}.log`, `${log}\n[warm-worker] junit-sha256=${digest}\n`);
}
function bind(prefix: string, file: string, cutSha: string, attemptId: string): void {
  const hash = (suffix: string) => createHash('sha256').update(readFileSync(`${prefix}.${suffix}`)).digest('hex');
  writeFileSync(`${prefix}.warm-manifest.json`, JSON.stringify({ protocol: 1, cutSha, attemptId, file,
    rc: JSON.parse(readFileSync(`${prefix}.json`, 'utf8')).rc, logSha256: hash('log'),
    junitSha256: hash('junit.xml'), metaSha256: hash('json'), rcSha256: hash('rc') }));
}

test('one-file Job artifacts become the authoritative reference for the shadow comparator', () => {
  const pass = artifacts('0', `1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`, '');
  expect(parse(pass, file)).toEqual({ file, rc: 0, failureIds: [], errorIds: [], junitComplete: true });
  const fail = artifacts('1', `${file}:\nerror: broke\n(fail) works\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`, '<failure message="broke"/>');
  expect(parse(fail, file)).toEqual({ file, rc: 1, failureIds: [`${file} > works`], errorIds: [], junitComplete: true });
});

test('a passing log from another file cannot be rebound to this file JUnit', () => {
  const prefix = artifacts('0', '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.', '');
  writeFileSync(`${prefix}.log`, `[warm-worker] file=src/other/worker.test.ts\nbun test v1.4.2\n1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`);
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(prefix, file)).toBeNull();
});

test('a fresh manifest cannot rebind same-file same-count success cases', () => {
  const prefix = artifacts('0', '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.', '');
  const other = readFileSync(`${prefix}.junit.xml`, 'utf8').replace('name="works"', 'name="other"');
  writeFileSync(`${prefix}.junit.xml`, other);
  stampSource(prefix);
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(prefix, file)).toBeNull();
});

test('a successful Job without its source-side JUnit digest is unmeasured', () => {
  const prefix = artifacts('0', '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.', '');
  writeFileSync(`${prefix}.log`, readFileSync(`${prefix}.log`, 'utf8').replace(/\n\[warm-worker\] junit-sha256=[0-9a-f]{64}\s*$/, ''));
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(prefix, file)).toBeNull();
});

test('a complete prior Job pair cannot be assigned to a later attempt by a fresh manifest', () => {
  const earlier = artifacts('1', `${file}:\nerror: first\n(fail) works\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`, '<failure message="first"/>');
  const later = artifacts('1', `${file}:\nerror: second\n(fail) works\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`, '<failure message="second"/>');
  const laterAttempt = 'attempt-2';
  writeFileSync(`${later}.log`, readFileSync(`${later}.log`, 'utf8').replace('attempt=attempt-1', `attempt=${laterAttempt}`));
  writeFileSync(`${later}.json`, JSON.stringify({ rc: 1, files: [file], commit: defaultExpected.cutSha,
    attemptId: laterAttempt, jobExitCode: 0, jobFailed: false }));
  bind(later, file, defaultExpected.cutSha, laterAttempt);
  expect(parse(earlier, file)?.failureIds).toEqual([`${file} > works`]);
  expect(parse(later, file, { ...defaultExpected, attemptId: laterAttempt })?.failureIds).toEqual([`${file} > works`]);
  copyFileSync(`${earlier}.log`, `${later}.log`);
  copyFileSync(`${earlier}.junit.xml`, `${later}.junit.xml`);
  bind(later, file, defaultExpected.cutSha, laterAttempt);
  expect(parse(later, file, { ...defaultExpected, attemptId: laterAttempt })).toBeNull();
});

test('a source stamp printed by test stdout after Bun starts is not an origin stamp', () => {
  const prefix = artifacts('0', '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.', '');
  const stamp = `[warm-worker] cut=${defaultExpected.cutSha} attempt=${defaultExpected.attemptId}`;
  writeFileSync(`${prefix}.log`, readFileSync(`${prefix}.log`, 'utf8')
    .replace(`${stamp}\n`, '').replace('bun test v1.4.2\n', `bun test v1.4.2\n${stamp}\n`));
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(prefix, file)).toBeNull();
});

test('duplicate success names are unmeasured even when log and JUnit agree', () => {
  const prefix = artifacts('0', `${file}:\n(pass) works\n(pass) works\n2 pass\n0 fail\n0 errors\nRan 2 tests across 1 file.`, '', 2);
  writeFileSync(`${prefix}.junit.xml`, `<testsuites tests="2"><testsuite name="${file}" file="${file}" tests="2"><testcase name="works" file="${file}"/><testcase name="works" file="${file}"/></testsuite></testsuites>`);
  stampSource(prefix);
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(prefix, file)).toBeNull();
});

test('mixed pass and fail results bind the passing case IDs too', () => {
  const prefix = artifacts('1', `${file}:\n(pass) works\nerror: boom\n(fail) broken\n1 pass\n1 fail\n0 errors\nRan 2 tests across 1 file.`, '<failure message="boom"/>', 2);
  const junit = (passName: string) => `<testsuites tests="2"><testsuite name="${file}" file="${file}" tests="2"><testcase name="${passName}" file="${file}"/><testcase name="broken" file="${file}"><failure message="boom"/></testcase></testsuite></testsuites>`;
  writeFileSync(`${prefix}.junit.xml`, junit('works'));
  stampSource(prefix);
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(prefix, file)?.rc).toBe(1);
  writeFileSync(`${prefix}.junit.xml`, junit('other'));
  stampSource(prefix);
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(prefix, file)).toBeNull();
});

test('failure diagnostics preserve meaningful internal spaces', () => {
  const prefix = artifacts('1', `${file}:\nerror: expected: a b\n(fail) works\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`, '<failure message="expected: a  b"/>');
  expect(parse(prefix, file)).toBeNull();
});

test('multiple JUnit failures for one case cannot hide an earlier diagnostic', () => {
  const prefix = artifacts('1', `${file}:\nerror: second\n(fail) works\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`, '<failure message="second"/>');
  expect(parse(prefix, file)?.failureIds).toEqual([`${file} > works`]);
  writeFileSync(`${prefix}.junit.xml`, readFileSync(`${prefix}.junit.xml`, 'utf8')
    .replace('<failure message="second"/>', '<failure message="first"/><failure message="second"/>'));
  stampSource(prefix);
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(prefix, file)).toBeNull();
});

test('an unbound error after the final named failure is unmeasured without an error counter', () => {
  const prefix = artifacts('1', `${file}:\nerror: bound\n(fail) works\n0 pass\n1 fail\nRan 1 test across 1 file.`, '<failure message="bound"/>');
  expect(parse(prefix, file)?.failureIds).toEqual([`${file} > works`]);
  writeFileSync(`${prefix}.log`, readFileSync(`${prefix}.log`, 'utf8')
    .replace('0 pass\n1 fail', 'error: unbound\n0 pass\n1 fail'));
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(prefix, file)).toBeNull();
});

test('the actual Bun source and completed end boundary must match the requested file', () => {
  const prefix = artifacts('0', '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.', '');
  const good = readFileSync(`${prefix}.log`, 'utf8');
  expect(parse(prefix, file)?.rc).toBe(0);
  writeFileSync(`${prefix}.log`, good.replace(`${file}:`, 'src/other/worker.test.ts:'));
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(prefix, file)).toBeNull();
  writeFileSync(`${prefix}.log`, `${good}\nbun te`);
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(prefix, file)).toBeNull();
});

test('a similar filename in the legacy invocation does not bind the requested file', () => {
  const prefix = artifacts('0', '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.', '');
  writeFileSync(`${prefix}.log`, `$ bun run scripts/test-deterministic.ts src/example/workerXtest.ts\nbun test v1.4.2\n1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`);
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(prefix, file)).toBeNull();
});

test('missing, truncated, or conflicting Job evidence never becomes a reference', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'warm-job-missing-')), 'pod-1');
  dirs.push(join(missing, '..'));
  expect(parse(missing, file)).toBeNull();
  const wrongCount = artifacts('0', `1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`, '', 2);
  expect(parse(wrongCount, file)).toBeNull();
  const wrongSummary = artifacts('1', `0 pass\n2 fail\n0 errors\nRan 1 test across 1 file.`, '<failure/>');
  expect(parse(wrongSummary, file)).toBeNull();
  const missingPass = artifacts('0', `0 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`, '');
  expect(parse(missingPass, file)).toBeNull();
  const exitOnly = artifacts('2', `1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`, '');
  expect(parse(exitOnly, file)).toBeNull();
  const skipped = artifacts('0', `0 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`, '<skipped/>');
  expect(parse(skipped, file)).toBeNull();
  const xmlError = artifacts('0', `1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`, '<error/>');
  expect(parse(xmlError, file)).toBeNull();
  const unreadable = artifacts('0', `1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`, '');
  rmSync(`${unreadable}.log`);
  mkdirSync(`${unreadable}.log`);
  expect(parse(unreadable, file)).toBeNull();
  const unclosed = artifacts('0', `1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`, '');
  writeFileSync(`${unclosed}.junit.xml`, `<testsuites tests="1"><testsuite file="${file}"><testcase name="works" file="${file}"></testsuite></testsuites>`);
  stampSource(unclosed);
  bind(unclosed, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(unclosed, file)).toBeNull();
  const unclosedOutput = artifacts('0', `1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`, '<system-out>truncated');
  bind(unclosedOutput, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(unclosedOutput, file)).toBeNull();
  const declaredSkip = artifacts('0', `1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`, '');
  writeFileSync(`${declaredSkip}.junit.xml`, `<testsuites tests="1" failures="0" skipped="1"><testsuite file="${file}" tests="1"><testcase name="works" file="${file}"/></testsuite></testsuites>`);
  stampSource(declaredSkip);
  bind(declaredSkip, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(declaredSkip, file)).toBeNull();
  const declaredFailure = artifacts('0', `1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`, '');
  writeFileSync(`${declaredFailure}.junit.xml`, `<testsuites tests="1" failures="1"><testsuite file="${file}" tests="1"><testcase name="works" file="${file}"/></testsuite></testsuites>`);
  stampSource(declaredFailure);
  bind(declaredFailure, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(declaredFailure, file)).toBeNull();
});

test('legacy 0.2.29 Job bytes need a new bound manifest before they can prove a shadow reference', () => {
  // Captured from 0.2.29 gate-logs/cut/pod-9-c6-file-11 at 2026-10-15 13:49 KST.
  const prefix = join(import.meta.dir, 'fixtures/warm-job-029/sample');
  const capturedFile = 'src/chat/tool-render/dispatch.test.ts';
  const expected = { cutSha: '508f84ebf6d490c6e4f62ecda76bffb7873e4454', attemptId: '5763085b-b4ba-40a3-87ce-0de799224d5d' };
  expect(parse(prefix, capturedFile, expected)).toBeNull();
  const dir = mkdtempSync(join(tmpdir(), 'warm-job-bound-'));
  dirs.push(dir);
  const bound = join(dir, 'sample');
  for (const suffix of ['json', 'log', 'junit.xml']) copyFileSync(`${prefix}.${suffix}`, `${bound}.${suffix}`);
  writeFileSync(`${bound}.rc`, String(JSON.parse(readFileSync(`${bound}.json`, 'utf8')).rc));
  bind(bound, capturedFile, expected.cutSha, expected.attemptId);
  // The historical --dots log lacks test names, so a later manifest cannot
  // establish the one-to-one identity of the successful JUnit cases.
  expect(parse(bound, capturedFile, expected)).toBeNull();
  expect(parse(bound, capturedFile, { ...expected, cutSha: 'other' })).toBeNull();
  const conflicting = artifacts('0', `1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`, '');
  writeFileSync(`${conflicting}.json`, JSON.stringify({ rc: 0, files: [file], commit: expected.cutSha,
    attemptId: expected.attemptId, jobExitCode: 0, jobFailed: true }));
  expect(parse(conflicting, file, expected)).toBeNull();
});

test('mixing same-file same-count artifacts from another attempt is unmeasured', () => {
  const first = artifacts('0', `1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`, '');
  const second = artifacts('0', `1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n# other attempt`, '');
  const expected = { cutSha: 'a'.repeat(40), attemptId: 'attempt-1' };
  writeFileSync(`${first}.json`, JSON.stringify({ rc: 0, files: [file], commit: expected.cutSha,
    attemptId: expected.attemptId, jobExitCode: 0, jobFailed: false }));
  bind(first, file, expected.cutSha, expected.attemptId);
  expect(parse(first, file, expected)?.rc).toBe(0);
  copyFileSync(`${second}.log`, `${first}.log`);
  expect(parse(first, file, expected)).toBeNull();
});

test('pre-bound same-count failure log and JUnit from different attempts cannot mix', () => {
  const log = (name: string) => `${file}:\nerror: ${name === 'works' ? 'first' : 'second'}\n(fail) ${name}\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`;
  const first = artifacts('1', log('works'), '<failure message="first"/>');
  const second = artifacts('1', log('other'), '<failure message="second"/>');
  writeFileSync(`${second}.junit.xml`, readFileSync(`${second}.junit.xml`, 'utf8').replace('name="works"', 'name="other"'));
  stampSource(second);
  bind(second, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(first, file)?.failureIds).toEqual([`${file} > works`]);
  expect(parse(second, file)?.failureIds).toEqual([`${file} > other`]);
  // The attacker binds after mixing, so hash checks alone would accept this set.
  copyFileSync(`${second}.log`, `${first}.log`);
  bind(first, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(first, file)).toBeNull();
});

test('same failure name with a different cause cannot be rebound after mixing', () => {
  const log = (cause: string) => `${file}:\nerror: ${cause}\n(fail) works\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`;
  const first = artifacts('1', log('first'), '<failure message="first"/>');
  const second = artifacts('1', log('second'), '<failure message="second"/>');
  expect(parse(first, file)?.failureIds).toEqual([`${file} > works`]);
  expect(parse(second, file)?.failureIds).toEqual([`${file} > works`]);
  copyFileSync(`${second}.junit.xml`, `${first}.junit.xml`);
  bind(first, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(first, file)).toBeNull();
});

test('a fresh host manifest cannot rebind another exception type or stack location', () => {
  const log = `${file}:\nerror: boom\n(fail) works\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`;
  const first = artifacts('1', log, '<failure type="Error" message="boom">Error: boom&#10; at src/example/worker.test.ts:2:3</failure>');
  const second = artifacts('1', log, '<failure type="TypeError" message="boom">TypeError: boom&#10; at src/example/worker.test.ts:8:9</failure>');
  expect(parse(first, file)?.failureIds).toEqual([`${file} > works`]);
  expect(parse(second, file)?.failureIds).toEqual([`${file} > works`]);
  copyFileSync(`${second}.junit.xml`, `${first}.junit.xml`);
  bind(first, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(first, file)).toBeNull();
});

test('a failed Job without a source-side JUnit digest is unmeasured', () => {
  const prefix = artifacts('1', `${file}:\nerror: boom\n(fail) works\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`, '<failure message="boom"/>');
  writeFileSync(`${prefix}.log`, readFileSync(`${prefix}.log`, 'utf8').replace(/\n\[warm-worker\] junit-sha256=[0-9a-f]{64}\s*$/, ''));
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(prefix, file)).toBeNull();
});

test('out-of-range and surrogate XML entities are unmeasured without throwing', () => {
  for (const entity of ['&#x110000;', '&#xD800;', '&#0;']) {
    const prefix = artifacts('1', `${file}:\nerror: boom\n(fail) works\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`, `<failure message="${entity}"/>`);
    expect(() => parse(prefix, file)).not.toThrow();
    expect(parse(prefix, file)).toBeNull();
  }
});

test('CDATA that resembles a testcase cannot become a measured case', () => {
  const prefix = artifacts('1', `${file}:\nerror: boom\n(fail) works\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`,
    `<failure message="boom"><![CDATA[<testcase name="ghost" file="${file}"/>]]></failure>`);
  expect(parse(prefix, file)).toBeNull();
});

test('CDATA that resembles a second failure cannot replace the real diagnostic', () => {
  const prefix = artifacts('1', `${file}:\nerror: boom\n(fail) works\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`,
    '<failure message="different"><![CDATA[<failure message="boom"/>]]></failure>');
  expect(parse(prefix, file)).toBeNull();
});

test('a literal testcase in a real failure diagnostic is text, not another case', () => {
  const diagnostic = 'boom <testcase name="ghost"/>';
  const prefix = artifacts('1', `${file}:\nerror: ${diagnostic}\n(fail) works\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`,
    '<failure type="Error" message="boom &lt;testcase name=&quot;ghost&quot;/&gt;"><![CDATA[Error: boom <testcase name="ghost"/>]]></failure>');
  expect(parse(prefix, file)).toEqual({ file, rc: 1, failureIds: [`${file} > works`], errorIds: [], junitComplete: true });
});

test('a shared failure-message prefix cannot bind another cause', () => {
  const prefix = artifacts('1', `${file}:\nerror: missing manager\n(fail) works\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`,
    '<failure message="missing man"/>');
  expect(parse(prefix, file)).toBeNull();
});

test('a captured Bun multiline assertion binds its complete log and JUnit failure', () => {
  // Captured by scripts/test-deterministic.ts with Bun 1.4.2 on 2026-10-16.
  // The intentionally failing source was removed after capture.
  const capturedFile = 'scripts/release-loop/.warm-failure-verify.test.ts';
  const source = join(import.meta.dir, 'fixtures/warm-failure-assertion/sample');
  const dir = mkdtempSync(join(tmpdir(), 'warm-real-failure-'));
  dirs.push(dir);
  const prefix = join(dir, 'sample');
  copyFileSync(`${source}.log`, `${prefix}.log`);
  copyFileSync(`${source}.junit.xml`, `${prefix}.junit.xml`);
  writeFileSync(`${prefix}.log`, readFileSync(`${prefix}.log`, 'utf8').replace('[warm-worker] file=', `[warm-worker] cut=${defaultExpected.cutSha} attempt=${defaultExpected.attemptId}\n[warm-worker] file=`));
  stampSource(prefix);
  writeFileSync(`${prefix}.rc`, '1');
  writeFileSync(`${prefix}.json`, JSON.stringify({ rc: 1, files: [capturedFile], commit: defaultExpected.cutSha,
    attemptId: defaultExpected.attemptId, jobExitCode: 0, jobFailed: false }));
  expect(writeWarmJobManifest(prefix, capturedFile, defaultExpected.cutSha, defaultExpected.attemptId)).toBe(true);
  expect(parse(prefix, capturedFile)).toEqual({ file: capturedFile, rc: 1,
    failureIds: [`${capturedFile} > real multiline assertion`], errorIds: [], junitComplete: true });
});

test('matching failure message with a different JUnit body stays unmeasured', () => {
  const prefix = artifacts('1', `${file}:\nerror: root cause\n(fail) works\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`,
    '<failure type="Error" message="root cause">Error: another cause</failure>');
  expect(parse(prefix, file)).toBeNull();
});

test('artifact hashes bind original bytes even when invalid UTF-8 decodes alike', () => {
  const prefix = artifacts('0', '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.', '');
  const source = readFileSync(`${prefix}.log`);
  writeFileSync(`${prefix}.log`, Buffer.concat([source, Buffer.from([0xff])]));
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  writeFileSync(`${prefix}.log`, Buffer.concat([source, Buffer.from([0xfe])]));
  expect(parse(prefix, file)).toBeNull();
});

test('an unrelated mention of another failure message cannot bind a mixed JUnit', () => {
  const prefix = artifacts('1', `${file}:\nsecond\nerror: first\n(fail) works\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.`,
    '<failure message="first"/>');
  expect(parse(prefix, file)?.failureIds).toEqual([`${file} > works`]);
  writeFileSync(`${prefix}.junit.xml`, readFileSync(`${prefix}.junit.xml`, 'utf8').replace('message="first"', 'message="second"'));
  stampSource(prefix);
  bind(prefix, file, defaultExpected.cutSha, defaultExpected.attemptId);
  expect(parse(prefix, file)).toBeNull();
});

test('changing metadata after binding makes the whole artifact unmeasured', () => {
  const prefix = artifacts('0', `1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.`, '');
  const expected = { cutSha: 'a'.repeat(40), attemptId: 'attempt-1' };
  writeFileSync(`${prefix}.json`, JSON.stringify({ rc: 0, files: [file], commit: expected.cutSha,
    attemptId: expected.attemptId, jobExitCode: 0, jobFailed: false }));
  bind(prefix, file, expected.cutSha, expected.attemptId);
  expect(parse(prefix, file, expected)?.rc).toBe(0);
  writeFileSync(`${prefix}.json`, JSON.stringify({ rc: 0, files: [file], commit: expected.cutSha,
    attemptId: expected.attemptId, jobExitCode: 0, jobFailed: false, extra: 'changed' }));
  expect(parse(prefix, file, expected)).toBeNull();
});

test('missing or changed rc and absent expected identity cannot become a reference', () => {
  const prefix = artifacts('0', `1 pass\n0 fail\nRan 1 test across 1 file.`, '');
  expect(parse(prefix, file)?.junitComplete).toBe(true);
  expect(warmReferenceFromJobArtifacts(prefix, file, undefined as never)).toBeNull();
  writeFileSync(`${prefix}.rc`, '1');
  expect(parse(prefix, file)).toBeNull();
  writeFileSync(`${prefix}.rc`, '0');
  rmSync(`${prefix}.rc`);
  expect(parse(prefix, file)).toBeNull();
});

test('unhandled errors without a second diagnostic channel remain unmeasured', () => {
  const log = (detail: string) => `${file}:\n# Unhandled error between tests\n---\nerror: ${detail}\n---\n1 pass\n0 fail\n1 errors\nRan 1 test across 1 file.`;
  expect(parse(artifacts('1', log('missing provider'), ''), file)).toBeNull();
  expect(parse(artifacts('1', log('missing man'), ''), file)).toBeNull();
  const noDetail = artifacts('1', `${file}:\n# Unhandled error between tests\n---\n1 pass\n0 fail\n1 errors\nRan 1 test across 1 file.`, '');
  expect(parse(noDetail, file)).toBeNull();
});

