import { closeSync, constants, openSync, writeSync } from 'node:fs';

// Only fixed gh vocabulary and validated field identifiers may cross this boundary.
// Do not add positional arguments or error messages to the persisted record.
const SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  auth: new Set(['status', 'login', 'logout', 'token', 'refresh', 'setup-git']),
  project: new Set(['list', 'view', 'create', 'edit', 'delete', 'close', 'field-list', 'item-list']),
  cache: new Set(['list', 'delete']),
  codespace: new Set(['list', 'view', 'create', 'delete', 'ssh']),
  'ssh-key': new Set(['list', 'add', 'delete']),
  api: new Set(['graphql']),
  issue: new Set(['list', 'view', 'create', 'edit', 'close', 'reopen', 'comment', 'status']),
  pr: new Set(['list', 'view', 'create', 'edit', 'checkout', 'merge', 'close', 'reopen', 'comment', 'checks', 'diff', 'status', 'ready', 'review']),
  repo: new Set(['view', 'list', 'clone', 'create', 'edit', 'fork', 'sync']),
  run: new Set(['list', 'view', 'watch', 'rerun', 'cancel', 'download']),
  workflow: new Set(['list', 'view', 'run', 'enable', 'disable']),
  release: new Set(['list', 'view', 'create', 'edit', 'delete', 'download', 'upload']),
  label: new Set(['list', 'create', 'edit', 'delete', 'clone']),
  search: new Set(['code', 'commits', 'issues', 'prs', 'repos']),
  gist: new Set(['list', 'view', 'create', 'edit', 'delete', 'clone']),
  secret: new Set(['list', 'set', 'delete']),
  variable: new Set(['list', 'set', 'delete']),
};
// A syntactically valid identifier can still be a token passed as a --json value.
// Unknown names are counted, never copied into the log. Extend only from gh's documented fields.
const FIELDS = new Set([
  'additions', 'assignees', 'author', 'baseRefName', 'body', 'changedFiles', 'closed',
  'closedAt', 'comments', 'commits', 'createdAt', 'databaseId', 'deletions', 'files',
  'headRefName', 'headRepository', 'id', 'isDraft', 'isPrivate', 'labels', 'latestReviews',
  'maintainerCanModify', 'mergeCommit', 'mergeStateStatus', 'mergeable', 'mergedAt',
  'mergedBy', 'milestone', 'name', 'number', 'owner', 'projectCards', 'projectItems',
  'reactionGroups', 'reviewDecision', 'reviewRequests', 'reviews', 'state', 'status',
  'title', 'updatedAt', 'url', 'viewerCanUpdate', 'viewerDidAuthor', 'workflowName',
]);
const MAX_FIELDS = 100;
// Option arity is command-specific. Unsupported forms must not silently hide --json.
// This is deliberately a narrow allowlist, not a global inventory of gh flags.
const VALUE_OPTIONS_BY_COMMAND: Record<string, ReadonlySet<string>> = {
  'api graphql': new Set(['--field', '--raw-field', '-H', '--header', '--method', '-X', '--input']),
  'pr list': new Set(['-R', '--repo', '--limit', '-L', '--state', '-s', '--author', '--base', '--head', '--search', '-S', '--label', '-l', '--assignee', '-a', '--jq', '-q', '--template', '-t']),
  'pr view': new Set(['-R', '--repo', '--jq', '-q', '--template', '-t']),
  'issue list': new Set(['-R', '--repo', '--limit', '-L', '--state', '-s', '--author', '--assignee', '-a', '--label', '-l', '--search', '-S', '--jq', '-q', '--template', '-t']),
  'run list': new Set(['-R', '--repo', '--limit', '-L', '-w', '--workflow', '--branch', '--jq', '-q', '--template', '-t']),
};
const SWITCH_OPTIONS_BY_COMMAND: Record<string, ReadonlySet<string>> = {
  'repo list': new Set(['-s', '--source']),
  'pr create': new Set(['-w', '--web']),
};
const UNIVERSAL_SWITCH_OPTIONS = new Set(['--help', '-h']);

type CaptureRow = { command: string; fields: string[] | 'unknown'; unknown: boolean };

export function classifyGhCall(args: readonly string[]): CaptureRow {
  const root = args[0];
  const sub = args[1];
  const command = root && Object.hasOwn(SUBCOMMANDS, root)
    ? root === 'api' ? (sub === 'graphql' ? 'api graphql' : 'api')
      : sub && SUBCOMMANDS[root]!.has(sub) ? `${root} ${sub}` : 'unknown'
    : 'unknown';
  let unknown = command === 'unknown';
  let fields: string[] = [];
  let seen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') break;
    if (VALUE_OPTIONS_BY_COMMAND[command]?.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('-')) unknown = true;
      continue;
    }
    if (SWITCH_OPTIONS_BY_COMMAND[command]?.has(arg) || UNIVERSAL_SWITCH_OPTIONS.has(arg)) continue;
    // Sensitive payload options consume one argument without inspecting or retaining its contents.
    if (arg === '--body' || arg === '-f' || arg === '-F') {
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) {
        unknown = true;
        i--; // Parse the next option too; a missing payload must never hide --json.
      }
      continue;
    }
    if (arg === '--json' || arg.startsWith('--json=')) {
      if (seen || root === 'api') unknown = true;
      seen = true;
      const value = arg === '--json' ? args[++i] : arg.slice('--json='.length);
      const parts = value?.split(',');
      if (!parts?.length || parts.length > MAX_FIELDS || parts.some((part) => !FIELDS.has(part))) {
        unknown = true;
      } else {
        fields = parts;
      }
    } else if (arg.startsWith('--json')) {
      unknown = true;
    } else if (arg.startsWith('-') && arg !== '-') {
      // Unknown options can consume arguments; fail closed rather than infer fields.
      unknown = true;
    }
  }
  return { command, fields: unknown ? 'unknown' : fields, unknown };
}

export function captureGhCall(args: readonly string[], file: string): void {
  const row = JSON.stringify(classifyGhCall(args)) + '\n';
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
  try {
    // One bounded append per invocation: concurrent children cannot interleave JSONL fragments.
    if (writeSync(fd, row) !== Buffer.byteLength(row)) throw new Error('short JSONL write');
  } finally {
    closeSync(fd);
  }
}

if (import.meta.main) {
  const file = process.env.ELANOUS_GH_SURFACE_JSONL;
  if (!file) {
    console.error('gh-surface: JSONL destination not configured');
    process.exitCode = 70;
  } else {
    try {
      captureGhCall(process.argv.slice(2), file);
    } catch {
      // Filesystem exception text can contain a path or user input.
      console.error('gh-surface: capture failed');
      process.exitCode = 70;
    }
  }
}
