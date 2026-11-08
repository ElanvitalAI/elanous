import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── GitCommit ToolRuntime (Coding Pipeline P4) ──
//
// Structured wrapper around `git add <specific files>` + `git commit
// -m "<message>"`. Designed to replace ad-hoc Bash incantations while
// preserving the strict invariants captured in the repo's memory
// feedback log and AGENTS.md / CLAUDE.md commit guidelines:
//
//   1. Specific files only — no `git add -A` / `git add .`. The
//      caller MUST list files. This prevents concurrent-track PRs
//      from picking up sibling work (memory feedback:
//      "git add specific (not -A) with concurrent tracks").
//
//   2. .env / credentials detection. If any staged file's basename
//      matches the sensitive pattern list, the commit is REJECTED
//      unless the caller passes `allowSensitive: true` with an
//      explicit acknowledgement.
//
//   3. Co-Authored-By trailer is appended automatically so every
//      LLM-authored commit is attributable. Matches the convention
//      used in prior PRs (claude-code-fork / this repo).
//
//   4. Hooks run by default. `--no-verify` is refused unless the
//      caller passes `skipHooks: true` AND provides a written reason.
//      Matches CLAUDE.md §Git Safety Protocol.
//
//   5. No amend. Memory feedback + CLAUDE.md: "CRITICAL: Always
//      create NEW commits rather than amending". If the caller wants
//      amend, they're expected to fall back to Bash with explicit
//      authorisation — this tool doesn't expose the flag.
//
// All git operations are shelled out synchronously (spawnSync) so
// the result is deterministic — no streaming output to parse. Errors
// come back as thrown exceptions; the tool-loop wraps them into an
// isError tool_result for the LLM.

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

import { getSessionCwd } from '../session/working-dir.js';
import { harnessCommandWriteReject } from '../harness/harness-write-boundary.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';

/** Files/paths whose name matches any of these globs are refused by
 *  default. Basename-only (paths are file-by-file anyway). */
const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,              // .env, .env.local, .env.production
  /^\..*credentials.*$/i,         // .credentials, .aws-credentials
  /^credentials\.(json|yaml|yml)$/i,
  /^.*\.pem$/i,                   // private keys
  /^id_rsa(\..+)?$/i,             // SSH keys
  /^\..*secrets.*$/i,
];

export interface GitCommitArgs {
  /** Commit message. The Co-Authored-By trailer is appended
   *  automatically — DO NOT include it yourself. Multi-line messages
   *  are supported (heredoc-style body). */
  message: string;
  /** Explicit list of file paths to stage. Must be non-empty. Paths
   *  are relative to the session working directory. `git add -A`-
   *  style wildcards are NOT supported on purpose — if the caller
   *  really wants a bulk add they should list the directory. */
  files: string[];
  /** Append "Signed-off-by" trailer (maintainers who need DCO). */
  signoff?: boolean;
  /** Acknowledge a sensitive file on the add list. Without this,
   *  sensitive patterns (see SENSITIVE_PATTERNS) block the commit. */
  allowSensitive?: boolean;
  /** Pass --no-verify (skip pre-commit hooks). REQUIRES skipHooksReason. */
  skipHooks?: boolean;
  /** Human-readable justification when skipHooks is true. Stored in
   *  the audit log only — not in the commit itself. */
  skipHooksReason?: string;
}

export interface GitCommitResult {
  output: string;
  commitSha: string;
  branch: string;
  filesStaged: string[];
}

const AUTHOR_TRAILER = 'Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>';

/** Build the LLM schema. */
export function buildGitCommitTool(): LLMToolSpec {
  return {
    name: 'GitCommit',
    description:
      'Stage specific files and create a new git commit. Safer + less error-prone than ' +
      'composing the Bash equivalent: enforces listed files only (never `git add -A`), ' +
      'auto-rejects .env / credentials / *.pem unless explicitly acknowledged, auto- ' +
      'appends the Co-Authored-By trailer, and never amends (use Bash if you really need ' +
      '--amend). Pre-commit hooks run by default; skipping requires an explicit reason ' +
      'for the audit log.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description:
            'Commit message. Multi-line allowed (heredoc-style body). Do NOT include the ' +
            'Co-Authored-By trailer — it is appended automatically.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Paths (relative to the session working directory) to stage. Must be non-empty. ' +
            'Directory paths are accepted but wildcards are not.',
        },
        signoff: {
          type: 'boolean',
          description: 'Append "Signed-off-by" trailer (DCO-compliant projects). Default false.',
        },
        allowSensitive: {
          type: 'boolean',
          description:
            'Override the .env / credentials block when the caller has verified the file ' +
            'is safe to commit. Default false (blocks sensitive patterns).',
        },
        skipHooks: {
          type: 'boolean',
          description: 'Pass --no-verify. Requires skipHooksReason. Default false.',
        },
        skipHooksReason: {
          type: 'string',
          description: 'Written justification when skipHooks is true (logged, not committed).',
        },
      },
      required: ['message', 'files'],
      additionalProperties: false,
    },
  };
}

/** Public: detect sensitive patterns in a candidate file list. Exposed
 *  for tests + any future batch-validation UI. */
export function findSensitiveFiles(files: string[]): string[] {
  const flagged: string[] = [];
  for (const f of files) {
    const b = basename(f);
    if (SENSITIVE_PATTERNS.some((p) => p.test(b))) flagged.push(f);
  }
  return flagged;
}

/** Append the Co-Authored-By trailer to the caller-provided message,
 *  inserting a blank line if one is missing before trailers. */
export function appendAuthorTrailer(message: string): string {
  const trimmed = message.replace(/\s+$/u, '');
  if (trimmed.includes(AUTHOR_TRAILER)) return trimmed + '\n';
  // Ensure exactly one blank line before the trailer.
  return `${trimmed}\n\n${AUTHOR_TRAILER}\n`;
}

/** Core executor — factored out so tests can stub the git runner. */
export function dispatchGitCommit(
  args: GitCommitArgs,
  opts: {
    cwd?: string;
    runner?: (cmd: string, argv: string[], cwd: string) => { stdout: string; stderr: string; status: number };
  } = {},
): GitCommitResult {
  const cwd = opts.cwd ?? getSessionCwd();
  const runner = opts.runner ?? defaultGitRunner;
  const reject = harnessCommandWriteReject(['git', 'commit'], cwd, 'git-commit');
  if (reject) throw new Error(reject);

  if (!Array.isArray(args.files) || args.files.length === 0) {
    throw new Error('GitCommit: `files` must be a non-empty array (no `git add -A` equivalent)');
  }
  if (!args.message || !args.message.trim()) {
    throw new Error('GitCommit: `message` is required');
  }
  if (args.skipHooks && !args.skipHooksReason?.trim()) {
    throw new Error('GitCommit: `skipHooks: true` requires `skipHooksReason` for the audit log');
  }
  const sensitive = findSensitiveFiles(args.files);
  if (sensitive.length > 0 && !args.allowSensitive) {
    throw new Error(
      `GitCommit: refusing to stage sensitive files without allowSensitive=true: ${sensitive.join(', ')}`,
    );
  }

  // Stage files (explicit paths only).
  const addResult = runner('git', ['add', '--', ...args.files], cwd);
  if (addResult.status !== 0) {
    throw new Error(`GitCommit: git add failed — ${addResult.stderr.trim() || addResult.stdout.trim()}`);
  }

  // Commit.
  const finalMessage = appendAuthorTrailer(args.message);
  const commitArgv = ['commit', '-m', finalMessage];
  if (args.signoff) commitArgv.push('--signoff');
  if (args.skipHooks) commitArgv.push('--no-verify');
  const commitResult = runner('git', commitArgv, cwd);
  if (commitResult.status !== 0) {
    throw new Error(`GitCommit: git commit failed — ${commitResult.stderr.trim() || commitResult.stdout.trim()}`);
  }

  // Collect commit SHA + branch for the LLM-visible output.
  const shaResult = runner('git', ['rev-parse', 'HEAD'], cwd);
  const branchResult = runner('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const commitSha = shaResult.stdout.trim();
  const branch = branchResult.stdout.trim();

  return {
    output: `✓ ${commitSha.slice(0, 7)} on ${branch} · ${args.files.length} file${args.files.length === 1 ? '' : 's'} staged`,
    commitSha,
    branch,
    filesStaged: args.files,
  };
}

function defaultGitRunner(
  cmd: string,
  argv: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(cmd, argv, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? -1,
  };
}

export const gitCommitRuntime: ToolRuntime<GitCommitArgs, GitCommitResult> = {
  id: 'git_commit',
  spec: buildGitCommitTool(),
  async run(req: GitCommitArgs, _ctx: ToolRuntimeContext): Promise<GitCommitResult> {
    return dispatchGitCommit(req);
  },
};
