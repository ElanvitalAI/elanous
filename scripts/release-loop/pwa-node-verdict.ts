// Release-loop ④ — turn scenario runs into one verdict. Pure: no daemon, no browser.
// A cell that fails on the first pass and passes on a rerun is «flaky» (not a regression);
// a cell that never passes, or is blocked (its selector is gone), fails the release.

export interface CellRun {
  id: string;
  pass: boolean;
  blocked?: boolean;
}

export interface CellVerdict {
  id: string;
  first: 'pass' | 'fail' | 'blocked';
  reruns: Array<'pass' | 'fail' | 'blocked'>;
  final: 'pass' | 'flaky' | 'fail';
}

export interface NodeVerdict {
  verdict: 'pass' | 'flaky' | 'fail';
  cells: CellVerdict[];
}

const outcome = (run: CellRun): 'pass' | 'fail' | 'blocked' => (run.blocked ? 'blocked' : run.pass ? 'pass' : 'fail');

/** Ids from the first pass that need a rerun (failed or blocked). */
export function idsToRerun(first: readonly CellRun[]): string[] {
  return first.filter((run) => !run.pass || run.blocked).map((run) => run.id);
}

/** `reruns[i]` is the i-th rerun pass (only the ids that were rerun). */
export function decideVerdict(first: readonly CellRun[], reruns: ReadonlyArray<readonly CellRun[]>): NodeVerdict {
  const cells = first.map((run): CellVerdict => {
    const later = reruns.map((pass) => pass.find((r) => r.id === run.id)).filter((r): r is CellRun => r !== undefined).map(outcome);
    const head = outcome(run);
    const final: CellVerdict['final'] = head === 'pass' ? 'pass' : later.includes('pass') && head !== 'blocked' ? 'flaky' : 'fail';
    return { id: run.id, first: head, reruns: later, final };
  });
  const verdict: NodeVerdict['verdict'] = cells.some((c) => c.final === 'fail') ? 'fail' : cells.some((c) => c.final === 'flaky') ? 'flaky' : 'pass';
  return { verdict, cells };
}

/** Process exit code for the graph node: 0 pass/flaky, 1 fail. (2 = could not run — decided by the caller.) */
export function exitCodeFor(verdict: NodeVerdict['verdict']): 0 | 1 {
  return verdict === 'fail' ? 1 : 0;
}
