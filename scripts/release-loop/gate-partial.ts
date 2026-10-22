// GATE-PARTIAL (0.2.19 · 10-07): a re-gate after `release cut-branch --append` runs only the test files that can have
// changed — not the whole 24-shard sweep again (0.2.18: two timeout fixes on top of an 84-minute gate meant another full
// gate). The plan is opt-in (`release resume --from gate --partial`) and fail-closed: any non-test source change, a prior
// gate record for another commit, or a missing record means «full gate», never a guess.
// GATE-REUSE-BY-DIFF (0.2.25): a code change no longer forces the full sweep — with the tip's import closure
// (gate-closure.ts) the plan adds every test that can reach a changed file, and every test whose closure is opaque.
// `release resume --from gate` now plans this by default when the tip moved (`--no-partial` = full gate).
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { CODE_FILE, TRACEABLE_RELEASE_JSON, type ClosureVerdict } from './gate-closure';

export interface PartialPlan {
  /** A verified docs-only append carries the completed, clean cut without starting a test Pod. */
  kind?: 'carry' | 'recheck';
  version: string;
  /** Commit the previous (full) gate measured — its recorded failures are carried for every file not re-run. */
  priorCommit: string;
  /** The commit this plan is for — a gate on any other commit ignores it. */
  forCommit: string;
  /** Test files re-run: changed test files ⊕ files of the prior failures ⊕ tests reaching a changed code file. */
  files: string[];
  priorFailures: string[];
  priorErrors: string[];
}

/** G1: a second measurement of only the failed files on the very same release commit.
 * This is deliberately separate from PartialPlan, which compares two different commits. */
export interface RecheckPlan extends PartialPlan {
  kind: 'recheck';
  /** Files from shards that could not produce a measurement; completed shard results remain in priorFailures/errors. */
  stalledFiles?: string[];
  /** Count of complete shards whose measurements are preserved in this recheck. */
  preservedShardCount?: number;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/;
export const recheckPlanPath = (root: string, version: string) => partialPlanPath(root, version);

/** A recheck never broadens its scope to passing or changed tests. Any uncertain input fails closed. */
export function planSameCommitRecheck(input: { version: string; measuredCommit: string; forCommit: string;
  failures: readonly string[]; errors: readonly string[]; existsAtCommit: (file: string) => boolean }):
  { ok: true; plan: RecheckPlan } | { ok: false; reason: string } {
  if (!RELEASE_VERSION.test(input.version)) return { ok: false, reason: 'invalid release version' };
  if (!FULL_SHA.test(input.measuredCommit) || !FULL_SHA.test(input.forCommit)) return { ok: false, reason: 'commit is not a full sha' };
  if (input.measuredCommit !== input.forCommit) return { ok: false, reason: 'recheck requires the same commit' };
  let files: string[];
  try { files = [...new Set([...input.failures, ...input.errors].map(testFileOfId))].sort(); }
  catch (error) { return { ok: false, reason: String(error instanceof Error ? error.message : error) }; }
  if (!files.length) return { ok: false, reason: 'no failed test files to recheck' };
  try {
    const missing = files.find((file) => !input.existsAtCommit(file));
    if (missing) return { ok: false, reason: `failed test file missing at commit: ${missing}` };
  } catch (error) { return { ok: false, reason: `test file existence unreadable: ${String(error)}` }; }
  return { ok: true, plan: { kind: 'recheck', version: input.version, priorCommit: input.measuredCommit,
    forCommit: input.forCommit, files, priorFailures: [...input.failures], priorErrors: [...input.errors] } };
}

export function writeRecheckPlan(root: string, plan: RecheckPlan): string {
  validateRecheckPlan(plan, plan.version, recheckPlanPath(root, plan.version));
  const path = recheckPlanPath(root, plan.version);
  const inspectExisting = (): void => {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as Partial<RecheckPlan>;
    if (existing.kind !== 'recheck') throw new Error(`gate partial plan already exists: ${path}`);
    validateRecheckPlan(existing, plan.version, path);
    if (existing.forCommit !== plan.forCommit)
      throw new Error(`gate recheck plan already exists for another commit: ${path}`);
    if (JSON.stringify(existing) !== JSON.stringify(plan))
      throw new Error(`different gate recheck plan already exists: ${path}`);
  };
  return publishPlanIfVacant(path, plan, inspectExisting);
}

/** Both writers of gate-partial.json must use the same no-clobber publication rule. */
function publishPlanIfVacant(path: string, plan: PartialPlan, inspectExisting: () => void): string {
  if (existsSync(path)) { inspectExisting(); return path; }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    // Same-directory hard link publishes a complete file only if the slot is still empty.
    // renameSync would overwrite a different writer's commit between inspection and publication.
    try { linkSync(temp, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      inspectExisting();
    }
  } finally { rmSync(temp, { force: true }); }
  return path;
}

function validateRecheckPlan(raw: Partial<RecheckPlan>, version: string, path: string): asserts raw is RecheckPlan {
  const invalid = () => { throw new Error(`invalid gate recheck plan: ${path}`); };
  if (!RELEASE_VERSION.test(version) || raw.kind !== 'recheck' || raw.version !== version ||
      typeof raw.priorCommit !== 'string' || !FULL_SHA.test(raw.priorCommit) ||
      typeof raw.forCommit !== 'string' || !FULL_SHA.test(raw.forCommit) || raw.priorCommit !== raw.forCommit ||
      !Array.isArray(raw.priorFailures) || !raw.priorFailures.every((id) => typeof id === 'string') ||
      !Array.isArray(raw.priorErrors) || !raw.priorErrors.every((id) => typeof id === 'string') ||
      !Array.isArray(raw.files) || !raw.files.length || !raw.files.every((file) => typeof file === 'string') ||
      (raw.preservedShardCount !== undefined && (!Number.isSafeInteger(raw.preservedShardCount) || raw.preservedShardCount < 0))) invalid();
  let expected: string[] = [];
  try {
    const measuredFiles = [...raw.priorFailures!, ...raw.priorErrors!].map(testFileOfId);
    const stalledFiles = raw.stalledFiles === undefined ? [] : raw.stalledFiles;
    if (!Array.isArray(stalledFiles) || !stalledFiles.every((file) => typeof file === 'string' && TEST_FILE.test(file) && !file.split('/').includes('..'))) invalid();
    if (raw.stalledFiles !== undefined && stalledFiles.some((file) => measuredFiles.includes(file))) invalid();
    expected = [...new Set(stalledFiles)].sort();
    // Legacy plans recheck every prior failed file. Stalled plans re-run only files from incomplete shards; all
    // completed shard outcomes, including runtime errors, are preserved for the combined verdict.
    if (raw.stalledFiles === undefined) expected = [...new Set(measuredFiles)].sort();
  }
  catch { invalid(); }
  if (JSON.stringify(raw.files) !== JSON.stringify(expected)) invalid();
}

/** Plan a same-commit retry after a Pod sweep reports stalled shards. Reuse completed outcomes and rerun stalled files. */
export function planStalledShardRecheck(input: { version: string; measuredCommit: string; forCommit: string;
  failures: readonly string[]; errors: readonly string[]; stalledFiles: readonly string[]; preservedShardCount?: number;
  existsAtCommit: (file: string) => boolean }):
  { ok: true; plan: RecheckPlan } | { ok: false; reason: string } {
  if (!RELEASE_VERSION.test(input.version)) return { ok: false, reason: 'invalid release version' };
  if (!FULL_SHA.test(input.measuredCommit) || !FULL_SHA.test(input.forCommit)) return { ok: false, reason: 'commit is not a full sha' };
  if (input.measuredCommit !== input.forCommit) return { ok: false, reason: 'recheck requires the same commit' };
  try { [...input.failures, ...input.errors].forEach(testFileOfId); }
  catch (error) { return { ok: false, reason: String(error instanceof Error ? error.message : error) }; }
  const stalledFiles = [...new Set(input.stalledFiles)].sort();
  if (!stalledFiles.length) return { ok: false, reason: 'no stalled test files to recheck' };
  if (stalledFiles.some((file) => !TEST_FILE.test(file) || file.split('/').includes('..'))) return { ok: false, reason: 'unsafe stalled test path' };
  const measuredFiles = [...new Set([...input.failures, ...input.errors].map(testFileOfId))];
  if (stalledFiles.some((file) => measuredFiles.includes(file)))
    return { ok: false, reason: 'stalled file overlaps a completed shard result' };
  const files = stalledFiles;
  try {
    const missing = files.find((file) => !input.existsAtCommit(file));
    if (missing) return { ok: false, reason: `failed test file missing at commit: ${missing}` };
  } catch (error) { return { ok: false, reason: `test file existence unreadable: ${String(error)}` }; }
  return { ok: true, plan: { kind: 'recheck', version: input.version, priorCommit: input.measuredCommit,
    forCommit: input.forCommit, files, stalledFiles, ...(input.preservedShardCount === undefined ? {} : { preservedShardCount: input.preservedShardCount }),
    priorFailures: [...input.failures], priorErrors: [...input.errors] } };
}

export const partialPlanPath = (root: string, version: string) => join(root, 'release', version, 'gate-partial.json');
/** The same test-file set the gate sweep runs (`git ls-files` filtered by this suffix). */
const TEST_FILE = /^(?:[\w.-]+\/)*[\w.-]+\.test\.(?:tsx?|jsx?|mts|cts)$/;
/** Changes that cannot alter a test result on their own: Markdown that is not test input. A fixture (any file under a
 *  test/, fixtures, __fixtures__ or __snapshots__ path), JSON or script is not inert — the gate runs in full. */
const INERT_MD = /\.md$/;
const TEST_INPUT = /(?:^|\/)(?:test|tests|fixtures|__fixtures__|__snapshots__|__mocks__)\//;
const isInert = (file: string) => INERT_MD.test(file) && !TEST_INPUT.test(file);

/** Recheck the immutable Git diff at the consumer; a mutable plan file alone cannot authorize a zero-file gate. */
export function verifyDocsOnlyCarry(repo: string, priorCommit: string, forCommit: string): boolean {
  const files = changedFilesBetween(repo, priorCommit, forCommit);
  return files.length > 0 && files.every(isInert);
}

/** The test file of a failure id (`<file> > <case>`). One rule for the gate and the partial plan: ids come only from the
 *  gate's output parsers, which accept `dir/….test.ts(x)` — anything else (a root file, `..`, no case) is unsafe. */
export function testFileOfId(id: string): string {
  const file = id.split(' > ', 1)[0]!;
  if (!id.includes(' > ') || !/^(?:[\w.-]+\/)+[\w.-]+\.test\.tsx?$/.test(file) || file.split('/').includes('..')) throw new Error(`unsafe test path: ${file}`);
  return file;
}

/** Decide whether a partial re-gate is safe for `changedFiles` (prior → for). Never guesses: any doubt is a full gate. */
export function planPartialRegate(input: { version: string; priorCommit: string; forCommit: string; changedFiles: readonly string[];
  priorFailures: readonly string[]; priorErrors: readonly string[];
  /** GATE-REUSE-BY-DIFF: the tests reaching these changed code files (seeds include changed tests). Without it any
   *  non-test change is a full gate. */
  closure?: (changedCode: string[]) => ClosureVerdict;
  /** Tracked at the tip — a deleted changed test is not re-run (nothing to run); a deleted prior-failure file is a full
   *  gate (its failure can be neither re-measured nor carried). Without it every changed test is planned. */
  existsAtTip?: (file: string) => boolean }):
  { ok: true; plan: PartialPlan; closure?: { reached: number; opaque: number } } | { ok: false; reason: string } {
  if (!/^[0-9a-f]{40}$/i.test(input.priorCommit) || !/^[0-9a-f]{40}$/i.test(input.forCommit)) return { ok: false, reason: 'commit is not a full sha' };
  if (input.priorCommit === input.forCommit) return { ok: false, reason: 'no new commit since the prior gate' };
  const source = input.changedFiles.filter((file) => !TEST_FILE.test(file) && !isInert(file));
  const list = (files: string[]) => `${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5})` : ''}`;
  // Only code is followed through the closure: a changed fixture, JSON, lockfile, config or script is a full gate.
  const notCode = source.filter((file) => !CODE_FILE.test(file) && file !== TRACEABLE_RELEASE_JSON);
  if (source.length && (!input.closure || notCode.length)) return { ok: false, reason: `non-test change → full gate: ${list(notCode.length ? notCode : source)}` };
  let reaching: string[] = [];
  let closure: { reached: number; opaque: number } | undefined;
  if (source.length) {
    let verdict: ClosureVerdict;
    try { verdict = input.closure!(input.changedFiles.filter((file) => CODE_FILE.test(file) || file === TRACEABLE_RELEASE_JSON)); }
    catch (error) { return { ok: false, reason: `import closure unreadable → full gate: ${String(error instanceof Error ? error.message : error).slice(0, 200)}` }; }
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    const unsafe = verdict.tests.filter((file) => !TEST_FILE.test(file) || file.split('/').includes('..'));
    if (unsafe.length) return { ok: false, reason: `closure selected a test path the plan cannot carry → full gate: ${list(unsafe)}` };
    reaching = verdict.tests;
    closure = { reached: verdict.reached, opaque: verdict.opaque };
  }
  let failureFiles: string[];
  try { failureFiles = [...input.priorFailures, ...input.priorErrors].map(testFileOfId); }
  catch (error) { return { ok: false, reason: String(error instanceof Error ? error.message : error) }; }
  const exists = input.existsAtTip ?? (() => true);
  const gone = failureFiles.filter((file) => !exists(file));
  if (gone.length) return { ok: false, reason: `prior failure file deleted at the tip → full gate: ${list(gone)}` };
  const files = [...new Set([...input.changedFiles.filter((file) => TEST_FILE.test(file) && exists(file)), ...failureFiles, ...reaching])].sort();
  // An empty selection is safe only for a genuinely docs-only diff. A deleted test also selects zero files,
  // but it changes the measured suite and must not masquerade as a carry.
  if (!files.length && (!input.changedFiles.length || input.changedFiles.some((file) => !isInert(file))))
    return { ok: false, reason: 'nothing to re-run (not a docs-only append)' };
  return { ok: true, plan: { ...(!files.length ? { kind: 'carry' as const } : {}), version: input.version, priorCommit: input.priorCommit, forCommit: input.forCommit, files,
    priorFailures: [...input.priorFailures], priorErrors: [...input.priorErrors] }, ...(closure ? { closure } : {}) };
}

export function writePartialPlan(root: string, plan: PartialPlan): string {
  const path = partialPlanPath(root, plan.version);
  return publishPlanIfVacant(path, plan, () => {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as PartialPlan & { kind?: unknown };
    if (existing.kind === 'recheck') throw new Error(`gate recheck plan already exists: ${path}`);
    if (JSON.stringify(existing) !== JSON.stringify(plan))
      throw new Error(`different gate partial plan already exists: ${path}`);
  });
}

export function clearPartialPlan(root: string, version: string): void {
  const path = partialPlanPath(root, version);
  if (existsSync(path)) rmSync(path);
}

/** The plan for exactly this commit, or null. A malformed plan is an error (never silently a full or partial gate). */
export function readPartialPlanResult(roots: readonly string[], version: string, commit: string):
  { plan: PartialPlan | null; fallbackReason: string | null } {
  let fallbackReason: string | null = 'no-applicable-plan';
  for (const root of roots) {
    const path = partialPlanPath(root, version);
    if (!existsSync(path)) continue;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PartialPlan>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid gate partial plan: ${path}`);
    if ((raw as Partial<RecheckPlan>).kind !== undefined && (raw as Partial<RecheckPlan>).kind !== 'recheck' && raw.kind !== 'carry')
      throw new Error(`invalid gate partial plan: ${path}`);
    // Only a well-formed stalled-shard recheck for this exact release commit enters the same-commit consumer path.
    if ((raw as Partial<RecheckPlan>).kind === 'recheck') {
      const recheck = raw as Partial<RecheckPlan>;
      validateRecheckPlan(recheck, version, path);
      if (recheck.forCommit === commit && recheck.stalledFiles !== undefined)
        return { plan: recheck, fallbackReason: null };
      if (recheck.forCommit === commit) { fallbackReason = 'recheck-not-stalled-only'; continue; }
      fallbackReason = 'plan-commit-mismatch';
      continue;
    }
    if (raw.version !== version || typeof raw.priorCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(raw.priorCommit)
      || typeof raw.forCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(raw.forCommit) || raw.priorCommit === raw.forCommit
      || !Array.isArray(raw.files) || (raw.files.length === 0) !== (raw.kind === 'carry')
      || !raw.files.every((file) => typeof file === 'string' && TEST_FILE.test(file) && !file.split('/').includes('..'))
      || !Array.isArray(raw.priorFailures) || !Array.isArray(raw.priorErrors))
      throw new Error(`invalid gate partial plan: ${path}`);
    if (raw.kind === 'carry' && (raw.priorFailures.length || raw.priorErrors.length)) throw new Error(`invalid gate partial plan: ${path}`);
    // Every prior failure's file is re-run (planPartialRegate guarantees it) — a plan that would carry a failure it did
    // not re-run is malformed, not «partial».
    const rerun = new Set(raw.files);
    let failureFiles: string[];
    try { failureFiles = [...raw.priorFailures, ...raw.priorErrors].map((id) => testFileOfId(String(id))); }
    catch { throw new Error(`invalid gate partial plan: ${path}`); }
    if (failureFiles.some((file) => !rerun.has(file))) throw new Error(`invalid gate partial plan (prior failure not re-run): ${path}`);
    if (raw.forCommit !== commit) { fallbackReason = 'plan-commit-mismatch'; continue; }
    return { plan: raw as PartialPlan, fallbackReason: null };
  }
  return { plan: null, fallbackReason };
}

export function readPartialPlan(roots: readonly string[], version: string, commit: string): PartialPlan | null {
  return readPartialPlanResult(roots, version, commit).plan;
}

/** Cut failures after a partial re-run: prior results for files not re-run ⊕ this run's results for the re-run files. */
export function mergePartialFailures(plan: PartialPlan, measured: { failures: string[]; errors: string[] }): { failures: string[]; errors: string[] } {
  const rerun = new Set(plan.files);
  const keep = (ids: readonly string[]) => ids.filter((id) => !rerun.has(testFileOfId(id)));
  return { failures: [...keep(plan.priorFailures), ...measured.failures], errors: [...keep(plan.priorErrors), ...measured.errors] };
}

/** Files changed between two commits — both sides of a rename (`--no-renames`), so moving a source file into a test or
 *  Markdown name still shows the source path that disappeared. */
export function changedFilesBetween(repo: string, from: string, to: string): string[] {
  // git-spawn-allow: read-only diff of two release commits.
  const result = spawnSync('git', ['diff', '--name-only', '--no-renames', `${from}..${to}`], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0 || result.error) throw new Error(`git diff failed: ${(result.stderr || result.error || 'no output').toString().trim()}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}
