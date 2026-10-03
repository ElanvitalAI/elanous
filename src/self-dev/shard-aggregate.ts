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
}

export interface GateShardAggregate {
  status: 'passed' | 'failed' | 'unmeasured';
  /** Only these shard identities need another assignment; completed siblings stay intact. */
  retryShardIds: string[];
  report?: GateBaselineReport;
}

interface JUnitCase { file: string; name: string; failure?: string }

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
        if (child.children.some((c) => c.name === 'skipped')) return undefined;
        const classname = child.attrs.classname;
        const name = classname && classname !== caseFile ? `${classname} > ${leaf}` : leaf;
        const identity = `${caseFile}\u0000${name}`;
        if (executed.has(identity)) return undefined;
        executed.add(identity);
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
  for (const shard of shards) {
    const attempt = selected.get(shard.id);
    const head = attempt?.currentJUnit === undefined ? undefined : readJUnit(attempt.currentJUnit, shard.files);
    const base = attempt?.baselineJUnit === undefined ? undefined : readJUnit(attempt.baselineJUnit, shard.files);
    if (!attempt || attempt.currentExitCode === null || attempt.baselineExitCode === null
      || attempt.currentSignal || attempt.baselineSignal
      || ![0, 1].includes(attempt.currentExitCode) || ![0, 1].includes(attempt.baselineExitCode)
      || !head || !base
      || (attempt.currentExitCode === 0 && head.some((test) => test.failure !== undefined))
      || (attempt.baselineExitCode === 0 && base.some((test) => test.failure !== undefined))
      || (attempt.currentExitCode !== 0 && head.every((test) => test.failure === undefined))
      || (attempt.baselineExitCode !== 0 && base.every((test) => test.failure === undefined))) {
      retryShardIds.push(shard.id);
      continue;
    }
    current.push(...head);
    baseline.push(...base);
  }
  if (retryShardIds.length > 0 || shards.length === 0) return { status: 'unmeasured', retryShardIds };
  if (current.every((test) => test.failure === undefined)) return { status: 'passed', retryShardIds: [] };
  const passedTestEvidence: GatePassedTestEvidence = {
    status: 'available',
    tests: baseline.filter((test) => test.failure === undefined).map(({ file, name }) => ({ file, name: `${file} > ${name}` })),
  };
  const report = buildGateBaselineReport(asGateLog(current), {
    status: baseline.some((test) => test.failure !== undefined) ? 'test-fail' : 'pass',
    output: asGateLog(baseline),
    passedTestEvidence,
    log: 'shard baseline JUnit complete',
  });
  return { status: allowsBaselineOnlyFailure(report) ? 'passed' : 'failed', retryShardIds: [], report };
}
