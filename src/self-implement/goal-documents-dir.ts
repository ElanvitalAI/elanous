import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { debug } from '../debug/log.js';
import { excludeProjectDotElanous } from '../instance/project-local-exclude.js';
import { getUserConfig } from '../user-config/reader.js';
import type { UserConfig } from '../user-config/types.js';

/** Why `resolveGoalDocumentsDir` picked the directory it returned. */
export type GoalDocumentsDirReason = 'config' | 'existing-docs-goals' | 'default-dot-elanous';

export interface ResolvedGoalDocumentsDir {
  /** Absolute directory that holds authored goal documents for this repository. */
  directory: string;
  reason: GoalDocumentsDirReason;
}

export interface ResolveGoalDocumentsDirDeps {
  /** Reads `harness.goalsDir`. Defaults to the process user config. */
  readConfig?: (repoRoot: string) => UserConfig;
  /** Directory existence probe. Defaults to `existsSync`. */
  exists?: (path: string) => boolean;
  /** Resolution observation. Defaults to `debug.log`. */
  log?: (category: string, event: string, data?: unknown) => void;
  /** `.elanous/` 를 저장소의 로컬 무시 목록에 올린다(시험 seam). 기본 = `excludeProjectDotElanous`. */
  excludeDotElanous?: (repoRoot: string) => string;
}

const DOCS_GOALS = ['docs', 'goals'] as const;

/**
 * One place that decides where goal documents live.
 *
 * Precedence:
 * 1. `harness.goalsDir` — a repository-root-relative path in user config.
 * 2. `<repoRoot>/docs/goals` when that directory already exists (elanous and existing users).
 * 3. `<repoRoot>/.elanous/goals` otherwise. `.elanous/` is already gitignored by repo-provision.
 */
export function resolveGoalDocumentsDir(
  repoRoot: string,
  deps: ResolveGoalDocumentsDirDeps = {},
): ResolvedGoalDocumentsDir {
  const root = resolve(repoRoot);
  const readConfig = deps.readConfig ?? (() => getUserConfig());
  const exists = deps.exists ?? existsSync;
  const log = deps.log ?? ((category, event, data) => debug.log(category, event, data));

  const configured = configuredGoalsDir(readConfig(root), root);
  const resolved = configured
    ?? (exists(join(root, ...DOCS_GOALS))
      ? { directory: join(root, ...DOCS_GOALS), reason: 'existing-docs-goals' as const }
      : { directory: join(root, '.elanous', 'goals'), reason: 'default-dot-elanous' as const });

  // 기본 자리(`.elanous/goals`)면 그 저장소의 로컬 무시 목록에 올린다(UX 13 · 사용자 git status 를 더럽히지 않게).
  const excluded = resolved.reason === 'default-dot-elanous' ? (deps.excludeDotElanous ?? excludeProjectDotElanous)(root) : undefined;
  log('harness.goals-dir', 'resolved', { repoRoot: root, directory: resolved.directory, reason: resolved.reason, ...(excluded ? { excluded } : {}) });
  return resolved;
}

/** `harness.goalsDir` only counts when it is a non-empty path inside the repository root. */
function configuredGoalsDir(
  config: UserConfig,
  repoRoot: string,
): ResolvedGoalDocumentsDir | undefined {
  const harness = config.raw.harness;
  if (!harness || typeof harness !== 'object' || Array.isArray(harness)) return undefined;
  const goalsDir = (harness as Record<string, unknown>).goalsDir;
  if (typeof goalsDir !== 'string') return undefined;
  const trimmed = goalsDir.trim();
  if (!trimmed || isAbsolute(trimmed)) return undefined;
  const directory = resolve(repoRoot, trimmed);
  const rel = relative(repoRoot, directory);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return { directory, reason: 'config' };
}
