import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { parseFailures } from './gate-diff.js';
import { isCompleteOneFileGateJunit, parseXml, type XmlElement } from '../../src/self-dev/shard-aggregate.js';
import type { WarmWorkerFileResult } from '../../src/task-orchestrator/surfaces/pod-warm-worker-protocol.js';

const relative = (path: string) => path.replace(/^(?:\.\.\/)*\/?home\/ubuntu\/repo\//, '').replace(/^\.\//, '');
const lastCount = (log: string, name: string): number | null => {
  let count: number | null = null;
  for (const match of log.matchAll(new RegExp(`(?:^|\\n)\\s*(\\d+) ${name}s?\\s*(?=\\n|$)`, 'g'))) count = Number(match[1]);
  return count;
};
const validXmlCodePoint = (code: number): boolean => Number.isSafeInteger(code)
  && (code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff
    || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff);
const numericXmlEntitiesValid = (value: string): boolean => [...value.matchAll(/&#(x[0-9a-fA-F]+|[0-9]+);/g)]
  .every((match) => validXmlCodePoint(match[1]!.startsWith('x') ? parseInt(match[1]!.slice(1), 16) : parseInt(match[1]!, 10)));
const xmlText = (value: string): string => value.replace(/&#(x[0-9a-fA-F]+|[0-9]+);|&(amp|lt|gt|quot|apos);/g, (match, numeric: string | undefined, named: string | undefined) => {
  if (numeric) {
    const code = numeric.startsWith('x') ? parseInt(numeric.slice(1), 16) : parseInt(numeric, 10);
    return validXmlCodePoint(code) ? String.fromCodePoint(code) : match;
  }
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[named ?? ''] ?? match;
});
const failureDetail = (value: string): string => xmlText(value).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r\n/g, '\n').trim();
function junitFailureDetails(xml: string): Map<string, string> {
  const details = new Map<string, string>();
  const root = parseXml(xml);
  if (!root) return details;
  const walkSuite = (suite: XmlElement, file: string, names: string[]): void => {
    const suiteFile = file || suite.attrs.file || suite.attrs.name || '';
    const nestedNames = file ? [...names, suite.attrs.name ?? ''] : names;
    for (const child of suite.children) {
      if (child.name === 'testsuite') { walkSuite(child, suiteFile, nestedNames); continue; }
      if (child.name !== 'testcase') continue;
      const id = `${relative(child.attrs.file ?? suiteFile)} > ${[...nestedNames, child.attrs.name ?? ''].join(' > ')}`;
      const failures = child.children.filter((element) => element.name === 'failure');
      // One log failure line cannot identify which of several JUnit failure
      // elements it belongs to. Leave the case unmeasured instead of allowing
      // a later element to overwrite an earlier, different diagnostic.
      if (failures.length > 1) { details.set(id, ''); continue; }
      for (const failure of failures) {
        const diagnostic = failure.attrs.message === undefined ? '' : failureDetail(failure.attrs.message);
        const bodyLines = failure.text.split(/\r?\n/);
        const stackAt = bodyLines.findIndex(line => /^\s*at\s/.test(line));
        const body = failureDetail((stackAt < 0 ? bodyLines : bodyLines.slice(0, stackAt)).join('\n')
          .replace(new RegExp(`^${(failure.attrs.type ?? 'Error').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[ \\t]*`), ''));
        details.set(id, body && body !== diagnostic ? '' : diagnostic);
      }
    }
  };
  if (root.name === 'testsuite') walkSuite(root, '', []);
  else if (root.name === 'testsuites') for (const suite of root.children) if (suite.name === 'testsuite') walkSuite(suite, '', []);
  return details;
}
function logFailureDetails(log: string): Map<string, string> | null {
  const details = new Map<string, string>();
  let file = '';
  let block: string[] = [];
  let errorCount = 0;
  let unboundError = false;
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^(?:\.\/)?((?:[\w.-]+\/)+[\w.-]+\.test\.tsx?):(?:\s|$)/.exec(line);
    if (header) { if (errorCount > 0) unboundError = true; file = relative(header[1]!); block = []; errorCount = 0; continue; }
    const failed = /\(fail\)\s+(.+?)(?:\s+\[[\d.]+(?:ms|s)\])?$/.exec(line);
    if (failed && file) {
      // Bun's JUnit message includes multiline assertion diffs but excludes
      // the stack. Compare the complete normalized diagnostic, never a prefix.
      const stackAt = block.findIndex(item => /^\s*at\s/.test(item));
      const diagnostic = stackAt < 0 ? block : block.slice(0, stackAt);
      details.set(`${file} > ${failed[1]!.trim()}`, errorCount === 1 ? failureDetail(diagnostic.join('\n')) : '');
      block = []; errorCount = 0;
      continue;
    }
    if (/^error:\s*/i.test(line)) { block = [raw.replace(/^\s*error:\s*/i, '')]; errorCount++; }
    else if (errorCount > 0 && !/^\(pass\)/.test(line)) block.push(raw);
    else if (/^\(pass\)/.test(line)) { if (errorCount > 0) unboundError = true; block = []; errorCount = 0; }
  }
  // An error after the last named failure has no JUnit testcase to bind it.
  // Bun can omit the numeric `errors` summary, so the open diagnostic itself
  // must make the reference unmeasured.
  return unboundError || errorCount > 0 ? null : details;
}
function junitCases(root: XmlElement): Array<{ file: string; id: string; failed: boolean; error: boolean; skipped: boolean }> {
  const cases: Array<{ file: string; id: string; failed: boolean; error: boolean; skipped: boolean }> = [];
  const walkSuite = (suite: XmlElement, file: string, names: string[]): void => {
    const suiteFile = file || suite.attrs.file || suite.attrs.name || '';
    const nestedNames = file ? [...names, suite.attrs.name ?? ''] : names;
    for (const child of suite.children) {
      if (child.name === 'testsuite') { walkSuite(child, suiteFile, nestedNames); continue; }
      if (child.name !== 'testcase') continue;
      const caseFile = relative(child.attrs.file ?? suiteFile);
      cases.push({ file: caseFile, id: `${caseFile} > ${[...nestedNames, child.attrs.name ?? ''].join(' > ')}`,
        failed: child.children.some((element) => element.name === 'failure'),
        error: child.children.some((element) => element.name === 'error'),
        skipped: child.children.some((element) => element.name === 'skipped') });
    }
  };
  if (root.name === 'testsuite') walkSuite(root, '', []);
  else if (root.name === 'testsuites') for (const suite of root.children) if (suite.name === 'testsuite') walkSuite(suite, '', []);
  return cases;
}
function logPassIds(log: string): string[] {
  const ids: string[] = [];
  let file = '';
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^(?:\.\/)?((?:[\w.-]+\/)+[\w.-]+\.test\.tsx?):(?:\s|$)/.exec(line);
    if (header) { file = relative(header[1]!); continue; }
    const passed = /^\(pass\)\s+(.+?)(?:\s+\[[\d.]+(?:ms|s)\])?$/.exec(line);
    if (passed && file) ids.push(`${file} > ${passed[1]!.trim()}`);
  }
  return ids.sort();
}
const MAX_WARM_ARTIFACT_BYTES = 64 * 1024 * 1024;
const readMaybe = (path: string): Buffer | null => {
  try { return statSync(path).size <= MAX_WARM_ARTIFACT_BYTES ? readFileSync(path) : null; }
  catch { return null; }
};
const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

/** Bind a completed one-file Job's collected outbox to its host metadata. */
export function writeWarmJobManifest(prefix: string, file: string, cutSha: string, attemptId: string): boolean {
  const meta = readMaybe(`${prefix}.json`);
  const log = readMaybe(`${prefix}.log`);
  const junit = readMaybe(`${prefix}.junit.xml`);
  const rcBytes = readMaybe(`${prefix}.rc`);
  if (!meta || !log || !junit || !rcBytes || !file || !cutSha || !attemptId) return false;
  let row: Record<string, unknown>;
  try { row = JSON.parse(meta.toString('utf8')) as Record<string, unknown>; } catch { return false; }
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.commit !== cutSha
    || row.attemptId !== attemptId || !Array.isArray(row.files) || row.files.length !== 1 || row.files[0] !== file
    || (row.rc !== 0 && row.rc !== 1) || row.jobFailed !== false || row.jobExitCode !== 0
    || rcBytes.toString('utf8').trim() !== String(row.rc)) return false;
  writeFileSync(`${prefix}.warm-manifest.json`, JSON.stringify({ protocol: 1, cutSha, attemptId, file, rc: row.rc,
    logSha256: sha256(log), junitSha256: sha256(junit), metaSha256: sha256(meta), rcSha256: sha256(rcBytes) }) + '\n', { mode: 0o600 });
  return true;
}

/** Convert only a cut/attempt-bound, complete one-file artifact set. */
export function warmReferenceFromJobArtifacts(prefix: string, file: string, expected: { cutSha: string; attemptId: string }): WarmWorkerFileResult | null {
  if (!file || !expected?.cutSha || !expected?.attemptId
    || !existsSync(`${prefix}.log`)
    || !existsSync(`${prefix}.junit.xml`) || !existsSync(`${prefix}.json`)
    || !existsSync(`${prefix}.rc`) || !existsSync(`${prefix}.warm-manifest.json`)) return null;
  let rc: number;
  const metadata = readMaybe(`${prefix}.json`);
  if (metadata === null) return null;
  {
    let meta: unknown;
    try { meta = JSON.parse(metadata.toString('utf8')); } catch { return null; }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const row = meta as Record<string, unknown>;
    if ((row.rc !== 0 && row.rc !== 1) || row.jobFailed !== false || row.jobExitCode !== 0
      || !Array.isArray(row.files) || row.files.length !== 1 || row.files[0] !== file
      || row.commit !== expected.cutSha || row.attemptId !== expected.attemptId) return null;
    rc = row.rc;
  }
  const logBytes = readMaybe(`${prefix}.log`);
  const xmlBytes = readMaybe(`${prefix}.junit.xml`);
  const rcBytes = readMaybe(`${prefix}.rc`);
  if (logBytes === null || xmlBytes === null || rcBytes === null || rcBytes.toString('utf8').trim() !== String(rc)) return null;
  {
    let manifest: unknown;
    try { manifest = JSON.parse(readMaybe(`${prefix}.warm-manifest.json`)?.toString('utf8') ?? ''); } catch { return null; }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
    const bound = manifest as Record<string, unknown>;
    if (bound.protocol !== 1 || bound.cutSha !== expected.cutSha || bound.attemptId !== expected.attemptId
      || bound.file !== file || bound.rc !== rc || bound.logSha256 !== sha256(logBytes)
      || bound.junitSha256 !== sha256(xmlBytes) || bound.metaSha256 !== sha256(metadata)
      || bound.rcSha256 !== sha256(rcBytes)) return null;
  }
  const log = logBytes.toString('utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const xml = xmlBytes.toString('utf8');
  if (!numericXmlEntitiesValid(xml)) return null;
  const sourceBindings = [...log.matchAll(/^\[warm-worker\] cut=([^\s]+) attempt=([^\s]+)$/gm)];
  if (sourceBindings.length !== 1 || sourceBindings[0]![1] !== expected.cutSha
    || sourceBindings[0]![2] !== expected.attemptId
    || sourceBindings[0]!.index! > log.indexOf('bun test v')) return null;
  // The one-file shell writes the JUnit digest into its log before collection.
  // A new host manifest cannot legitimize a JUnit from another Job whose
  // message matches but exception type or stack location differs.
  const junitBindings = [...log.matchAll(/^\[warm-worker\] junit-sha256=([0-9a-f]{64})$/gm)];
  if (junitBindings.length !== 1 || junitBindings[0]![1] !== sha256(xmlBytes)) return null;
  // Bind the run command to the requested file before comparing result names.
  // Legacy one-shot Jobs record the wrapper invocation; the resident worker
  // writes a dedicated header.
  const workerSources = [...log.matchAll(/^\[warm-worker\] file=([^\s]+)$/gm)].map(match => match[1]);
  const jobSources = [...log.matchAll(/^\$ bun run scripts\/test-deterministic\.ts[^\n]*$/gm)].map(match => match[0]);
  const bunSources = [...log.matchAll(/^(?:\.\/)?([A-Za-z0-9_./-]+\.test\.tsx?):(?:\r?\n|$)/gm)].map(match => relative(match[1]!));
  const escapedFile = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const invokedFile = jobSources[0] && new RegExp(`(?:^|[\\s"'])(?:\\.\\/)?${escapedFile}(?=$|[\\s"'])`).test(jobSources[0]);
  if (workerSources.length > 1 || jobSources.length > 1
    || (workerSources.length === 1 && workerSources[0] !== file)
    || (jobSources.length === 1 && !invokedFile)
    || (workerSources.length === 1 && (bunSources.length !== 1 || bunSources[0] !== file))
    || (jobSources.length === 1 && bunSources.some(source => source !== file))
    || (workerSources.length === 0 && jobSources.length === 0)) return null;
  const runStarts = [...log.matchAll(/(?:^|\n)bun test v[^\n]*/g)];
  const runSummaries = [...log.matchAll(/Ran (\d+) tests? across (\d+) files?/g)];
  if (runSummaries.length !== 1 || (existsSync(`${prefix}.json`) && runStarts.length !== 1)) return null;
  const root = parseXml(xml);
  const cases = root ? junitCases(root) : [];
  const declared = root ? Number(root.attrs.tests) : NaN;
  if (!root || !isCompleteOneFileGateJunit(xml, file) || !cases.length || !Number.isSafeInteger(declared) || declared !== cases.length
    || cases.some(item => item.file !== file || item.error || item.skipped)) return null;
  const failureIds = cases.filter(item => item.failed).map(item => item.id).sort();
  // Dots-only success logs lack test identities. A same-file, same-count
  // JUnit can then be rebound with a fresh manifest, so fail closed.
  {
    const allIds = cases.map(item => item.id).sort();
    // A duplicate name cannot identify which JUnit case matches which log
    // line, even when the counts and diagnostics happen to agree.
    if (new Set(allIds).size !== allIds.length) return null;
    const fromXml = allIds.filter(id => !failureIds.includes(id));
    const fromLog = logPassIds(log);
    if (fromXml.length !== cases.length - failureIds.length || fromLog.length !== fromXml.length
      || fromXml.some((id, index) => id !== fromLog[index])) return null;
  }
  // A manifest can be rebound after mixing two complete runs. Match each
  // failure's content, not only its test name, against the captured log.
  const xmlDetails = junitFailureDetails(xml);
  const logDetails = logFailureDetails(log);
  if (!logDetails || xmlDetails.size !== failureIds.length || logDetails.size !== failureIds.length
    || [...xmlDetails].some(([id, message]) => !message || logDetails.get(id) !== message)) return null;
  const loggedFailureIds = parseFailures(log).map(id => {
    const at = id.indexOf(' > ');
    return at < 0 ? id : `${relative(id.slice(0, at))}${id.slice(at)}`;
  });
  if (failureIds.length !== loggedFailureIds.length
    || failureIds.some(id => !loggedFailureIds.includes(id))) return null;
  const passes = lastCount(log, 'pass');
  const fails = lastCount(log, 'fail');
  // Bun omits the error counter entirely when it is zero.
  const errors = lastCount(log, 'error') ?? 0;
  const ran = runSummaries[0];
  const ranEnd = ran === undefined ? -1 : ran.index! + ran[0].length;
  const tail = ranEnd < 0 ? '' : log.slice(ranEnd);
  const runTail = junitBindings.length === 1
    ? tail.replace(/\s*\[warm-worker\] junit-sha256=[0-9a-f]{64}\s*$/, '') : tail;
  // A completed one-file run may only end with Bun's duration line. Any
  // partial next-run prefix (including a truncated `bun te`) is unmeasured.
  if (!/^\.?\s*(?:\[[\d.]+(?:ms|s)\])?\s*$/.test(runTail)) return null;
  // Bun's unhandled errors are absent from testcase JUnit. With no second
  // diagnostic channel to bind them, a reused worker must treat them as unknown.
  if (passes === null || fails === null || errors !== 0 || !ran || Number(ran[1]) !== cases.length || Number(ran[2]) !== 1
    || passes + fails !== cases.length
    || failureIds.length !== fails || new Set(failureIds).size !== failureIds.length
    || failureIds.some(id => !id.startsWith(`${file} > `))
    || (rc === 0 ? fails !== 0 : fails === 0)) return null;
  return { file, rc, failureIds, errorIds: [], junitComplete: true };
}
