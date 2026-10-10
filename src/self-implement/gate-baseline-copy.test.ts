import { describe, expect, test } from 'bun:test';
import { allowsBaselineOnlyFailure, buildGateBaselineReport, classifyGateTestFailures } from './gate-baseline.js';
import { applyReworkBudgetDecision } from './rework-policy.js';
import { debug } from '../debug/log.js';

const original = 'src/x/pod.test.ts';
const copy = 'src/x/pod-copy.test.ts';
const names = ['first', 'second', 'third'];
const diagnostic = (file: string, name: string, value = 'expected 1 to be 2') =>
  `error: ${value}\n    at ${file}:${name.length + 10}:3`;
const entries = (file: string, cases = names, altered?: string) => [
  `${file}:`,
  ...cases.flatMap((name) => [diagnostic(file, name, altered === name ? 'expected 1 to be 3' : undefined), `(fail) ${name}`]),
].join('\n');
const base = entries(original);
const current = (altered?: string) => `${entries(original)}\n${entries(copy, names, altered)}\n6 fail`;
const baseline = { status: 'test-fail' as const, output: base, log: 'base red', missingAtBase: [copy] };

describe('copied red test attribution', () => {
  test('three base-red tests copied to a new file count as six preexisting failures and emit one event per copy', () => {
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    const originalLog = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data });
    }) as typeof debug.log;
    try {
      const report = buildGateBaselineReport(current(), baseline);
      expect(report).toMatchObject({ introduced: 0, preexisting: 6, unknown: 0, missingAtBase: 3 });
      expect(allowsBaselineOnlyFailure(report)).toBe(true);
      expect(report.failures.filter(({ file }) => file === original).map(({ attribution }) => attribution)).toEqual(['preexisting', 'preexisting', 'preexisting']);
      expect(report.failures.filter(({ file }) => file === copy).map(({ attribution, attributedBy }) => [attribution, attributedBy]))
        .toEqual(names.map(() => ['preexisting', 'copied-across-files']));
      expect(events.filter(({ event }) => event === 'attributed-copy-across-files')).toEqual(names.map((name) => ({
        category: 'self-implement.gate', event: 'attributed-copy-across-files', data: { name, file: copy, baselineFile: original },
      })));
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('one changed assertion in the copy is introduced, while the other five remain preexisting', () => {
    const report = buildGateBaselineReport(current('second'), baseline);
    expect(report).toMatchObject({ introduced: 1, preexisting: 5 });
    expect(report.failures.find(({ name }) => name === `${copy} > second`)).toMatchObject({ attribution: 'introduced' });
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
  });

  test('without a failing original, the missing-file copy stays introduced and emits no copy event', () => {
    const events: string[] = [];
    const originalLog = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event) => { events.push(event); }) as typeof debug.log;
    try {
      expect(classifyGateTestFailures(entries(copy, ['first']), base, [copy]))
        .toMatchObject([{ attribution: 'introduced', baselinePresence: 'missing' }]);
      expect(events).not.toContain('attributed-copy-across-files');
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('two baseline failures of the same path and duplicate new-file failures cannot be attributed as copies', () => {
    const twiceAtBase = `${base}\n${entries('src/x/other.test.ts', ['first'])}`;
    expect(classifyGateTestFailures(`${entries(original, ['first'])}\n${entries(copy, ['first'])}`, twiceAtBase, [copy]).at(-1))
      .toMatchObject({ attribution: 'introduced' });
    expect(classifyGateTestFailures(`${entries(original, ['first'])}\n${entries(copy, ['first', 'first'])}`, entries(original, ['first']), [copy]).slice(-2))
      .toMatchObject([{ attribution: 'introduced' }, { attribution: 'introduced' }]);
  });

  test('matching position tokens are removed but other numeric diagnostic values are not', () => {
    const baseDiagnostic = `${original}:\nerror: expected src/x/value.ts:12:3 to equal 2\n    at ${original}:10:3\n(fail) first`;
    const currentOriginal = `${original}:\nerror: expected src/x/value.ts:12:3 to equal 2\n    at ${original}:10:3\n(fail) first`;
    const same = `${copy}:\nerror: expected src/x/value.ts:99:7 to equal 2\n    at ${copy}:20:3\n(fail) first`;
    const changed = `${copy}:\nerror: expected src/x/value.ts:99:7 to equal 3\n    at ${copy}:20:3\n(fail) first`;
    expect(classifyGateTestFailures(`${currentOriginal}\n${same}`, baseDiagnostic, [copy]).at(-1))
      .toMatchObject({ attribution: 'preexisting', attributedBy: 'copied-across-files' });
    expect(classifyGateTestFailures(`${currentOriginal}\n${changed}`, baseDiagnostic, [copy]).at(-1))
      .toMatchObject({ attribution: 'introduced' });
  });

  test('file:// stack locations are position tokens too, so a copy that differs only there is preexisting', () => {
    const at = (file: string, loc: string) => `${file}:\nerror: expected 1 to be 2\n    at file:///repo/${loc}\n(fail) first`;
    const baseFile = at(original, `${original}:10:3`);
    const copied = at(copy, `${copy}:20:3`);
    expect(classifyGateTestFailures(`${baseFile}\n${copied}`, baseFile, [copy]).at(-1))
      .toMatchObject({ attribution: 'preexisting', attributedBy: 'copied-across-files' });
    const windows = (file: string, loc: string) => `${file}:\nerror: expected 1 to be 2\n    at file:///C:/repo/${loc}\n(fail) first`;
    expect(classifyGateTestFailures(`${windows(original, `${original}:10:3`)}\n${windows(copy, `${copy}:20:3`)}`, windows(original, `${original}:10:3`), [copy]).at(-1))
      .toMatchObject({ attribution: 'preexisting', attributedBy: 'copied-across-files' });
  });

  test('position tokens are erased regardless of the file extension', () => {
    const at = (file: string, loc: string) => `${file}:\nerror: render failed\n    at ${loc}\n(fail) first`;
    const baseVue = at(original, 'src/x/a.vue:10:3');
    expect(classifyGateTestFailures(`${baseVue}\n${at(copy, 'src/x/b.vue:20:3')}`, baseVue, [copy]).at(-1))
      .toMatchObject({ attribution: 'preexisting', attributedBy: 'copied-across-files' });
  });

  test('URL host:port tokens are message content, so a copy whose URL differs stays introduced', () => {
    const at = (file: string, url: string, line: number) => `${file}:\nerror: fetch ${url} failed\n    at ${file}:${line}:3\n(fail) first`;
    const baseUrl = at(original, 'https://a.example.com:443:10', 10);
    const sameUrl = at(copy, 'https://a.example.com:443:10', 20);
    const otherHost = at(copy, 'https://b.example.org:443:10', 20);
    expect(classifyGateTestFailures(`${baseUrl}\n${sameUrl}`, baseUrl, [copy]).at(-1))
      .toMatchObject({ attribution: 'preexisting', attributedBy: 'copied-across-files' });
    expect(classifyGateTestFailures(`${baseUrl}\n${otherHost}`, baseUrl, [copy]).at(-1))
      .toMatchObject({ attribution: 'introduced' });
  });

  test('timeout and unmet precondition diagnostics are not attributed to a copy', () => {
    const timeout = `${copy}:\n(fail) first\n^ this test timed out after 5000ms`;
    expect(classifyGateTestFailures(`${entries(original, ['first'])}\n${timeout}`, entries(original, ['first']), [copy]).at(-1))
      .toMatchObject({ attribution: 'flaky-timeout' });
    const precondition = `${copy}:\nerror: Isolated instance requires an explicit tool cwd; set ELANOUS_TOOL_CWD.\n(fail) first`;
    expect(classifyGateTestFailures(`${entries(original, ['first'])}\n${precondition}`, entries(original, ['first']), [copy]).at(-1))
      .toMatchObject({ attribution: 'precondition-unmet' });
  });

  test('gate SUFFICIENT proceeds only on an explicitly baseline-only gate; shadowStop mirrors review', () => {
    const verdict = { verdict: 'SUFFICIENT' as const, reason: 'base only' };
    expect(applyReworkBudgetDecision(2, verdict, 5, 'gate', 1, false, undefined, true))
      .toEqual({ effectiveMax: 2, stop: true, exit: 'proceed', applied: true });
    expect(applyReworkBudgetDecision(2, verdict, 5, 'gate', 1, false, undefined, false))
      .toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false });
    expect(applyReworkBudgetDecision(2, verdict, 5, 'gate', 1, true, undefined, true))
      .toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false, shadowed: true, wouldExit: 'proceed' });
  });
});
