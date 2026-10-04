import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { isGoalAuthorFileName } from './goal-document.js';
import { hasTerminalRunStatus, loadRunLedger, queryUnfinishedRunLedgers, runLedgerDir } from './run-ledger.js';

export interface GoalArchiveOptions {
  repoRoot?: string;
  stateRoot?: string;
  before?: string;
  apply?: boolean;
  trustDocRecord?: boolean;
  /** Failure-injection seam for the two write stages (copy · index); defaults use the real filesystem.
   *  The repository is never written: removing the originals is a human PR from `filesForPr`. */
  writes?: {
    copy?: (source: string, destination: string) => void;
    appendIndex?: (path: string, line: string) => void;
  };
}

export interface GoalArchiveEntry {
  goalId: string;
  runId: string;
  pr: number | null;
  outcome: 'merged' | 'abandoned' | 'superseded';
  source: 'ledger' | 'doc-record';
  originalPath: string;
  archivePath: string;
}

export interface GoalArchiveResult {
  candidates: GoalArchiveEntry[];
  applied: GoalArchiveEntry[];
  skipped: Record<string, number>;
  trustDocRecordAdds: number;
  filesForPr: string[];
}

function gitRead(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

function applyArchiveEntry(index: string, source: string,
  entry: GoalArchiveEntry, document: string, writes: GoalArchiveOptions['writes']): void {
  const directory = dirname(entry.archivePath);
  const hadDirectory = existsSync(directory);
  const priorIndex = existsSync(index) ? readFileSync(index) : null;
  let ownedCopy = false;
  let indexAttempted = false;
  try {
    mkdirSync(directory, { recursive: true });
    const reservation = openSync(entry.archivePath, 'wx');
    ownedCopy = true;
    closeSync(reservation);
    (writes?.copy ?? copyFileSync)(source, entry.archivePath);
    if (readFileSync(entry.archivePath, 'utf8') !== document) throw new Error(`archive copy mismatch: ${entry.originalPath}`);
    indexAttempted = true;
    (writes?.appendIndex ?? ((path, line) => appendFileSync(path, line, 'utf8')))(index, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    try {
      if (indexAttempted) {
        if (priorIndex === null) rmSync(index, { force: true });
        else if (!readFileSync(index).equals(priorIndex)) writeFileSync(index, priorIndex);
      }
      if (ownedCopy) rmSync(entry.archivePath, { force: true });
      if (ownedCopy && !hadDirectory && existsSync(directory)) rmdirSync(directory);
    } catch (rollbackError) {
      throw new Error(`archive failed for ${entry.originalPath}: ${String(error)}; recovery required (archive rollback: ${String(rollbackError)}). Preserve ${entry.archivePath} and ${index}; reconcile the index before retry.`);
    }
    throw error;
  }
}

function beforeDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`--before requires a valid YYYY-MM-DD date: ${value}`);
  }
  return value;
}

function ledgerGoalFileContradicts(goalFile: unknown, originalPath: string): boolean {
  if (typeof goalFile !== 'string' || !goalFile.trim()) return false;
  const normalized = goalFile.replaceAll('\\', '/');
  return normalized !== originalPath && !normalized.endsWith(`/${originalPath}`);
}

function lastExecution(document: string): Record<string, string> | null {
  const sections = document.split(/^## 실행 기록\s*$/m).slice(1);
  const block = sections.at(-1)?.split(/^#{1,2} /m, 1)[0];
  const run = block?.split(/^- runId: /m).slice(1).at(-1);
  if (!run) return null;
  const id = run.split(/\r?\n/, 1)[0]?.trim();
  if (!id) return null;
  const fields: Record<string, string> = { runId: id };
  for (const [, key, value] of run.matchAll(/^  (stage|outcome|prNumber|completedAt): ([^\r\n]*)$/gm)) fields[key!] = value!.trim();
  return fields;
}

/** Preview by default. --apply only copies to the state archive and indexes; it never removes or stages anything in the repository —
 *  `filesForPr` is the list a human removes in one PR. A missing ledger requires explicit trust in the document's finished-run record. */
export function archiveGoals(options: GoalArchiveOptions = {}): GoalArchiveResult {
  const root = resolve(options.repoRoot ?? gitRead(process.cwd(), 'rev-parse', '--show-toplevel').trim());
  const state = resolve(options.stateRoot ?? elanousStateRoot());
  const cutoff = beforeDate(options.before);
  const goals = join(root, 'docs', 'goals');
  const archive = join(state, 'goal-archive');
  const index = join(archive, 'index.jsonl');
  const result: GoalArchiveResult = { candidates: [], applied: [], skipped: {}, trustDocRecordAdds: 0, filesForPr: [] };
  const skip = (reason: string): void => { result.skipped[reason] = (result.skipped[reason] ?? 0) + 1; };
  const lock = join(archive, '.apply.lock');
  if (options.apply) {
    mkdirSync(archive, { recursive: true });
    try { mkdirSync(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error(`EEXIST: goal archive --apply is already running or a previous run stopped mid-way (${lock}). `
        + `If no other archive is running: compare ${index} with ${archive}/<YYYY-MM>/ copies, drop index lines whose copy is missing, then remove ${lock} and retry.`);
    }
  }
  try {
    const tracked = new Set(gitRead(root, 'ls-files', '-z', '--', 'docs/goals').split('\0').filter(Boolean));
  const pendingRemovals = new Set(gitRead(root, 'diff', '--cached', '--name-only', '--diff-filter=D', '-z', '--', 'docs/goals').split('\0').filter(Boolean));
  const unfinished = queryUnfinishedRunLedgers({ dir: runLedgerDir(state), goalsDir: goals, noCache: true });
  if (unfinished.unreadableLedgerCount > 0) throw new Error('run ledger contains unreadable runs; archive refused');
  const activePaths = new Set(unfinished.entries.filter((entry) => entry.goalDocumentPath)
    .map((entry) => resolve(root, entry.goalDocumentPath!)));
  const activeRunIds = new Set(unfinished.entries.map((entry) => entry.runId));
  const indexed = new Set<string>();
  if (existsSync(index)) {
    for (const line of readFileSync(index, 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line) as { originalPath: string };
      indexed.add(entry.originalPath);
    }
  }
  let names: string[];
  try { names = readdirSync(goals).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    names = [];
  }
  for (const name of names) {
    if (!isGoalAuthorFileName(name)) continue;
    const path = join(goals, name);
    const originalPath = relative(root, path).split(sep).join('/');
    if (!tracked.has(originalPath) || pendingRemovals.has(originalPath)) { skip('untracked'); continue; }
    const fileStat = lstatSync(path, { throwIfNoEntry: false });
    if (!fileStat?.isFile() || fileStat.isSymbolicLink()) { skip('not-file'); continue; }
    if (indexed.has(originalPath)) { skip('already-indexed'); continue; }
    if (activePaths.has(path)) { skip('active-goal-run'); continue; }
    const document = readFileSync(path, 'utf8');
    const fields = lastExecution(document);
    if (!fields) { skip('no-execution-record'); continue; }
    const runId = fields.runId!;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId)) { skip('invalid-run-id'); continue; }
    if (activeRunIds.has(runId)) { skip('active-goal-run'); continue; }
    const outcome = fields.stage === 'merged' && (fields.outcome === 'completed' || fields.outcome === 'merged') ? 'merged'
      : fields.outcome === 'abandoned' ? 'abandoned'
      : fields.outcome === 'superseded' ? 'superseded' : null;
    if (!outcome) { skip('unfinished'); continue; }
    let ledger;
    try { ledger = loadRunLedger(runId, runLedgerDir(state)); }
    catch (error) {
      skip(error instanceof Error && /runId does not match /.test(error.message) ? 'ledger-run-id-mismatch' : 'unreadable-ledger');
      continue;
    }
    const missingLedger = !ledger?.length;
    if (missingLedger && (!fields.stage || !fields.outcome)) { skip('unfinished'); continue; }
    const documentGoalId = /^- GoalId:\s*([0-9a-f]{16})\s*$/m.exec(document.split(/^## 실행 기록\s*$/m, 1)[0] ?? '')?.[1];
    if (!documentGoalId) { skip('missing-goal-id'); continue; }
    if (!missingLedger) {
      const entries = ledger!;
      const ledgerGoalIds = new Set(entries.map((entry) => entry.goalId).filter((id): id is string => typeof id === 'string'));
      if (ledgerGoalIds.size !== 1 || !ledgerGoalIds.has(documentGoalId)) { skip('ledger-goal-id-mismatch'); continue; }
      const starts = entries.filter((entry) => entry.event === 'start');
      if (starts.length === 0 || starts.some((entry) => ledgerGoalFileContradicts(entry.data.goalFile, originalPath))) {
        skip('ledger-goal-mismatch'); continue;
      }
    }
    const latest = ledger?.filter((entry) => entry.event === 'run-status').at(-1);
    if (!missingLedger) {
      if (!latest || !hasTerminalRunStatus(ledger!) || !['completed', 'failed', 'cancelled'].includes(String(latest.data.runStatus))) {
        skip('running-or-unconfirmed'); continue;
      }
      if (outcome === 'merged' && (latest.data.runStatus !== 'completed' || (latest.data.stage !== undefined && latest.data.stage !== 'merged'))
        || outcome === 'abandoned' && latest.data.runStatus === 'completed'
        || outcome === 'superseded' && latest.data.runStatus === 'failed') {
        skip('status-mismatch'); continue;
      }
    }
    const completedAt = missingLedger ? fields.completedAt : fields.completedAt ?? latest?.timestamp;
    if (!completedAt || !Number.isFinite(Date.parse(completedAt))) { skip('no-completion-date'); continue; }
    const date = new Date(completedAt).toISOString().slice(0, 10);
    if (cutoff && date >= cutoff) { skip('after-before'); continue; }
    const prRaw = fields.prNumber;
    const pr = prRaw && /^[1-9]\d*$/.test(prRaw) && Number.isSafeInteger(Number(prRaw)) ? Number(prRaw) : null;
    const archivePath = join(archive, date.slice(0, 7), basename(path));
    if (existsSync(archivePath)) { skip('archive-collision'); continue; }
    if (gitRead(root, 'status', '--porcelain', '--', originalPath).trim()) { skip('dirty'); continue; }
    if (missingLedger && !options.trustDocRecord) { skip('missing-ledger'); result.trustDocRecordAdds += 1; continue; }
    const entry: GoalArchiveEntry = { goalId: documentGoalId, runId, pr, outcome, source: missingLedger ? 'doc-record' : 'ledger', originalPath, archivePath };
    result.candidates.push(entry);
    if (options.apply) {
      applyArchiveEntry(index, path, entry, document, options.writes);
      result.applied.push(entry);
      result.filesForPr.push(originalPath);
    } else {
      result.filesForPr.push(originalPath);
    }
  }
  try { debug.log('harness.goal', 'archive', { candidates: result.candidates.length, applied: result.applied.length, skipped: result.skipped }); } catch { /* observation is fail-soft */ }
  return result;
  } finally {
    if (options.apply) rmdirSync(lock);
  }
}
