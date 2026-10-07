// GATE-PARTIAL (0.2.19 · 10-07): a re-gate after `release cut-branch --append` runs only the test files that can have
// changed — not the whole 24-shard sweep again (0.2.18: two timeout fixes on top of an 84-minute gate meant another full
// gate). The plan is opt-in (`release resume --from gate --partial`) and fail-closed: any non-test source change, a prior
// gate record for another commit, or a missing record means «full gate», never a guess.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

export interface PartialPlan {
  version: string;
  /** Commit the previous (full) gate measured — its recorded failures are carried for every file not re-run. */
  priorCommit: string;
  /** The commit this plan is for — a gate on any other commit ignores it. */
  forCommit: string;
  /** Test files re-run: changed test files ⊕ files of the prior failures. */
  files: string[];
  priorFailures: string[];
  priorErrors: string[];
}

export const partialPlanPath = (root: string, version: string) => join(root, 'release', version, 'gate-partial.json');
/** The same test-file set the gate sweep runs (`git ls-files` filtered by this suffix). */
const TEST_FILE = /^(?:[\w.-]+\/)*[\w.-]+\.test\.(?:tsx?|jsx?|mts|cts)$/;
/** Changes that cannot alter a test result on their own: Markdown that is not test input. A fixture (any file under a
 *  test/, fixtures, __fixtures__ or __snapshots__ path), JSON or script is not inert — the gate runs in full. */
const INERT_MD = /\.md$/;
const TEST_INPUT = /(?:^|\/)(?:test|tests|fixtures|__fixtures__|__snapshots__|__mocks__)\//;
const isInert = (file: string) => INERT_MD.test(file) && !TEST_INPUT.test(file);

/** The test file of a failure id (`<file> > <case>`). One rule for the gate and the partial plan: ids come only from the
 *  gate's output parsers, which accept `dir/….test.ts(x)` — anything else (a root file, `..`, no case) is unsafe. */
export function testFileOfId(id: string): string {
  const file = id.split(' > ', 1)[0]!;
  if (!id.includes(' > ') || !/^(?:[\w.-]+\/)+[\w.-]+\.test\.tsx?$/.test(file) || file.split('/').includes('..')) throw new Error(`unsafe test path: ${file}`);
  return file;
}

/** Decide whether a partial re-gate is safe for `changedFiles` (prior → for). Never guesses: any doubt is a full gate. */
export function planPartialRegate(input: { version: string; priorCommit: string; forCommit: string; changedFiles: readonly string[];
  priorFailures: readonly string[]; priorErrors: readonly string[] }):
  { ok: true; plan: PartialPlan } | { ok: false; reason: string } {
  if (!/^[0-9a-f]{40}$/i.test(input.priorCommit) || !/^[0-9a-f]{40}$/i.test(input.forCommit)) return { ok: false, reason: 'commit is not a full sha' };
  if (input.priorCommit === input.forCommit) return { ok: false, reason: 'no new commit since the prior gate' };
  const source = input.changedFiles.filter((file) => !TEST_FILE.test(file) && !isInert(file));
  if (source.length) return { ok: false, reason: `non-test change → full gate: ${source.slice(0, 5).join(', ')}${source.length > 5 ? ` (+${source.length - 5})` : ''}` };
  let failureFiles: string[];
  try { failureFiles = [...input.priorFailures, ...input.priorErrors].map(testFileOfId); }
  catch (error) { return { ok: false, reason: String(error instanceof Error ? error.message : error) }; }
  const files = [...new Set([...input.changedFiles.filter((file) => TEST_FILE.test(file)), ...failureFiles])].sort();
  if (!files.length) return { ok: false, reason: 'nothing to re-run' };
  return { ok: true, plan: { version: input.version, priorCommit: input.priorCommit, forCommit: input.forCommit, files,
    priorFailures: [...input.priorFailures], priorErrors: [...input.priorErrors] } };
}

export function writePartialPlan(root: string, plan: PartialPlan): string {
  const path = partialPlanPath(root, plan.version);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return path;
}

export function clearPartialPlan(root: string, version: string): void {
  const path = partialPlanPath(root, version);
  if (existsSync(path)) rmSync(path);
}

/** The plan for exactly this commit, or null. A malformed plan is an error (never silently a full or partial gate). */
export function readPartialPlan(roots: readonly string[], version: string, commit: string): PartialPlan | null {
  for (const root of roots) {
    const path = partialPlanPath(root, version);
    if (!existsSync(path)) continue;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PartialPlan>;
    if (raw.version !== version || typeof raw.priorCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(raw.priorCommit)
      || typeof raw.forCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(raw.forCommit) || raw.priorCommit === raw.forCommit
      || !Array.isArray(raw.files) || raw.files.length === 0 || !raw.files.every((file) => typeof file === 'string' && TEST_FILE.test(file) && !file.split('/').includes('..'))
      || !Array.isArray(raw.priorFailures) || !Array.isArray(raw.priorErrors)) throw new Error(`invalid gate partial plan: ${path}`);
    // Every prior failure's file is re-run (planPartialRegate guarantees it) — a plan that would carry a failure it did
    // not re-run is malformed, not «partial».
    const rerun = new Set(raw.files);
    let failureFiles: string[];
    try { failureFiles = [...raw.priorFailures, ...raw.priorErrors].map((id) => testFileOfId(String(id))); }
    catch { throw new Error(`invalid gate partial plan: ${path}`); }
    if (failureFiles.some((file) => !rerun.has(file))) throw new Error(`invalid gate partial plan (prior failure not re-run): ${path}`);
    if (raw.forCommit !== commit) continue;
    return raw as PartialPlan;
  }
  return null;
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
