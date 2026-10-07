import { createWorktree, type CreateWorktreeResult } from '../git-fs/worktree.js';
import { runGitCommand } from '../git-fs/runner.js';
import { configuredWorktreeRoot } from '../user-config.js';
import { debug } from '../debug/log.js';
import { join, resolve } from 'node:path';

const OWNER_CONFIG_KEY = 'elanous.harness.owner';
const COMMAND_CONFIG_KEY = 'elanous.harness.command';
const CREATED_AT_CONFIG_KEY = 'elanous.harness.createdAt';
const GOAL_ID_CONFIG_KEY = 'elanous.harness.goalId';
const GOAL_FILE_CONFIG_KEY = 'elanous.harness.goalFile';
const GOAL_TITLE_CONFIG_KEY = 'elanous.harness.goalTitle';
const GOAL_DESCRIPTION_CONFIG_KEY = 'elanous.harness.goalDescription';
const GOAL_DESCRIPTION_SOURCE_CONFIG_KEY = 'elanous.harness.goalDescriptionSource';

type HarnessWorktreeAddOptions = {
  repoRoot: string;
  branch: string;
  base?: string;
  owner?: string;
  command?: string;
  createdAt?: string;
  goalId?: string;
  goalFile?: string;
  goalTitle?: string;
  goalDescription?: string;
  goalDescriptionSource?: 'generated' | 'title-fallback';
  /** Fail and remove the new worktree if supplied goal metadata cannot be recorded. */
  requireGoalMetadata?: boolean;
  /** Explicit root for isolated callers and tests; production defaults to user config. */
  worktreeRoot?: string;
};

type HarnessWorktreeProvenance = Required<Pick<HarnessWorktreeAddOptions, 'owner' | 'command' | 'createdAt'>>;
export type HarnessWorktreeGoalMetadata = Pick<HarnessWorktreeAddOptions, 'goalId' | 'goalFile' | 'goalTitle' | 'goalDescription' | 'goalDescriptionSource'>;
type WorktreeConfigSnapshot = ReadonlyMap<string, readonly string[]>;
export type HarnessWorktreeAddResult = CreateWorktreeResult & HarnessWorktreeProvenance;

class HarnessWorktreeGoalMetadataError extends Error {
  constructor(message: string, cause: unknown) {
    const causeName = cause instanceof Error ? cause.name : 'NonError';
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`${message} — ${causeName}: ${causeMessage}`, { cause });
    this.name = 'HarnessWorktreeGoalMetadataError';
  }
}

const PROVENANCE_CONFIG_KEYS = [COMMAND_CONFIG_KEY, CREATED_AT_CONFIG_KEY, OWNER_CONFIG_KEY] as const;

function gitAt(cwd: string, args: string[]) {
  return runGitCommand(cwd, args, { encoding: 'utf8' });
}

function gitConfigFailure(result: ReturnType<typeof runGitCommand>): string {
  return String(result.stderr || result.stdout || '').trim() || `git exited ${result.status}`;
}

function snapshotWorktreeProvenance(worktreePath: string): WorktreeConfigSnapshot {
  const snapshot = new Map<string, readonly string[]>();
  for (const key of PROVENANCE_CONFIG_KEYS) {
    const result = gitAt(worktreePath, ['config', '--worktree', '--null', '--get-all', key]);
    if (result.status === 0) {
      if (!result.stdout.endsWith('\0')) {
        throw new Error('harness worktree provenance snapshot failed — git config emitted an unterminated value');
      }
      snapshot.set(key, result.stdout.slice(0, -1).split('\0'));
    } else if (result.status === 1) {
      snapshot.set(key, []);
    } else {
      throw new Error(`harness worktree provenance snapshot failed — ${gitConfigFailure(result)}`);
    }
  }
  return snapshot;
}

function restoreWorktreeProvenance(worktreePath: string, snapshot: WorktreeConfigSnapshot): void {
  for (const key of PROVENANCE_CONFIG_KEYS) {
    const clear = gitAt(worktreePath, ['config', '--worktree', '--unset-all', key]);
    if (clear.status !== 0 && clear.status !== 5) {
      throw new Error(`harness worktree provenance rollback failed — ${gitConfigFailure(clear)}`);
    }
    for (const value of snapshot.get(key) ?? []) {
      const restore = gitAt(worktreePath, ['config', '--worktree', '--add', key, value]);
      if (restore.status !== 0) {
        throw new Error(`harness worktree provenance rollback failed — ${gitConfigFailure(restore)}`);
      }
    }
  }
}

/** Keys that must leave the shared config once `extensions.worktreeConfig` is on (`git help worktree` §CONFIGURATION FILE).
 *  `core.bare=false` is harmless when shared (linked trees default to non-bare), so only a true value moves. */
const MAIN_TREE_ONLY_CONFIG_KEYS = ['core.bare', 'core.worktree'] as const;

/** Moves `core.bare=true` / `core.worktree` from `$GIT_COMMON_DIR/config` to `$GIT_COMMON_DIR/config.worktree`.
 *  Runs every time (also when the extension is already on) and throws before the caller enables the extension.
 *  Incident 10-07 (HQ-WORKTREE-CONFIG): a shared `core.bare=true` made every linked worktree of a bare repo unusable. */
/** Values are moved byte-for-byte (a `core.worktree` path may carry edge whitespace), so read them NUL-terminated. */
function nulTerminatedValue(stdout: unknown, key: string): string {
  const text = String(stdout ?? '');
  if (!text.endsWith('\0')) throw new Error(`harness worktree ${key} read failed — git config emitted an unterminated value`);
  return text.slice(0, -1);
}

function moveMainTreeOnlyConfig(worktreePath: string): void {
  const common = gitAt(worktreePath, ['rev-parse', '--git-common-dir']);
  const commonOut = String(common.stdout ?? '').trim();
  if (common.status !== 0 || !commonOut) {
    throw new Error(`harness worktree common git dir lookup failed — ${gitConfigFailure(common)}`);
  }
  const commonDir = resolve(worktreePath, commonOut);
  const shared = join(commonDir, 'config');
  const perTree = join(commonDir, 'config.worktree');
  // `null` = absent. Typed reads judge meaning (`yes`/`TRUE` are true); raw reads carry the bytes that move.
  const readValue = (file: string, key: string, typed: boolean): string | null => {
    const read = gitAt(worktreePath, ['config', '--file', file, ...(typed ? ['--type=bool'] : []), '--null', '--get', key]);
    if (read.status === 1) return null;
    if (read.status !== 0) throw new Error(`harness worktree ${key} read failed (${file}) — ${gitConfigFailure(read)}`);
    return nulTerminatedValue(read.stdout, key);
  };
  for (const key of MAIN_TREE_ONLY_CONFIG_KEYS) {
    const typed = key === 'core.bare';
    const meaning = readValue(shared, key, typed);
    if (meaning === null) continue;
    if (typed && meaning !== 'true') continue;
    const raw = typed ? readValue(shared, key, false) : meaning;
    if (raw === null) throw new Error(`harness worktree shared ${key} vanished during the move`);
    // A valueless `bare` means true; writing its empty raw form would mean false.
    const value = typed && raw === '' ? 'true' : raw;
    // A conflicting per-tree value would flip the main tree once the extension is on — refuse instead of guessing.
    // Every per-tree value must agree (not just the last one), so a mixed list also fails closed.
    const existingRead = gitAt(worktreePath, ['config', '--file', perTree, ...(typed ? ['--type=bool'] : []), '--null', '--get-all', key]);
    if (existingRead.status !== 0 && existingRead.status !== 1) {
      throw new Error(`harness worktree ${key} read failed (${perTree}) — ${gitConfigFailure(existingRead)}`);
    }
    const existingValues = existingRead.status === 0 ? nulTerminatedValue(existingRead.stdout, key).split('\0') : [];
    if (existingValues.some((existing) => existing !== meaning)) {
      throw new Error(`harness worktree ${key} conflict — ${shared} has ${JSON.stringify(meaning)} but ${perTree} has ${JSON.stringify(existingValues)}; resolve by hand before enabling extensions.worktreeConfig`);
    }
    const existingMeaning = existingValues.length > 0 ? meaning : null;
    if (existingMeaning === null) {
      const write = gitAt(worktreePath, ['config', '--file', perTree, key, value]);
      if (write.status !== 0) throw new Error(`harness worktree ${key} move failed — ${gitConfigFailure(write)}`);
    }
    const unset = gitAt(worktreePath, ['config', '--file', shared, '--unset-all', key]);
    if (unset.status !== 0) throw new Error(`harness worktree shared ${key} unset failed — ${gitConfigFailure(unset)}`);
    debug.log('harness.worktree', 'core-bare-moved', {
      key,
      value,
      commonDir,
      perTreeHadValue: existingMeaning !== null,
      worktreePath,
    }, { level: 'warn' });
  }
}

/** Records the shared worktree-scoped provenance used by both manual and self-implement creation paths. */
export function recordHarnessWorktreeProvenance(worktreePath: string, provenance: HarnessWorktreeProvenance): void {
  moveMainTreeOnlyConfig(worktreePath);
  const enable = gitAt(worktreePath, ['config', 'extensions.worktreeConfig', 'true']);
  if (enable.status !== 0) {
    throw new Error(`harness worktree owner declaration failed — ${gitConfigFailure(enable)}`);
  }
  const snapshot = snapshotWorktreeProvenance(worktreePath);
  // Owner is the commit marker: readers never see a complete owner before its supporting fields exist.
  const entries: Array<[string, string]> = [
    [COMMAND_CONFIG_KEY, provenance.command],
    [CREATED_AT_CONFIG_KEY, provenance.createdAt],
    [OWNER_CONFIG_KEY, provenance.owner],
  ];
  try {
    for (const [key, value] of entries) {
      const result = gitAt(worktreePath, ['config', '--worktree', '--replace-all', key, value]);
      if (result.status !== 0) {
        throw new Error(`harness worktree provenance declaration failed — ${gitConfigFailure(result)}`);
      }
    }
  } catch (error) {
    try {
      restoreWorktreeProvenance(worktreePath, snapshot);
    } catch (rollbackError) {
      const message = error instanceof Error ? error.message : String(error);
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(`${message}; ${rollbackMessage}`);
    }
    throw error;
  }
}

/** Optional goal context is additive: failures are observed by callers and never restore strict provenance or remove a worktree. */
export function recordHarnessWorktreeGoalMetadata(worktreePath: string, metadata: HarnessWorktreeGoalMetadata): void {
  const entries: Array<[string, string | undefined]> = [
    [GOAL_ID_CONFIG_KEY, metadata.goalId],
    [GOAL_FILE_CONFIG_KEY, metadata.goalFile],
    [GOAL_TITLE_CONFIG_KEY, metadata.goalTitle],
    [GOAL_DESCRIPTION_CONFIG_KEY, metadata.goalDescription],
    [GOAL_DESCRIPTION_SOURCE_CONFIG_KEY, metadata.goalDescription ? metadata.goalDescriptionSource : undefined],
  ];
  for (const [key, value] of entries) {
    if (!value?.trim()) continue;
    const result = gitAt(worktreePath, ['config', '--worktree', '--replace-all', key, value]);
    if (result.status !== 0) {
      throw new Error(`harness worktree goal metadata declaration failed — ${gitConfigFailure(result)}`);
    }
  }
}

function rollbackCreatedWorktree(repoRoot: string, result: CreateWorktreeResult): string | null {
  const remove = gitAt(repoRoot, ['worktree', 'remove', '--force', result.path]);
  if (remove.status !== 0) {
    return `worktree removal failed: ${(remove.stderr || remove.stdout || `git exited ${remove.status}`).trim()}`;
  }
  const branch = gitAt(repoRoot, ['branch', '-D', result.branch]);
  if (branch.status !== 0) {
    return `branch deletion failed: ${(branch.stderr || branch.stdout || `git exited ${branch.status}`).trim()}`;
  }
  return null;
}

export function addHarnessWorktree(options: HarnessWorktreeAddOptions): HarnessWorktreeAddResult {
  const result = createWorktree({
    repoRoot: options.repoRoot,
    branch: options.branch,
    worktreeRoot: options.worktreeRoot ?? configuredWorktreeRoot(),
    ...(options.base ? { base: options.base } : {}),
  });
  const provenance = {
    owner: options.owner ?? 'harness:unattributed',
    command: options.command ?? 'harness worktree add',
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
  try {
    recordHarnessWorktreeProvenance(result.path, provenance);
  } catch (error) {
    const rollbackFailure = rollbackCreatedWorktree(options.repoRoot, result);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackFailure ? `${message}; rollback failed — ${rollbackFailure}` : message);
  }
  const goalMetadata: HarnessWorktreeGoalMetadata = {
    ...(options.goalId?.trim() ? { goalId: options.goalId } : {}),
    ...(options.goalFile?.trim() ? { goalFile: options.goalFile } : {}),
    ...(options.goalTitle?.trim() ? { goalTitle: options.goalTitle } : {}),
    ...(options.goalDescription?.trim() ? { goalDescription: options.goalDescription } : {}),
    ...(options.goalDescription?.trim() && options.goalDescriptionSource ? { goalDescriptionSource: options.goalDescriptionSource } : {}),
  };
  try {
    recordHarnessWorktreeGoalMetadata(result.path, goalMetadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug.log('harness.worktree', 'goal-metadata-record-failed', {
      path: result.path,
      reason: message,
    }, { level: 'warn' });
    if (options.requireGoalMetadata) {
      const rollbackFailure = rollbackCreatedWorktree(options.repoRoot, result);
      throw new HarnessWorktreeGoalMetadataError(rollbackFailure ? `${message}; rollback failed — ${rollbackFailure}` : message, error);
    }
  }
  return { ...result, ...provenance };
}

export function renderHarnessWorktreeAdd(result: HarnessWorktreeAddResult): string[] {
  return [
    '━━ harness worktree add ━━',
    `path: ${result.path}`,
    `branch: ${result.branch}`,
    `resolvedBase: ${result.resolvedBase}`,
    `baseFreshness: ${result.baseFreshness}`,
    ...(result.owner === undefined ? [] : [`owner: ${result.owner}`]),
    ...(result.command === undefined ? [] : [`command: ${result.command}`]),
    ...(result.createdAt === undefined ? [] : [`createdAt: ${result.createdAt}`]),
  ];
}
