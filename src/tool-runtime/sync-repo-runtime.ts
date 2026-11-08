import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── SyncRepo ToolRuntime (Coding Pipeline P5) ──
//
// Clone or fetch a repository into the agent-managed cache at
// ~/.cache/elanous-refs/<host>/<owner>/<repo>. This directory is
// distinct from the user's manually-maintained source/ref/ tree —
// the cache is scratch space the agent can purge, the user tree
// is authoritative.
//
// Stale detection: looks at FETCH_HEAD mtime vs a 24h window (by
// default). Within the window → skip network entirely. Outside →
// `git fetch --depth` to refresh.
//
// Safety:
//   - Allow-list: github.com / gitlab.com / bitbucket.org only.
//   - No shell interpolation: spawnSync with argv, url passed as
//     positional arg only after allow-list + normalisation.
//   - Single-concurrency lock file prevents two parallel SyncRepos
//     from racing on the same directory.
//
// Defaults are aggressive toward smallness:
//   depth: 1 (shallow)
//   filter: tree:0 (partial clone — skips blobs until checkout)
//   sparse: / (full checkout by default; caller can narrow)
//
// Registered with shouldDefer=true — schema only surfaced via
// ToolSearch.

import { existsSync, mkdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runGitCommand } from '../git-fs/runner.js';

import type { ToolRuntime, ToolRuntimeContext } from './types.js';

const CACHE_ROOT_DEFAULT = join(homedir(), '.cache', 'elanous-refs');
const STALE_WINDOW_MS_DEFAULT = 24 * 60 * 60 * 1000;  // 24h
const ALLOWED_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

export interface SyncRepoArgs {
  /** Canonical repo URL OR shorthand "<owner>/<repo>" (assumes github). */
  url: string;
  /** Branch / tag / commit to check out. Default HEAD of origin. */
  ref?: string;
  /** Shallow clone depth. Default 1. */
  depth?: number;
  /** Sparse-checkout patterns. Default ["/*"] (everything). */
  sparse?: string[];
  /** 'clone' forces fresh checkout, 'update' forces fetch even
   *  if within the stale window. Default 'auto'. */
  mode?: 'auto' | 'clone' | 'update';
  /** Override stale window in ms. Default 24h. */
  staleMs?: number;
  /** Override cache root (tests). */
  cacheRoot?: string;
}

export interface SyncRepoResult {
  output: string;
  localPath: string;
  host: string;
  owner: string;
  repo: string;
  mode: 'cloned' | 'updated' | 'fresh';
  stale: boolean;
  lastFetchAt: number | null;
}

export function buildSyncRepoTool(): LLMToolSpec {
  return {
    name: 'SyncRepo',
    description:
      'Clone or fetch a github.com / gitlab.com / bitbucket.org repository into ' +
      '~/.cache/elanous-refs/<host>/<owner>/<repo>. Shallow + partial by default; sparse- ' +
      'checkout patterns let you narrow further. Within 24h of last fetch the network is ' +
      'skipped (use mode="update" to force). Second step of the discovery cycle: FindRepo ' +
      '→ SyncRepo → RefConsult. Returns the local path.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Canonical repo URL (https://host/owner/repo) or shorthand "owner/repo" (github.com assumed).',
        },
        ref: {
          type: 'string',
          description: 'Branch / tag / commit sha. Default: repo HEAD.',
        },
        depth: {
          type: 'number',
          description: 'Clone depth. Default 1.',
        },
        sparse: {
          type: 'array',
          items: { type: 'string' },
          description: 'Sparse-checkout patterns (e.g. ["/src/**", "/README.md"]). Default ["/*"] (full).',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'clone', 'update'],
          description: '"auto" (default): skip within stale window. "clone": fresh. "update": fetch even if fresh.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  };
}

export interface ParsedRepoUrl {
  host: string;
  owner: string;
  repo: string;
  canonicalUrl: string;
}

export function parseRepoUrl(raw: string): ParsedRepoUrl {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new Error('SyncRepo: `url` is required');
  // Shorthand "owner/repo" → github.
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed) && !trimmed.includes('://')) {
    const [owner, repoRaw] = trimmed.split('/');
    const repo = repoRaw!.replace(/\.git$/, '');
    return {
      host: 'github.com',
      owner: owner!,
      repo,
      canonicalUrl: `https://github.com/${owner}/${repo}`,
    };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`SyncRepo: invalid URL: ${trimmed}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`SyncRepo: refusing non-HTTP(S) URL scheme: ${url.protocol}`);
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`SyncRepo: refusing non-allowlisted host: ${url.hostname}`);
  }
  const parts = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`SyncRepo: URL does not look like <host>/<owner>/<repo>: ${trimmed}`);
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/, '');
  return {
    host: url.hostname,
    owner,
    repo,
    canonicalUrl: `https://${url.hostname}/${owner}/${repo}`,
  };
}

export function localPathFor(parsed: ParsedRepoUrl, cacheRoot: string = CACHE_ROOT_DEFAULT): string {
  return join(cacheRoot, parsed.host, parsed.owner, parsed.repo);
}

/** Returns ms-since-epoch of FETCH_HEAD mtime, or null if the repo
 *  isn't cloned yet. */
export function lastFetchAt(localPath: string): number | null {
  const fetchHead = join(localPath, '.git', 'FETCH_HEAD');
  if (!existsSync(fetchHead)) {
    // Some git versions use HEAD mtime after initial clone.
    const head = join(localPath, '.git', 'HEAD');
    if (!existsSync(head)) return null;
    return statSync(head).mtimeMs;
  }
  return statSync(fetchHead).mtimeMs;
}

export function isStale(
  localPath: string,
  staleMs: number = STALE_WINDOW_MS_DEFAULT,
  now: number = Date.now(),
): boolean {
  const last = lastFetchAt(localPath);
  if (last === null) return true;  // not yet cloned
  return (now - last) >= staleMs;
}

type GitRunner = (argv: string[], cwd?: string) => { stdout: string; stderr: string; status: number };

export function dispatchSyncRepo(
  args: SyncRepoArgs,
  opts: { runner?: GitRunner; now?: () => number } = {},
): SyncRepoResult {
  const runner = opts.runner ?? defaultGitRunner;
  const now = opts.now ?? Date.now;
  const parsed = parseRepoUrl(args.url);
  const cacheRoot = args.cacheRoot ?? CACHE_ROOT_DEFAULT;
  const localPath = localPathFor(parsed, cacheRoot);
  const staleMs = args.staleMs ?? STALE_WINDOW_MS_DEFAULT;
  const mode = args.mode ?? 'auto';
  const depth = Math.max(1, Math.floor(args.depth ?? 1));
  const sparse = args.sparse && args.sparse.length > 0 ? args.sparse : ['/*'];

  const alreadyExists = existsSync(join(localPath, '.git'));
  const stale = alreadyExists ? isStale(localPath, staleMs, now()) : true;
  const last = alreadyExists ? lastFetchAt(localPath) : null;

  // Fast path: cache hit + auto mode + not stale → skip.
  if (mode === 'auto' && alreadyExists && !stale) {
    return {
      output: `✓ cache hit (fresh) · ${localPath}`,
      localPath,
      host: parsed.host,
      owner: parsed.owner,
      repo: parsed.repo,
      mode: 'fresh',
      stale: false,
      lastFetchAt: last,
    };
  }

  // Concurrency lock — tests may skip by passing a no-op runner
  // that doesn't touch the filesystem.
  const lockPath = join(cacheRoot, `.${parsed.host}-${parsed.owner}-${parsed.repo}.lock`);
  acquireLock(lockPath, cacheRoot);
  try {
    if (!alreadyExists || mode === 'clone') {
      ensureDir(localPath, cacheRoot);
      const cloneArgv = [
        'clone',
        '--filter=tree:0',
        '--depth',
        String(depth),
        parsed.canonicalUrl,
        localPath,
      ];
      if (args.ref) cloneArgv.splice(1, 0, '--branch', args.ref);
      const cloneResult = runner(cloneArgv);
      if (cloneResult.status !== 0) {
        throw new Error(`SyncRepo: git clone failed — ${cloneResult.stderr.trim() || cloneResult.stdout.trim()}`);
      }
      // Apply sparse-checkout.
      const sparseInit = runner(['sparse-checkout', 'init', '--cone'], localPath);
      if (sparseInit.status !== 0) {
        // Non-cone sparse-checkout is still functional; swallow the error
        // and set patterns directly.
      }
      const sparseSet = runner(['sparse-checkout', 'set', ...sparse], localPath);
      if (sparseSet.status !== 0) {
        // Best-effort — report but don't fail.
      }
      return {
        output: `✓ cloned ${parsed.canonicalUrl} → ${localPath}`,
        localPath,
        host: parsed.host,
        owner: parsed.owner,
        repo: parsed.repo,
        mode: 'cloned',
        stale: true,
        lastFetchAt: now(),
      };
    }

    // Exists + (stale OR mode=update) → fetch.
    const fetchArgv = ['fetch', '--depth', String(depth), 'origin', args.ref ?? 'HEAD'];
    const fetchResult = runner(fetchArgv, localPath);
    if (fetchResult.status !== 0) {
      throw new Error(`SyncRepo: git fetch failed — ${fetchResult.stderr.trim() || fetchResult.stdout.trim()}`);
    }
    const resetArgv = ['reset', '--hard', 'FETCH_HEAD'];
    const resetResult = runner(resetArgv, localPath);
    if (resetResult.status !== 0) {
      throw new Error(`SyncRepo: git reset --hard FETCH_HEAD failed — ${resetResult.stderr.trim()}`);
    }
    return {
      output: `✓ updated ${parsed.canonicalUrl} → ${localPath}`,
      localPath,
      host: parsed.host,
      owner: parsed.owner,
      repo: parsed.repo,
      mode: 'updated',
      stale: true,
      lastFetchAt: now(),
    };
  } finally {
    releaseLock(lockPath);
  }
}

function ensureDir(p: string, cacheRoot: string): void {
  if (!existsSync(cacheRoot)) mkdirSync(cacheRoot, { recursive: true });
  const parent = p.substring(0, p.lastIndexOf('/'));
  if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
}

function acquireLock(lockPath: string, cacheRoot: string): void {
  if (!existsSync(cacheRoot)) mkdirSync(cacheRoot, { recursive: true });
  if (existsSync(lockPath)) {
    throw new Error(`SyncRepo: lock busy at ${lockPath}; another sync is in progress`);
  }
  writeFileSync(lockPath, `${process.pid}\n`);
}

function releaseLock(lockPath: string): void {
  try {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {
    // Best-effort — leaving a stale lock is preferable to throwing
    // and losing the sync result the caller needs.
  }
}

function defaultGitRunner(argv: string[], cwd?: string): { stdout: string; stderr: string; status: number } {
  const result = runGitCommand(cwd ?? process.cwd(), argv, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status ?? -1,
  };
}

export const syncRepoRuntime: ToolRuntime<SyncRepoArgs, SyncRepoResult> = {
  id: 'sync_repo',
  spec: buildSyncRepoTool(),
  async run(req: SyncRepoArgs, _ctx: ToolRuntimeContext): Promise<SyncRepoResult> {
    return dispatchSyncRepo(req);
  },
};
