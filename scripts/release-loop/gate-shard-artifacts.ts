import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGatePodRuntimeIdentity } from './gate-baseline-receipt.js';
import { testFileOfId } from './gate-partial.js';
import { cleanRetryVerdict, junitFailedCaseIds, junitTestcaseCount, junitTestcaseFiles } from './gate-shard-load-flaky.js';
import { lastMatch, summaryCount, stripSummary } from './gate-test-summary.js';
import { parseTimedOutFailures } from './gate-diff.js';
import type { RetryPassEvidence } from './gate-types.js';

export interface ShardArtifacts {
  /** GATE-POD-STALL-FAILFAST (OP) — every unfinished part ended with a complete clean summary (0 fail · 0 error) but an exit
   *  other than 0/1: an exit-code anomaly (a test left process.exitCode set), with those parts' files. */
  exitCodeOnly?: string[];
  /** The verdict text: install log ⊕ every finished part (its summary removed) ⊕ one summary over the finished parts. */
  output?: string;
  junit?: string;
  /** 0|1 when every part finished · the failing part's exit when one crashed · undefined when the deadline cut the shard. */
  rc?: number;
  timedOut: boolean;
  /** Installation failed before any test process could produce a verdict. */
  installFailed?: boolean;
  /** Files of the parts that finished with a readable summary. */
  finished: string[];
  /** Raw logs of the parts that did not finish (diagnostics · last started file). */
  unfinishedLog?: string;
  runtimeIdentity?: ReturnType<typeof parseGatePodRuntimeIdentity>;
  /** Original failure ids whose one same-Pod standalone retry completed cleanly. */
  loadFlaky?: string[];
  retryPass?: RetryPassEvidence[];
  /** Files for which a same-Pod retry completed, even if it remained failing. */
  loadFlakyAttemptedFiles?: string[];
}
/** Reads a shard Pod's outbox: the part layout ({@link gateShardShell}) or the older single-run one (shard.log · shard.rc · junit.xml). */
export function readShardArtifacts(dir: string, parts: readonly (readonly string[])[]): ShardArtifacts {
  const read = (name: string) => { const path = join(dir, name); return existsSync(path) ? readFileSync(path, 'utf8') : undefined; };
  const identityText = read('runtime-identity.json');
  const runtimeIdentity = identityText === undefined ? undefined : parseGatePodRuntimeIdentity(identityText) ?? undefined;
  const rcOf = (text: string | undefined) => { const value = text?.trim() ?? ''; return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined; };
  const installRc = rcOf(read('install.rc'));
  const install = read('install.log');
  if (installRc === undefined && install === undefined) {
    const junit = read('junit.xml');
    const rc = rcOf(read('shard.rc'));
    return { output: read('shard.log'), ...(junit !== undefined ? { junit } : {}), ...(rc !== undefined ? { rc } : {}),
      ...(runtimeIdentity ? { runtimeIdentity } : {}), timedOut: false, finished: [] };
  }
  const timedOut = read('shard.timeout') !== undefined;
  if (installRc !== 0) return { output: install, ...(installRc !== undefined ? { rc: installRc } : {}),
    ...(runtimeIdentity ? { runtimeIdentity } : {}), timedOut, installFailed: true, finished: [] };
  const good: Array<{ log: string; junit?: string; rc: 0 | 1; files: readonly string[]; loadFlaky?: string[]; retryPass?: RetryPassEvidence[] }> = [];
  const bad: string[] = [];
  const exitAnomaly: string[] = [];
  const attemptedFiles = new Set<string>();
  let otherBad = false;
  let badRc: number | undefined;
  parts.forEach((files, index) => {
    const retryManifest = (read(`part-${index}.retry-files`) ?? '').split(/\r?\n/).filter(Boolean);
    retryManifest.forEach((file, retryIndex) => {
      if (files.includes(file) && read(`part-${index}.retry-${retryIndex}.started`) !== undefined) attemptedFiles.add(file);
    });
    const log = read(`part-${index}.log`);
    const rc = rcOf(read(`part-${index}.rc`));
    const clean = log?.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    // GATE-POD-STALL-FAILFAST ① — a part the mid-run abort ended reads like a deadline cut: unfinished, its exit (143/137) no verdict.
    const abort = read(`part-${index}.abort`);
    if (abort !== undefined) {
      bad.push(`# part ${index} (abort: ${abort.trim()})\n${log ?? ''}`);
      otherBad = true;
      return;
    }
    const summary = clean === undefined ? undefined : lastMatch(clean, /Ran (\d+) tests? across (\d+) files?/);
    const summaryTests = Number(summary?.[1] ?? NaN);
    const summaryPass = clean === undefined ? NaN : summaryCount(clean, 'pass');
    const summaryFail = clean === undefined ? NaN : summaryCount(clean, 'fail');
    const summaryErrors = clean === undefined ? NaN : summaryCount(clean, 'error');
    const partJunit = read(`part-${index}.junit.xml`) ?? '';
    const testcaseFiles = junitTestcaseFiles(partJunit);
    const expectedFiles = [...files].sort();
    const timedOutComplete = rc === 124 && summary !== undefined && summary !== null && Number(summary[2]) === files.length
      && summaryPass + summaryFail + (Number.isNaN(summaryErrors) ? 0 : summaryErrors) === summaryTests
      && junitTestcaseCount(partJunit) === summaryTests
      && testcaseFiles !== null && testcaseFiles.length === expectedFiles.length && expectedFiles.every((file, fileIndex) => testcaseFiles[fileIndex] === file);
    if (clean !== undefined && ((rc === 0 || rc === 1) || timedOutComplete) && summary) {
      const junit = read(`part-${index}.junit.xml`);
      const retryFiles = retryManifest;
      const retryPass = retryFiles.flatMap((file, retryIndex): RetryPassEvidence[] => {
        if (!files.includes(file)) return [];
        const retryRc = rcOf(read(`part-${index}.retry-${retryIndex}.rc`));
        const retryLog = read(`part-${index}.retry-${retryIndex}.log`);
        const retryJunit = read(`part-${index}.retry-${retryIndex}.junit.xml`);
        const originalFailures = (junitFailedCaseIds(junit ?? '') ?? []).filter((id) => testFileOfId(id) === file);
        const verdict = cleanRetryVerdict(retryRc, retryLog, retryJunit, file, originalFailures);
        if (!verdict.clean) return [];
        // A multi-file part that passes alone points to isolation/order contamination. A single-file
        // part that passes under the same retry limit points to load. A timed-out original is timeout.
        const timedOutIds = new Set(parseTimedOutFailures(clean));
        return originalFailures.map((id) => ({ id,
          cause: timedOutIds.has(id) ? 'timeout' : files.length > 1 ? 'isolation' : 'load' }));
      });
      good.push({ log: clean, rc: rc === 0 ? 0 : 1, files, ...(junit !== undefined ? { junit } : {}),
        ...(retryPass.length ? { loadFlaky: retryPass.map((row) => row.id), retryPass } : {}) });
      return;
    }
    if (log !== undefined) bad.push(`# part ${index} (${rc === undefined ? 'unfinished' : `rc=${rc}`})\n${log}`);
    if (clean !== undefined && rc !== undefined && rc !== 0 && rc !== 1 && Number(lastMatch(clean, /Ran (\d+) tests? across ([1-9]\d*) files?/)?.[1] ?? 0) > 0
      && summaryCount(clean, 'fail') === 0 && !(summaryCount(clean, 'error') > 0) && !/^# Unhandled error between tests/m.test(clean)) exitAnomaly.push(...files);
    else otherBad = true;
    // A finished part without a readable summary is not a verdict: its exit, or 2 when it claimed 0|1.
    if (rc !== undefined && badRc === undefined) badRc = rc === 0 || rc === 1 ? 2 : rc;
  });
  const total = good.reduce((sum, part) => {
    const n = (label: string) => { const value = summaryCount(part.log, label); return Number.isNaN(value) ? 0 : value; };
    const ran = lastMatch(part.log, /Ran (\d+) tests? across (\d+) files?/)!;
    return { pass: sum.pass + n('pass'), fail: sum.fail + n('fail'), errors: sum.errors + n('error'), ran: sum.ran + Number(ran[1]), files: sum.files + Number(ran[2]) };
  }, { pass: 0, fail: 0, errors: 0, ran: 0, files: 0 });
  const output = [install ?? '', ...good.map((part) => stripSummary(part.log)),
    ...(good.length ? [`${total.pass} pass\n${total.fail} fail\n${total.errors} errors\nRan ${total.ran} tests across ${total.files} files.\n`] : [])].join('\n');
  const junits = good.flatMap((part) => part.junit !== undefined ? [part.junit] : []);
  const complete = good.length === parts.length;
  const rc = complete ? (good.some((part) => part.rc === 1) ? 1 : 0) : timedOut && badRc === undefined ? undefined : (badRc ?? 2);
  return {
    output,
    ...(junits.length ? { junit: junits.join('\n') } : {}),
    ...(rc !== undefined ? { rc } : {}),
    timedOut: !complete && timedOut && badRc === undefined,
    finished: good.flatMap((part) => [...part.files]),
    ...([ ...new Set(good.flatMap((part) => part.loadFlaky ?? [])) ].length
      ? { loadFlaky: [...new Set(good.flatMap((part) => part.loadFlaky ?? []))].sort() } : {}),
    ...(good.some((part) => part.retryPass?.length)
      ? { retryPass: good.flatMap((part) => part.retryPass ?? []).sort((a, b) => a.id.localeCompare(b.id)) } : {}),
    ...(attemptedFiles.size ? { loadFlakyAttemptedFiles: [...attemptedFiles].sort() } : {}),
    ...(bad.length ? { unfinishedLog: bad.join('\n') } : {}),
    ...(exitAnomaly.length && !otherBad ? { exitCodeOnly: exitAnomaly } : {}),
    ...(runtimeIdentity ? { runtimeIdentity } : {}),
  };
}
