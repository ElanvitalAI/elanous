import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── EnterWorktree / ExitWorktree runtimes (GT4) ──
//
// Per-feature branch workflow. EnterWorktree creates a new git
// worktree under <repo>.worktrees/<slug>, checks out a new branch,
// and promotes the worktree path to the session working directory
// so every subsequent tool resolves against it. ExitWorktree reverses
// the SWD flip (worktree dir stays on disk unless `prune: true`).


import { getSessionCwd, setSessionCwd } from '../session/working-dir.js';
import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  resolveMainRepoRoot,
  saveWorktreeSession,
  loadWorktreeSession,
  clearWorktreeSession,
  validateBranchName,
  worktreeDirName,
  type WorktreeSession,
} from '../git-fs/worktree.js';
import { findGitDir } from '../git-fs/locate.js';
import { configuredWorktreeRoot } from '../user-config.js';
import { recordHarnessWorktreeProvenance } from '../harness/harness-worktree-add.js';
import { debug } from '../debug/log.js';
import type { ToolRuntime } from './types.js';

// The runtime deps carry the current session id so the JSON
// persistence file is per-session (two elanous instances don't stomp
// each other). Wired from dashboard at boot.
interface WorktreeDeps {
  sessionId: () => string;
  recordWorktreeProvenance?: typeof recordHarnessWorktreeProvenance;
}

let deps: WorktreeDeps | null = null;

export function setWorktreeRuntimeDeps(d: WorktreeDeps | null): void {
  deps = d;
}

function getSessionId(): string {
  return deps?.sessionId() ?? 'default';
}

// ── EnterWorktree ──────────────────────────────────────────────────

export interface EnterWorktreeResult {
  output: string;
  path: string;
  branch: string;
  previousCwd: string;
  provenanceError?: string;
}

function buildEnterSpec(): LLMToolSpec {
  return {
    name: 'EnterWorktree',
    description:
      'Create a new git worktree + branch and promote it to the session working directory. ' +
      'Use when starting work on a new feature / fix so the change is isolated from the main ' +
      'checkout. Worktree lives at <repo>.worktrees/<slug>. After success every Read / Edit / ' +
      'Write / Shell / Grep / Glob resolves against the new worktree path. To leave, call ' +
      'ExitWorktree. Pass `autoBranch: true` with a short `topic` to have the tool synthesise ' +
      'a branch name like `session/<YYYYMMDD-HHmm>-<topic-slug>` (P4).',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Branch name (also used as the slug for the worktree dir). Alphanumeric plus . _ - / ; ' +
            'must not start with "-" or contain whitespace / ".." / "//". ' +
            'Ignored when autoBranch=true (tool synthesises a name from topic).',
        },
        base: {
          type: 'string',
          description:
            'Optional base branch or commit to branch from. Defaults to HEAD of the main repo.',
        },
        autoBranch: {
          type: 'boolean',
          description:
            'P4 — synthesise a branch name automatically. When true, `topic` (or `name` as fallback) is slugified and prefixed with `session/<timestamp>-`. Default false.',
        },
        topic: {
          type: 'string',
          description:
            'Short slug fragment used when autoBranch=true. e.g. "refactor-cache" → `session/20260424-1512-refactor-cache`. If omitted, falls back to `name`.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  };
}

/** Synthesise a deterministic-ish branch name. Exposed for tests. */
export function synthesiseAutoBranchName(topic: string, now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ts = `${y}${m}${d}-${hh}${mm}`;
  const slug = (topic || 'work')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'work';
  return `session/${ts}-${slug}`;
}

export const enterWorktreeRuntime: ToolRuntime<Record<string, unknown>, EnterWorktreeResult> = {
  id: 'enter_worktree',
  spec: buildEnterSpec(),
  async run(req): Promise<EnterWorktreeResult> {
    const autoBranch = req.autoBranch === true;
    const topic = typeof req.topic === 'string' ? req.topic.trim() : '';
    const explicitName = typeof req.name === 'string' ? req.name.trim() : '';
    let name: string;
    if (autoBranch) {
      const seed = topic || explicitName || 'work';
      name = synthesiseAutoBranchName(seed);
    } else {
      if (!explicitName) throw new Error('EnterWorktree: `name` is required (or set autoBranch=true with a `topic`)');
      name = explicitName;
    }
    validateBranchName(name);
    const base = typeof req.base === 'string' && req.base.trim() ? req.base.trim() : undefined;
    const cwd = getSessionCwd();
    const repoRoot = resolveMainRepoRoot(cwd);
    if (!repoRoot) throw new Error(`EnterWorktree: session cwd ${cwd} is not inside a git repo`);
    const previousCwd = cwd;
    const { path, branch } = createWorktree({ repoRoot, branch: name, worktreeRoot: configuredWorktreeRoot(), base });
    const provenance = {
      owner: `agent:${getSessionId()}`,
      command: 'elanous enter_worktree',
      createdAt: new Date().toISOString(),
    };
    let provenanceError: string | undefined;
    try {
      (deps?.recordWorktreeProvenance ?? recordHarnessWorktreeProvenance)(path, provenance);
      debug.log('tool-runtime.worktree', 'provenance-recorded', { path, ...provenance });
    } catch (error) {
      provenanceError = error instanceof Error ? error.message : String(error);
      debug.log('tool-runtime.worktree', 'provenance-failed', { path, ...provenance, reason: provenanceError }, { level: 'warn' });
    }
    setSessionCwd(path, 'tool');
    const session: WorktreeSession = {
      sessionId: getSessionId(),
      worktreePath: path,
      branch,
      previousCwd,
      previousRepoRoot: repoRoot,
      enteredAt: Date.now(),
    };
    saveWorktreeSession(session);
    return {
      output: `✓ worktree → ${path} (branch ${branch}, base ${base ?? 'HEAD'})${provenanceError ? `; ownership recording failed: ${provenanceError}` : ''}`,
      path,
      branch,
      previousCwd,
      ...(provenanceError ? { provenanceError } : {}),
    };
  },
};

// ── ExitWorktree ───────────────────────────────────────────────────

export interface ExitWorktreeResult {
  output: string;
  returnedTo: string;
  pruned: boolean;
}

function buildExitSpec(): LLMToolSpec {
  return {
    name: 'ExitWorktree',
    description:
      'Reverse the most recent EnterWorktree: restore the session working directory to where ' +
      'it was before entering. The worktree directory stays on disk (and the branch keeps its ' +
      'commits) unless `prune: true` is passed. Safe to call when no worktree session is active — ' +
      'it surfaces a structured error so the LLM can recover.',
    parameters: {
      type: 'object',
      properties: {
        prune: {
          type: 'boolean',
          description:
            'When true, `git worktree remove` the directory after restoring SWD. The branch is NOT ' +
            'deleted — user can still check it out later. Defaults to false.',
        },
        force: {
          type: 'boolean',
          description:
            'Pass --force to `git worktree remove` so a dirty working copy can still be pruned. ' +
            'Ignored when prune is false. Defaults to false.',
        },
      },
      additionalProperties: false,
    },
  };
}

export const exitWorktreeRuntime: ToolRuntime<Record<string, unknown>, ExitWorktreeResult> = {
  id: 'exit_worktree',
  spec: buildExitSpec(),
  async run(req): Promise<ExitWorktreeResult> {
    const prune = !!req.prune;
    const force = !!req.force;
    const sid = getSessionId();
    const session = loadWorktreeSession(sid);
    if (!session) {
      throw new Error('ExitWorktree: no active worktree session — nothing to exit');
    }
    // Restore SWD first so even a failed prune doesn't strand the
    // session inside a deleted path.
    setSessionCwd(session.previousCwd, 'tool');
    let pruned = false;
    if (prune) {
      try {
        removeWorktree(session.previousRepoRoot, session.worktreePath, force);
        pruned = true;
      } catch (err) {
        clearWorktreeSession(sid);
        throw err;
      }
    }
    clearWorktreeSession(sid);
    return {
      output: pruned
        ? `✓ exited worktree ${session.branch} → ${session.previousCwd} (pruned ${session.worktreePath})`
        : `✓ exited worktree ${session.branch} → ${session.previousCwd} (kept ${session.worktreePath})`,
      returnedTo: session.previousCwd,
      pruned,
    };
  },
};

// Helper exported for the /branch slash so the dashboard can
// enumerate worktrees without importing git-fs/worktree directly.
export function currentWorktreeSummary(cwd: string): {
  isWorktree: boolean;
  repoRoot: string | null;
  entries: ReturnType<typeof listWorktrees>;
} {
  const loc = findGitDir(cwd);
  const repoRoot = resolveMainRepoRoot(cwd);
  return {
    isWorktree: !!loc?.isWorktree,
    repoRoot,
    entries: repoRoot ? listWorktrees(repoRoot) : [],
  };
}

export { worktreeDirName };
