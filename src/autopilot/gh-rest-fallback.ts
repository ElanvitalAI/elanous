import { debug } from '../debug/log.js';
import type { CmdResult, CmdRunner } from './pr-manager.js';

type Pull = Record<string, unknown>;

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasOnlyFlags(args: readonly string[], start: number, valued: readonly string[], bare: readonly string[] = []): boolean {
  for (let i = start; i < args.length; i++) {
    if (bare.includes(args[i]!)) continue;
    if (!valued.includes(args[i]!) || args[++i] === undefined) return false;
  }
  return true;
}

function repoFromOrigin(run: CmdRunner, opts?: { cwd?: string }): { owner: string; repo: string } | null {
  const remote = run('git', ['remote', 'get-url', 'origin'], opts);
  if (!remote.ok) return null;
  const value = remote.out.trim();
  let path: string;
  try {
    const url = new URL(value);
    if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com') return null;
    path = url.pathname;
  } catch {
    const scp = /^(?:[^@/]+@)?github\.com:([^\s]+)$/.exec(value);
    if (!scp) return null;
    path = scp[1]!;
  }
  const match = /^\/?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(path);
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

function prNumber(value: string, owner: string, repo: string): string | null {
  if (/^[1-9]\d*$/.test(value)) return value;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(value);
  return match && match[1] === owner && match[2] === repo ? match[3]! : null;
}

function readPull(result: CmdResult): Pull | null {
  if (!result.ok) return null;
  try {
    const value: unknown = JSON.parse(result.out);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Pull : null;
  } catch { return null; }
}

function pullField(pull: Pull, field: string): unknown {
  switch (field) {
    case 'state': return pull.merged_at ? 'MERGED' : pull.state === 'open' ? 'OPEN' : pull.state === 'closed' && pull.merged_at === null ? 'CLOSED' : undefined;
    case 'isDraft': return pull.draft;
    case 'baseRefName': return (pull.base as Pull | undefined)?.ref;
    case 'headRefName': return (pull.head as Pull | undefined)?.ref;
    case 'headRepository': {
      const nameWithOwner = ((pull.head as Pull | undefined)?.repo as Pull | undefined)?.full_name;
      return typeof nameWithOwner === 'string' ? { nameWithOwner } : undefined;
    }
    case 'mergeable': return pull.mergeable === true ? 'MERGEABLE' : pull.mergeable === false ? 'CONFLICTING' : pull.mergeable === null ? 'UNKNOWN' : undefined;
    case 'mergeStateStatus': {
      const state = pull.mergeable_state;
      return typeof state === 'string' && ['behind', 'blocked', 'clean', 'dirty', 'draft', 'has_hooks', 'unknown', 'unstable'].includes(state)
        ? state.toUpperCase() : undefined;
    }
    default: return undefined;
  }
}

function restCall(run: CmdRunner, args: string[], opts?: { cwd?: string }): CmdResult {
  return run('gh', ['api', ...args], opts);
}

/** Retry exactly once via REST after the secondary GraphQL limit; unsupported shapes fail closed. */
export function withGhRestFallback(run: CmdRunner): CmdRunner {
  return (cmd, args, opts) => {
    const original = run(cmd, args, opts);
    if (cmd !== 'gh' || args[0] !== 'pr' || original.ok ||
        !/GraphQL/i.test(`${original.out}\n${original.err ?? ''}`) ||
        !/API rate limit/i.test(`${original.out}\n${original.err ?? ''}`)) return original;
    const sub = args[1];
    if (!['list', 'view', 'create', 'edit', 'merge', 'comment'].includes(sub ?? '')) return original;
    if (sub === 'list' && !args.includes('--json')) return original;
    const location = repoFromOrigin(run, opts);
    if (!location) return original;
    const { owner, repo } = location;
    const path = `repos/${owner}/${repo}`;
    let result: CmdResult | null = null;

    if (sub === 'list' && args[2] === '--head' && args[3] && args[4] === '--state' && args[5] === 'open' &&
        args[6] === '--json' && args[7] === 'url' &&
        (args.length === 8 || (args.length === 10 && args[8] === '--jq' && args[9] === '.[0].url // ""'))) {
      const listed = restCall(run, [`${path}/pulls?head=${encodeURIComponent(`${owner}:${args[3]}`)}&state=open`], opts);
      if (listed.ok) {
        try {
          const items: unknown = JSON.parse(listed.out);
          if (Array.isArray(items) && items.every((item) => item && typeof item.html_url === 'string')) {
            const urls = items.map((item) => ({ url: item.html_url as string }));
            result = { ok: true, out: args[8] === '--jq' ? (urls[0]?.url ?? '') : JSON.stringify(urls) };
          }
        } catch { /* malformed REST response */ }
      } else result = listed;
    } else if (sub === 'view' && args[2] && args[3] === '--json' && args[4] &&
        hasOnlyFlags(args, 5, ['--jq', '-q'])) {
      const number = prNumber(args[2], owner, repo);
      const fields = args[4].split(',');
      const jq = flag(args, '--jq') ?? flag(args, '-q');
      if (number && fields.every((field) => ['state', 'isDraft', 'mergeable', 'baseRefName', 'mergeStateStatus', 'headRefName', 'headRepository'].includes(field)) &&
          (!jq || (fields.length === 1 && jq === `.${fields[0]}`))) {
        const response = restCall(run, [`${path}/pulls/${number}`], opts);
        const pull = readPull(response);
        if (pull) {
          const mapped = Object.fromEntries(fields.map((field) => [field, pullField(pull, field)]));
          if (Object.values(mapped).every((value) => value !== undefined)) {
            const selected = mapped[fields[0]!];
            result = { ok: true, out: jq
              ? typeof selected === 'string' ? selected : JSON.stringify(selected)
              : JSON.stringify(mapped) };
          }
        } else if (!response.ok) result = response;
      }
    } else if (sub === 'create' && hasOnlyFlags(args, 2, ['--head', '--title', '--body', '--base'], ['--draft']) &&
        flag(args, '--head') && flag(args, '--title') !== undefined && flag(args, '--body') !== undefined) {
      let base = flag(args, '--base');
      if (!base) {
        const repository = restCall(run, [path], opts);
        if (!repository.ok) result = repository;
        else {
          const defaultBranch = readPull(repository)?.default_branch;
          if (typeof defaultBranch === 'string' && defaultBranch) base = defaultBranch;
        }
      }
      if (base) {
        const parameters = ['-f', `head=${flag(args, '--head')}`, '-f', `title=${flag(args, '--title')}`, '-f', `body=${flag(args, '--body')}`, '-f', `base=${base}`];
        if (args.includes('--draft')) parameters.push('-F', 'draft=true');
        const response = restCall(run, ['--method', 'POST', `${path}/pulls`, ...parameters], opts);
        const pull = readPull(response);
        if (pull && typeof pull.html_url === 'string') result = { ok: true, out: pull.html_url };
        else if (!response.ok) result = response;
      }
    } else if (sub === 'edit' && args[2] && hasOnlyFlags(args, 3, ['--title', '--body', '--base']) &&
        flag(args, '--title') !== undefined && flag(args, '--body') !== undefined) {
      const number = prNumber(args[2], owner, repo);
      if (number) {
        const parameters = ['-f', `title=${flag(args, '--title')}`, '-f', `body=${flag(args, '--body')}`];
        if (flag(args, '--base')) parameters.push('-f', `base=${flag(args, '--base')}`);
        const response = restCall(run, ['--method', 'PATCH', `${path}/pulls/${number}`, ...parameters], opts);
        if (readPull(response)) result = { ok: true, out: '' };
        else if (!response.ok) result = response;
      }
    } else if (sub === 'merge' && args[2] && args[3] === '--squash' && args.length === 4) {
      const number = prNumber(args[2], owner, repo);
      if (number) {
        const head = restCall(run, [`${path}/pulls/${number}`], opts);
        const sha = (readPull(head)?.head as Pull | undefined)?.sha;
        if (typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha)) {
          const response = restCall(run, ['--method', 'PUT', `${path}/pulls/${number}/merge`, '-f', 'merge_method=squash', '-f', `sha=${sha}`], opts);
          const body = readPull(response);
          if (body?.merged === true) result = { ok: true, out: '' };
          else if (!response.ok) result = response;
        } else if (!head.ok) result = head;
      }
    } else if (sub === 'comment' && args[2] && args[3] === '--body' && args[4] !== undefined && args.length === 5) {
      const number = prNumber(args[2], owner, repo);
      if (number) {
        const response = restCall(run, ['--method', 'POST', `${path}/issues/${number}/comments`, '-f', `body=${args[4]}`], opts);
        if (readPull(response)) result = { ok: true, out: '' };
        else if (!response.ok) result = response;
      }
    }
    if (!result) return original;
    debug.log('autopilot.pr', 'rest-fallback', { sub, ok: result.ok });
    process.stderr.write(`[gh] REST 폴백: pr ${sub}\n`);
    return result;
  };
}
