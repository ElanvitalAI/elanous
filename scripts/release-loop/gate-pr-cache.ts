/** Decide whether a standalone train may consume an author's exact-head remote gate. No I/O. */
export type PrGateCacheDecision = {
  decision: 'reuse' | 'partial' | 'full'; reason: string; files: string[];
  head: string; base: string; main: string;
};

export interface PrGateCacheInput {
  summary: unknown;
  head: string;
  main: string;
  singlePr: boolean;
  baseAncestorOfHead: boolean;
  baseAncestorOfMain: boolean;
  /** git diff --name-only --no-renames author base..current main; null means unmeasured. */
  mainChangedFiles: readonly string[] | null;
  /** True only when every changed inert document was added on main, not modified or deleted. */
  inertDocsAddedOnly: boolean | null;
  /** Import-closure result among the author's measured cohort; null means unmeasured. */
  affectedTests: readonly string[] | null;
  /** Whether changed main code is in the changed PR source's forward dependency closure. */
  sourceDependencyOverlap: boolean | null;
}

const SHA = /^[0-9a-f]{40}$/i;
const TEST = /\.test\.[cm]?[jt]sx?$/;
const CODE = /\.[cm]?[jt]sx?$/;
const INERT_DOC = /\.md$/;
const TEST_INPUT = /(?:^|\/)(?:test|tests|__tests__|fixtures|__fixtures__|__snapshots__|__mocks__)\//;
const safePath = (path: unknown): path is string => typeof path === 'string' && !!path
  && !path.startsWith('/') && !path.split('/').some((part) => !part || part === '.' || part === '..');

export function decidePrGateCache(input: PrGateCacheInput): PrGateCacheDecision {
  const raw = input.summary && typeof input.summary === 'object' && !Array.isArray(input.summary)
    ? input.summary as Record<string, unknown> : {};
  const base = typeof raw.base40 === 'string' ? raw.base40.toLowerCase() : '';
  const head = input.head.toLowerCase();
  const main = input.main.toLowerCase();
  const result = (decision: PrGateCacheDecision['decision'], reason: string, files: string[] = []): PrGateCacheDecision =>
    ({ decision, reason, files, head, base, main });
  if (!input.singlePr) return result('full', 'bundle-train');
  if (![head, base, main].every((sha) => SHA.test(sha))) return result('full', 'identity-unmeasured');
  if (typeof raw.head40 !== 'string' || raw.head40.toLowerCase() !== head || raw.verdict !== 'passed' || raw.exitCode !== 0
    || raw.introduced !== 0 || raw.unknown !== 0 || raw.preconditionUnmet !== 0 || raw.unrunImporters !== 0
    || (raw.remoteHost !== 'node-b' && raw.remoteHost !== 'node-c'))
    return result('full', 'author-gate-unmeasured-or-incomplete');
  if (!Array.isArray(raw.cohort) || !raw.cohort.length || !raw.cohort.every((file) => safePath(file) && TEST.test(file)))
    return result('full', 'author-cohort-unmeasured');
  const cohort = [...new Set(raw.cohort as string[])];
  if (!input.baseAncestorOfHead || !input.baseAncestorOfMain) return result('full', 'base-not-ancestor');
  if (!input.mainChangedFiles || !input.mainChangedFiles.every(safePath)) return result('full', 'main-diff-unmeasured');
  const changed = [...new Set(input.mainChangedFiles)].sort();
  if (changed.some((file) => !CODE.test(file) && !(INERT_DOC.test(file) && !TEST_INPUT.test(file))))
    return result('full', 'main-noncode-change');
  if (changed.some((file) => INERT_DOC.test(file)) && input.inertDocsAddedOnly !== true)
    return result('full', 'main-document-change-not-addition');
  const codeChanged = changed.filter((file) => CODE.test(file));
  if (!codeChanged.length) return result('reuse', changed.length ? 'main-doc-only-outside-radius' : 'same-content-base');
  if (input.sourceDependencyOverlap === null) return result('full', 'pr-source-radius-unmeasured');
  if (!input.affectedTests || !input.affectedTests.every((file) => safePath(file) && cohort.includes(file)))
    return result('full', 'radius-unmeasured');
  const affected = [...new Set([...input.affectedTests, ...codeChanged.filter((file) => cohort.includes(file))])].sort();
  if (input.sourceDependencyOverlap && !affected.length) return result('full', 'pr-source-dependency-without-recheck-test');
  if (!affected.length) return result('reuse', 'main-change-outside-pr-radius');
  if (affected.length === cohort.length) return result('full', 'whole-author-cohort-affected');
  return result('partial', 'main-change-inside-pr-radius', affected);
}
