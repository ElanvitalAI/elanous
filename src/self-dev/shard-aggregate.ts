import {
  allowsBaselineOnlyFailure,
  buildGateBaselineReport,
  type GateBaselineReport,
  type GatePassedTestEvidence,
} from '../self-implement/gate-baseline.js';
import type { GateTestShard } from './shard-plan.js';

export interface GateShardAttempt {
  shardId: string;
  attempt: number;
  /** A process death, missing report, or incomplete XML is not a test failure. */
  currentJUnit?: string;
  baselineJUnit?: string;
  currentExitCode: number | null;
  baselineExitCode: number | null;
  currentSignal?: string | null;
  baselineSignal?: string | null;
  /** LIGHT-RC-MEASURE — the shard files that exist in the baseline tree, i.e. what the baseline side actually ran.
   *  Absent = every shard file (the old shape). Empty = the baseline side was not run and contributes zero cases. */
  baselineFiles?: readonly string[];
}

export interface GateShardAggregate {
  status: 'passed' | 'failed' | 'unmeasured';
  /** Only these shard identities need another assignment; completed siblings stay intact. */
  retryShardIds: string[];
  report?: GateBaselineReport;
}

interface JUnitCase { file: string; name: string; failure?: string; skipped?: true }

const decode = (text: string): string => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, key: string) => {
  if (key[0] === '#') {
    const code = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  }
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[key.toLowerCase()] ?? entity;
});

interface XmlElement { name: string; attrs: Record<string, string>; children: XmlElement[]; text: string }

/** Strict, dependency-free XML reader for JUnit reports: the whole document must be well formed
 *  (one root, balanced tags, nothing but whitespace/comments after the root). CDATA and comments are
 *  text, never elements — so a `<testcase>` inside a failure message is not a test case, and a report
 *  followed by a truncated tail is rejected as unmeasured rather than read as complete. */
function parseXml(xml: string): XmlElement | undefined {
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const appendText = (text: string): boolean => {
    const top = stack.at(-1);
    if (!top) return text.trim() === '';
    top.text += text;
    return true;
  };
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) return appendText(xml.slice(i)) && !stack.length && root ? root : undefined;
    if (lt > i) {
      const raw = xml.slice(i, lt);
      if (!appendText(decode(raw))) return undefined;
      if (/&(?!(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);)/i.test(raw)) return undefined;
    }
    if (xml.startsWith('<!--', lt)) {
      const close = xml.indexOf('-->', lt + 4);
      if (close === -1) return undefined;
      i = close + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const close = xml.indexOf(']]>', lt + 9);
      if (close === -1 || !stack.length) return undefined;
      appendText(xml.slice(lt + 9, close));
      i = close + 3;
    } else if (xml.startsWith('<?', lt)) {
      const close = xml.indexOf('?>', lt + 2);
      if (close === -1 || stack.length || root) return undefined;
      i = close + 2;
    } else if (xml.startsWith('<!', lt)) {
      return undefined;
    } else {
      let j = lt + 1;
      let quote: string | undefined;
      for (; j < xml.length; j++) {
        const ch = xml[j]!;
        if (quote) { if (ch === quote) quote = undefined; else if (ch === '<') return undefined; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
        else if (ch === '<') return undefined;
      }
      if (j >= xml.length) return undefined;
      const inner = xml.slice(lt + 1, j);
      i = j + 1;
      if (inner.startsWith('/')) {
        const name = inner.slice(1).trim();
        const open = stack.pop();
        if (!open || open.name !== name) return undefined;
        if (!stack.length) root = open;
        continue;
      }
      const selfClosing = inner.endsWith('/');
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const head = /^([A-Za-z_][\w.:-]*)/.exec(body);
      if (!head || (!stack.length && root)) return undefined;
      const attrs: Record<string, string> = {};
      let rest = body.slice(head[1]!.length);
      const attrPattern = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/;
      for (let m = attrPattern.exec(rest); m; m = attrPattern.exec(rest)) {
        if (m[1]! in attrs) return undefined;
        attrs[m[1]!] = decode(m[2] ?? m[3] ?? '');
        rest = rest.slice(m[0].length);
      }
      if (rest.trim() !== '') return undefined;
      const element: XmlElement = { name: head[1]!, attrs, children: [], text: '' };
      stack.at(-1)?.children.push(element);
      if (selfClosing) { if (!stack.length) root = element; }
      else stack.push(element);
    }
  }
  return !stack.length && root ? root : undefined;
}

function textOf(element: XmlElement): string {
  return element.text + element.children.map(textOf).join('');
}

function readJUnit(xml: string, files: readonly string[]): JUnitCase[] | undefined {
  const root = parseXml(xml);
  if (!root || (root.name !== 'testsuites' && root.name !== 'testsuite')) return undefined;
  const expected = new Set(files);
  if (expected.size === 0) return undefined;
  const cases: JUnitCase[] = [];
  const counts = new Map<string, number>();
  const executed = new Set<string>();
  const occurrences = new Map<string, number>();
  let failures = 0;
  let errors = 0;
  const matchesCount = (value: string | undefined, actual: number) => value === undefined
    || (/^(0|[1-9]\d*)$/.test(value) && Number(value) === actual);
  // Each suite's tests attribute covers its descendants too: compare subtree totals.
  const walkSuite = (suite: XmlElement, parentFile: string | undefined): { tests: number; failures: number; errors: number } | undefined => {
    const file = suite.attrs.file ?? parentFile;
    const declared = Number(suite.attrs.tests);
    if ((file && !expected.has(file)) || !Number.isSafeInteger(declared) || declared < 0) return undefined;
    const total = { tests: 0, failures: 0, errors: 0 };
    for (const child of suite.children) {
      if (child.name === 'testsuite') {
        const sub = walkSuite(child, file);
        if (!sub) return undefined;
        total.tests += sub.tests; total.failures += sub.failures; total.errors += sub.errors;
      } else if (child.name === 'testcase') {
        const caseFile = child.attrs.file ?? file;
        const leaf = child.attrs.name;
        if (!caseFile || !expected.has(caseFile) || !leaf || (file && file !== caseFile)) return undefined;
        total.tests++;
        counts.set(caseFile, (counts.get(caseFile) ?? 0) + 1);
        // A skipped case is neither a pass nor a failure; it no longer voids the shard (LIGHT-RC-MEASURE ②).
        const skipped = child.children.some((c) => c.name === 'skipped');
        const classname = child.attrs.classname;
        const declaredName = classname && classname !== caseFile ? `${classname} > ${leaf}` : leaf;
        // Bun emits one name for every `test.each` row and for same-named cases in one describe; such repeats are
        // told apart by their order in the file (#2, #3 …) on both sides instead of voiding the shard (LIGHT-RC-MEASURE).
        const declaredIdentity = `${caseFile}\u0000${declaredName}`;
        const ordinal = (occurrences.get(declaredIdentity) ?? 0) + 1;
        occurrences.set(declaredIdentity, ordinal);
        const name = ordinal === 1 ? declaredName : `${declaredName} #${ordinal}`;
        const identity = `${caseFile}\u0000${name}`;
        if (executed.has(identity)) return undefined;
        executed.add(identity);
        if (skipped) { cases.push({ file: caseFile, name, skipped: true }); continue; }
        const failure = child.children.find((c) => c.name === 'failure' || c.name === 'error');
        if (failure?.name === 'failure') { failures++; total.failures++; }
        else if (failure) { errors++; total.errors++; }
        const diagnostic = failure ? [failure.attrs.message, textOf(failure).trim()].filter(Boolean).join('\n') : undefined;
        cases.push({ file: caseFile, name, ...(failure ? { failure: diagnostic || 'JUnit test failed' } : {}) });
      }
    }
    if (total.tests !== declared || !matchesCount(suite.attrs.failures, total.failures) || !matchesCount(suite.attrs.errors, total.errors)) return undefined;
    return total;
  };
  const suites = root.name === 'testsuite' ? [root] : root.children.filter((c) => c.name === 'testsuite');
  if (suites.length === 0 || (root.name === 'testsuites' && root.children.some((c) => c.name === 'testcase'))) return undefined;
  let counted = 0;
  for (const suite of suites) {
    const total = walkSuite(suite, undefined);
    if (!total) return undefined;
    counted += total.tests;
  }
  if (root.name === 'testsuites' && (!matchesCount(root.attrs.tests, counted)
    || !matchesCount(root.attrs.failures, failures) || !matchesCount(root.attrs.errors, errors))) return undefined;
  if (cases.length === 0 || [...expected].some((file) => !counts.has(file))) return undefined;
  return cases;
}

const SKIPPED_PASSED_AT_BASE = 'skipped now · passed at base — a skip must not hide a regression (LIGHT-RC-MEASURE ②)';

/** Cases that passed at the baseline but were skipped now are counted as `unknown` failures — never green. */
function withSkippedRegressions(report: GateBaselineReport | undefined, skipped: readonly JUnitCase[], baselineStatus: GateBaselineReport['baselineStatus']): GateBaselineReport {
  const base: GateBaselineReport = report ?? {
    introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 0, missingAtBase: 0, timedOut: 0, timeoutPassedAtBase: 0,
    flakyRerun: 0, rerunNotRun: 0, mayVaryNonTimeout: 0, rerunAttempted: 0, rerunRecovered: 0,
    timeoutVariabilityCounts: { mayVary: 0, same: 0, unknown: 0 }, worktreeFailuresParsed: true,
    failures: [], files: [], baselineStatus, log: 'shard baseline JUnit complete',
  };
  // An unknown failure means the child is not exonerated: `childResponsibility: 'none'` only holds when every remaining
  // failure is flaky/preexisting (decideGateChildResponsibility), which an added unknown breaks.
  const { childResponsibility: _dropped, ...rest } = base;
  const added = skipped.map(({ file, name }) => ({
    name: `${file} > ${name}`, file, diagnostic: SKIPPED_PASSED_AT_BASE, attribution: 'unknown' as const, baselinePresence: 'present' as const,
  }));
  return {
    ...rest,
    unknown: base.unknown + added.length,
    failures: [...base.failures, ...added],
    files: [...new Set([...base.files, ...added.map((failure) => failure.file)])],
  };
}

function asGateLog(cases: readonly JUnitCase[]): string {
  return cases.map(({ file, name, failure }) => `${file}:\n${failure === undefined ? `(pass) ${name}` : `${failure}\n(fail) ${name}`}`).join('\n');
}

/** Select the latest complete attempt per shard, then classify the union with the existing full-suite gate ruler. */
export function aggregateGateTestShards(shards: readonly GateTestShard[], attempts: readonly GateShardAttempt[]): GateShardAggregate {
  const selected = new Map<string, GateShardAttempt>();
  for (const attempt of attempts) {
    if (!Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1) throw new Error('invalid shard attempt');
    if (!shards.some((shard) => shard.id === attempt.shardId)) throw new Error(`unknown shard: ${attempt.shardId}`);
    const prior = selected.get(attempt.shardId);
    if (prior?.attempt === attempt.attempt) throw new Error(`duplicate shard attempt: ${attempt.shardId}`);
    if (!prior || prior.attempt < attempt.attempt) selected.set(attempt.shardId, attempt);
  }
  const retryShardIds: string[] = [];
  const current: JUnitCase[] = [];
  const baseline: JUnitCase[] = [];
  const skippedRegressions: JUnitCase[] = [];
  for (const shard of shards) {
    const attempt = selected.get(shard.id);
    const head = attempt?.currentJUnit === undefined ? undefined : readJUnit(attempt.currentJUnit, shard.files);
    // LIGHT-RC-MEASURE ① — the baseline side reads only the files that exist in the baseline tree; none = not run.
    const baselineFiles = attempt?.baselineFiles ?? shard.files;
    const baselineSkipped = baselineFiles.length === 0;
    const base = baselineSkipped ? [] : attempt?.baselineJUnit === undefined ? undefined : readJUnit(attempt.baselineJUnit, baselineFiles);
    if (!attempt || attempt.currentExitCode === null || attempt.currentSignal
      || ![0, 1].includes(attempt.currentExitCode)
      || baselineFiles.some((file) => !shard.files.includes(file))
      || (!baselineSkipped && (attempt.baselineExitCode === null || attempt.baselineSignal || ![0, 1].includes(attempt.baselineExitCode)))
      || !head || !base
      || (attempt.currentExitCode === 0 && head.some((test) => test.failure !== undefined))
      || (!baselineSkipped && attempt.baselineExitCode === 0 && base.some((test) => test.failure !== undefined))
      || (attempt.currentExitCode !== 0 && head.every((test) => test.failure === undefined))
      || (!baselineSkipped && attempt.baselineExitCode !== 0 && base.every((test) => test.failure === undefined))) {
      retryShardIds.push(shard.id);
      continue;
    }
    current.push(...head.filter((test) => !test.skipped));
    baseline.push(...base.filter((test) => !test.skipped));
    const passedAtBase = new Set(base.filter((test) => !test.skipped && test.failure === undefined).map((test) => `${test.file}\u0000${test.name}`));
    skippedRegressions.push(...head.filter((test) => test.skipped && passedAtBase.has(`${test.file}\u0000${test.name}`)));
  }
  if (retryShardIds.length > 0 || shards.length === 0) return { status: 'unmeasured', retryShardIds };
  const baselineStatus = baseline.some((test) => test.failure !== undefined) ? 'test-fail' as const : 'pass' as const;
  if (current.every((test) => test.failure === undefined)) {
    if (skippedRegressions.length === 0) return { status: 'passed', retryShardIds: [] };
    return { status: 'failed', retryShardIds: [], report: withSkippedRegressions(undefined, skippedRegressions, baselineStatus) };
  }
  const passedTestEvidence: GatePassedTestEvidence = {
    status: 'available',
    tests: baseline.filter((test) => test.failure === undefined).map(({ file, name }) => ({ file, name: `${file} > ${name}` })),
  };
  const report = buildGateBaselineReport(asGateLog(current), {
    status: baselineStatus,
    output: asGateLog(baseline),
    passedTestEvidence,
    log: 'shard baseline JUnit complete',
  });
  if (skippedRegressions.length > 0) return { status: 'failed', retryShardIds: [], report: withSkippedRegressions(report, skippedRegressions, baselineStatus) };
  return { status: allowsBaselineOnlyFailure(report) ? 'passed' : 'failed', retryShardIds: [], report };
}
