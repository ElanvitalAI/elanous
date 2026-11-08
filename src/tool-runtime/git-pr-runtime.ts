import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── OpenPullRequest ToolRuntime (Coding Pipeline P4) ──
//
// Thin wrapper around `gh pr create` that handles the awkward parts
// the LLM gets wrong when invoking raw Bash:
//
//   1. Body is passed via stdin (not a shell argument) so it isn't
//      subject to quote/HEREDOC escaping bugs. LLM-composed PR bodies
//      are routinely multi-line markdown with backticks — the CLAUDE.md
//      convention of `$(cat <<'EOF'…EOF)` works but fails when the
//      body contains `EOF` or nested HEREDOCs. Streaming via stdin
//      sidesteps all of that.
//
//   2. Title is clamped to ~70 chars (CLAUDE.md §Creating pull
//      requests) — raw Bash lets the LLM ship 120-char titles that
//      render poorly in lists.
//
//   3. Refuses to push master/main unless the user has explicitly
//      authorised, matching CLAUDE.md safety protocol.
//
//   4. Required fields: title + body. base / head / draft are
//      optional (gh pr create has sane defaults).
//
// Assumes `gh` CLI is installed + authenticated. Installation errors
// surface as structured exceptions the LLM can interpret.

import { spawnSync } from 'node:child_process';

import { getSessionCwd } from '../session/working-dir.js';
import { debug } from '../debug/log.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';

const TITLE_MAX_CHARS = 90; // soft cap; hard refusal above 120

export interface OpenPullRequestArgs {
  title: string;
  body: string;
  /** Base branch. Default 'main'. */
  base?: string;
  /** Head branch. Default: current branch. */
  head?: string;
  /** Open as draft. Default false. */
  draft?: boolean;
  /** GitHub labels to attach on create (e.g. ['auto-review']). Each → `--label`. */
  labels?: string[];
}

export interface OpenPullRequestResult {
  output: string;
  url: string;
  number: number | null;
}

export function buildOpenPullRequestTool(): LLMToolSpec {
  return {
    name: 'OpenPullRequest',
    description:
      'Open a pull request via `gh pr create`, with body streamed through stdin to sidestep ' +
      'HEREDOC / quote escaping bugs the LLM hits in raw Bash. Title is clamped to ~90 chars. ' +
      'Refuses to push main/master as the head branch. Returns the PR URL.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: `PR title. Soft-capped at ${TITLE_MAX_CHARS} chars; titles longer than 120 chars are rejected.`,
        },
        body: {
          type: 'string',
          description:
            'Markdown body. Streamed via stdin so multi-line / backtick / nested-HEREDOC content is safe. ' +
            'Recommended structure: ## Summary / ## Why / ## Test plan.',
        },
        base: {
          type: 'string',
          description: 'Base branch. Default "main".',
        },
        head: {
          type: 'string',
          description: 'Head branch. Default: current branch.',
        },
        draft: {
          type: 'boolean',
          description: 'Open as a draft PR. Default false.',
        },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
  };
}

export function dispatchOpenPullRequest(
  args: OpenPullRequestArgs,
  opts: {
    cwd?: string;
    runner?: (cmd: string, argv: string[], stdin: string, cwd: string) => { stdout: string; stderr: string; status: number };
  } = {},
): OpenPullRequestResult {
  const cwd = opts.cwd ?? getSessionCwd();
  const runner = opts.runner ?? defaultGhRunner;

  if (!args.title || !args.title.trim()) throw new Error('OpenPullRequest: `title` is required');
  if (!args.body || !args.body.trim()) throw new Error('OpenPullRequest: `body` is required');
  if (args.title.length > 120) {
    throw new Error(`OpenPullRequest: title exceeds 120 chars (got ${args.title.length})`);
  }
  const head = args.head?.trim();
  if (head === 'main' || head === 'master') {
    throw new Error(`OpenPullRequest: refusing to open PR with head="${head}" — protected branch`);
  }
  const base = args.base?.trim() || 'main';

  const argv = ['pr', 'create', '--title', args.title.trim(), '--body-file', '-', '--base', base];
  if (head) argv.push('--head', head);
  if (args.draft) argv.push('--draft');
  for (const label of args.labels ?? []) { const l = label.trim(); if (l) argv.push('--label', l); }

  const res = runner('gh', argv, args.body, cwd);
  if (res.status !== 0) {
    const msg = res.stderr.trim() || res.stdout.trim() || 'unknown gh failure';
    throw new Error(`OpenPullRequest: gh pr create failed — ${msg}`);
  }
  const url = extractUrl(res.stdout) ?? res.stdout.trim();
  const number = extractNumber(url);
  return {
    output: `✓ PR opened: ${url}`,
    url,
    number,
  };
}

function extractUrl(stdout: string): string | null {
  const match = stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  return match ? match[0] : null;
}

function extractNumber(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)/);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function defaultGhRunner(
  cmd: string,
  argv: string[],
  stdin: string,
  cwd: string,
): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(cmd, argv, {
    cwd,
    encoding: 'utf8',
    input: stdin,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env, // 최소 PATH(cron)에서도 ensure-bin-path 보강 PATH 로 gh 를 찾도록 명시 전달.
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? -1,
  };
}

export const openPullRequestRuntime: ToolRuntime<OpenPullRequestArgs, OpenPullRequestResult> = {
  id: 'open_pull_request',
  spec: buildOpenPullRequestTool(),
  async run(req: OpenPullRequestArgs, _ctx: ToolRuntimeContext): Promise<OpenPullRequestResult> {
    return dispatchOpenPullRequest(req);
  },
};

// ── MergePullRequest (Coding Pipeline P4 followup) ────────────────────
//
// Thin wrapper around `gh pr merge` that closes the GitCommit →
// OpenPullRequest → MergePullRequest workflow without dropping back to
// raw Bash. Three merge strategies (squash | merge | rebase). Branch
// deletion is opt-in. `admin` is opt-in AND requires the user to set
// `ELANOUS_GH_ALLOW_ADMIN=1` in the environment — admin merges bypass
// branch protection and are easy to misfire on a shared repo.

export type MergeStrategy = 'squash' | 'merge' | 'rebase';

export interface MergePullRequestArgs {
  /** PR number on the current repo, OR a full PR URL. Exactly one is
   *  required — passing both is rejected. */
  number?: number;
  url?: string;
  /** Merge strategy. No default — caller MUST pick one explicitly so
   *  we never accidentally squash a multi-commit history the author
   *  wanted preserved (or vice versa). */
  strategy: MergeStrategy;
  /** Delete the branch on remote AND locally after merge. Default false. */
  deleteBranch?: boolean;
  /** When true, pass `--admin` so the merge bypasses branch protection.
   *  Doubly-gated: in addition to passing this arg the user must have
   *  `ELANOUS_GH_ALLOW_ADMIN=1` in their environment. Default false. */
  admin?: boolean;
  /** Wait for required checks to pass before merging (`--auto`).
   *  Mutually exclusive with `admin`. Default false. */
  auto?: boolean;
}

export interface MergePullRequestResult {
  output: string;
  /** Resolved PR identifier passed to `gh` — either a number string or
   *  the URL the caller supplied. Useful for downstream audit. */
  ref: string;
  strategy: MergeStrategy;
  deletedBranch: boolean;
  usedAdmin: boolean;
  usedAuto: boolean;
}

export function buildMergePullRequestTool(): LLMToolSpec {
  return {
    name: 'MergePullRequest',
    description:
      'Merge a pull request via `gh pr merge`. Pick a strategy (squash | merge | rebase) ' +
      'explicitly — no default, to avoid silently rewriting commit history. Pass `auto: true` ' +
      'to wait for required checks; `admin: true` bypasses branch protection but requires the ' +
      'user to set `ELANOUS_GH_ALLOW_ADMIN=1` in their environment as a second safety gate. ' +
      'Optional `deleteBranch: true` removes the branch on remote + local after merge.',
    parameters: {
      type: 'object',
      properties: {
        number: {
          type: 'number',
          description: 'PR number on the current repo. Exactly one of {number, url} is required.',
        },
        url: {
          type: 'string',
          description: 'Full PR URL (https://github.com/<owner>/<repo>/pull/<n>). Exactly one of {number, url}.',
        },
        strategy: {
          type: 'string',
          enum: ['squash', 'merge', 'rebase'],
          description:
            'Merge strategy. No default. Squash = collapse to a single commit on base. Merge = preserve ' +
            'history with a merge commit. Rebase = replay commits onto base.',
        },
        deleteBranch: {
          type: 'boolean',
          description: 'After successful merge, delete the head branch on remote AND locally. Default false.',
        },
        admin: {
          type: 'boolean',
          description:
            'Bypass branch protection (`--admin`). Requires both this flag AND env ELANOUS_GH_ALLOW_ADMIN=1. ' +
            'Mutually exclusive with `auto`.',
        },
        auto: {
          type: 'boolean',
          description: 'Wait for required checks (`--auto`). Mutually exclusive with `admin`.',
        },
      },
      required: ['strategy'],
      additionalProperties: false,
    },
  };
}

type MergePullRequestLog = (category: string, event: string, data?: Record<string, unknown>) => void;

function observeMergePullRequest(
  log: MergePullRequestLog,
  event: 'merged' | 'rejected',
  data: Record<string, unknown>,
): void {
  try { log('tool-runtime.git-pr', event, data); } catch { /* fail-soft */ }
}

export function dispatchMergePullRequest(
  args: MergePullRequestArgs,
  opts: {
    cwd?: string;
    runner?: (cmd: string, argv: string[], stdin: string, cwd: string) => { stdout: string; stderr: string; status: number };
    /** Override the env-var safety gate. Pass true to skip the env
     *  check (used in tests). Default consults `process.env.ELANOUS_GH_ALLOW_ADMIN`. */
    adminEnvAllowed?: boolean;
    log?: MergePullRequestLog;
  } = {},
): MergePullRequestResult {
  const cwd = opts.cwd ?? getSessionCwd();
  const runner = opts.runner ?? defaultGhRunner;
  const log = opts.log ?? debug.log.bind(debug);
  const reject = (reason: string): void => observeMergePullRequest(log, 'rejected', { reason });

  // Validate identifier — exactly one of number/url.
  const hasNumber = typeof args.number === 'number' && Number.isFinite(args.number) && args.number > 0;
  const hasUrl = typeof args.url === 'string' && args.url.trim().length > 0;
  if (hasNumber && hasUrl) {
    reject('identifier-both');
    throw new Error('MergePullRequest: pass exactly one of `number` or `url`, not both');
  }
  if (!hasNumber && !hasUrl) {
    reject('identifier-missing');
    throw new Error('MergePullRequest: one of `number` or `url` is required');
  }
  if (hasUrl && !/^https:\/\/github\.com\/[^\s]+\/pull\/\d+/.test(args.url!.trim())) {
    reject('identifier-invalid-url');
    throw new Error(`MergePullRequest: url ${JSON.stringify(args.url)} doesn't match https://github.com/.../pull/N`);
  }
  const ref = hasNumber ? String(args.number) : args.url!.trim();

  // Validate strategy explicitly to avoid passing through arbitrary strings.
  if (args.strategy !== 'squash' && args.strategy !== 'merge' && args.strategy !== 'rebase') {
    throw new Error(`MergePullRequest: invalid strategy ${JSON.stringify(args.strategy)} — pick squash | merge | rebase`);
  }

  // admin + auto are mutually exclusive.
  if (args.admin && args.auto) {
    reject('admin-auto-conflict');
    throw new Error('MergePullRequest: `admin` and `auto` are mutually exclusive — pick one');
  }

  // admin double-gate: env var must also be set.
  let usedAdmin = false;
  if (args.admin) {
    const envAllowed = opts.adminEnvAllowed ?? (process.env.ELANOUS_GH_ALLOW_ADMIN === '1');
    if (!envAllowed) {
      reject('admin-env-disallowed');
      throw new Error(
        'MergePullRequest: admin merge requested but ELANOUS_GH_ALLOW_ADMIN=1 is not set in env. ' +
        'Admin bypasses branch protection — set the env var explicitly to authorise.',
      );
    }
    usedAdmin = true;
  }

  const argv: string[] = ['pr', 'merge', ref, `--${args.strategy}`];
  if (args.deleteBranch) argv.push('--delete-branch');
  if (usedAdmin) argv.push('--admin');
  if (args.auto) argv.push('--auto');

  const res = runner('gh', argv, '', cwd);
  if (res.status !== 0) {
    reject('gh-failed');
    const msg = res.stderr.trim() || res.stdout.trim() || 'unknown gh failure';
    throw new Error(`MergePullRequest: gh pr merge failed — ${msg}`);
  }

  const summary = `✓ PR ${ref} merged via ${args.strategy}` +
    (args.deleteBranch ? ' (branch deleted)' : '') +
    (usedAdmin ? ' (--admin)' : '') +
    (args.auto ? ' (--auto, waiting for checks)' : '');
  const result = {
    output: summary + (res.stdout.trim() ? `\n${res.stdout.trim()}` : ''),
    ref,
    strategy: args.strategy,
    deletedBranch: !!args.deleteBranch,
    usedAdmin,
    usedAuto: !!args.auto,
  };
  observeMergePullRequest(log, 'merged', result);
  return result;
}

export const mergePullRequestRuntime: ToolRuntime<MergePullRequestArgs, MergePullRequestResult> = {
  id: 'merge_pull_request',
  spec: buildMergePullRequestTool(),
  async run(req: MergePullRequestArgs, _ctx: ToolRuntimeContext): Promise<MergePullRequestResult> {
    return dispatchMergePullRequest(req);
  },
};
