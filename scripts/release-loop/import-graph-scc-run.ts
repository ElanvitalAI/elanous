// Bind the shared gate selector to the committed-tree SCC report at one exact HEAD.
import { spawnSync } from 'node:child_process';
import { selectGateTestFiles } from '../../src/self-implement/gate-cli.js';
import { gitClosureTree } from './gate-closure.js';
import { analyzeImportGraphScc, type ImportGraphSccReport } from './import-graph-scc.js';

export type ImportGraphGateResult =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly head40: string; readonly base40: string; readonly changedFiles: readonly string[]; readonly report: ImportGraphSccReport };

function git(repo: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  // git-spawn-allow: read-only HEAD/cleanliness checks; no checkout or mutation.
  const result = spawnSync('git', [...args], { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Run only from a clean checkout. Selector and closure reader then observe the same committed HEAD. */
export function reportImportGraphSccForGate(repo: string, base40: string): ImportGraphGateResult {
  if (!/^[0-9a-f]{40}$/i.test(base40)) return { ok: false, reason: 'base must be a full commit SHA' };
  const head = git(repo, ['rev-parse', '--verify', 'HEAD']);
  const head40 = head.stdout.trim();
  if (head.status !== 0 || !/^[0-9a-f]{40}$/i.test(head40)) return { ok: false, reason: 'HEAD unreadable' };
  if (git(repo, ['merge-base', '--is-ancestor', base40, head40]).status !== 0) return { ok: false, reason: 'base is not an ancestor of HEAD' };
  const status = git(repo, ['status', '--porcelain', '--untracked-files=normal']);
  if (status.status !== 0 || status.stdout.trim()) return { ok: false, reason: 'working tree is not clean' };

  let selection: ReturnType<typeof selectGateTestFiles>;
  try {
    selection = selectGateTestFiles(repo, { base: base40, includeImporterTests: true });
  } catch (error) {
    return { ok: false, reason: `gate selector failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (selection.baseRef !== base40) return { ok: false, reason: 'gate selector base mismatch' };
  const afterHead = git(repo, ['rev-parse', '--verify', 'HEAD']);
  const afterStatus = git(repo, ['status', '--porcelain', '--untracked-files=normal']);
  if (afterHead.status !== 0 || afterHead.stdout.trim() !== head40 || afterStatus.status !== 0 || afterStatus.stdout.trim()) {
    return { ok: false, reason: 'HEAD or working tree changed during gate selection' };
  }
  const issues: string[] = [];
  if (selection.lookupFailed) issues.push(`importer lookup failed: ${selection.lookupFailed}`);
  if (selection.unrunImporterTotal === null) issues.push('unrun importer count unknown');
  else if (selection.unrunImporterTotal > 0) issues.push(`unrun importer tests: ${selection.unrunImporterTotal}`);
  if (selection.routeLookupFailures.length) issues.push(`route lookup failures: ${selection.routeLookupFailures.length}`);
  if (selection.callerTestsOverflow.length) issues.push(`caller tests overflow: ${selection.callerTestsOverflow.length}`);
  if (selection.alwaysIncludeMissing.length) issues.push(`always-include missing: ${selection.alwaysIncludeMissing.length}`);
  if (selection.unverified.length) issues.push(`changed paths unverified: ${selection.unverified.length}`);
  let report: ImportGraphSccReport;
  try {
    report = analyzeImportGraphScc(gitClosureTree(repo, head40), selection.testFiles, { complete: issues.length === 0, issues }, {}, selection.changedFiles);
  } catch (error) {
    return { ok: false, reason: `committed closure unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, head40, base40, changedFiles: selection.changedFiles, report };
}
