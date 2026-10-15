// ── RefConsult ToolRuntime (Coding Pipeline P5) ──
//
// Third step of the discovery cycle: FindRepo → SyncRepo →
// RefConsult. Runs a grep or read against a previously-SyncRepo'd
// local cache at ~/.cache/elanous-refs/<host>/<owner>/<repo>.
//
// This tool is INTENTIONALLY THIN — it delegates to ripgrep (`rg`)
// via spawnSync when mode='grep', or to plain fs.readFileSync when
// mode='read'. No shell interpolation. No sync logic: if the repo
// isn't in the cache, RefConsult says so and the LLM should call
// SyncRepo first.
//
// The separation (discovery vs sync vs consult) keeps each turn
// cheap — an LLM that already has the cache hit from an earlier
// turn can consult repeatedly without the 2-4s clone delay.
//
// Registered with shouldDefer=true — schema only surfaced via
// ToolSearch.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LLMToolSpec } from '../llm.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';
import { DEFAULT_REFERENCE_ROOTS, denyNonPublicReference } from '../agent/ref-grounding.js';   // ★ F3 — 로컬 canonical ref 루트
import { debug } from '../debug/log.js';

const CACHE_ROOT_DEFAULT = join(homedir(), '.cache', 'elanous-refs');
const DEFAULT_HEAD_LIMIT = 200;
const MAX_HEAD_LIMIT = 2000;
const READ_MAX_BYTES = 500_000;

export interface RefConsultArgs {
  /** Repo host: 'github.com' / 'gitlab.com' / 'bitbucket.org'. Default 'github.com'. */
  host?: string;
  owner: string;
  repo: string;
  /** Mode: 'grep' (ripgrep) | 'read' (full file). */
  mode: 'grep' | 'read';
  /** Required for grep mode. Regex pattern. */
  query?: string;
  /** Required for read mode. Path relative to repo root. */
  path?: string;
  /** Grep: max output lines. Default 200, hard cap 2000. */
  headLimit?: number;
  /** Grep: case-insensitive. */
  ignoreCase?: boolean;
  /** Grep: glob filter, e.g. star-star-slash-star.ts style pattern. */
  glob?: string;
  /** Read: max bytes. Default 500k. */
  maxBytes?: number;
  /** Override cache root (tests). */
  cacheRoot?: string;
  /** ★ F3(2026-07-22) — 로컬 canonical ref 루트 오버라이드(테스트·기본 ~/source/ref). */
  referenceRoots?: readonly string[];
}

export interface RefConsultResult {
  output: string;
  mode: 'grep' | 'read';
  repoPath: string;
  /** grep mode only */
  matches?: number;
  truncated?: boolean;
  /** read mode only */
  bytesRead?: number;
}

export function buildRefConsultTool(): LLMToolSpec {
  return {
    name: 'RefConsult',
    description:
      'Grep or read inside a repo — resolved from the SyncRepo cache ' +
      '(~/.cache/elanous-refs/<host>/<owner>/<repo>) OR the local canonical ref tree ' +
      '(~/source/ref/<repo>, no SyncRepo needed for repos already there). Third step of the ' +
      'discovery cycle. mode="grep" delegates to ripgrep; mode="read" returns a bounded file ' +
      'slice. Fails fast only if the repo is in neither cache nor ~/source/ref.',
    parameters: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description: 'Repository host. Default "github.com".',
        },
        owner: { type: 'string', description: 'Repo owner / org.' },
        repo: { type: 'string', description: 'Repo name.' },
        mode: {
          type: 'string',
          enum: ['grep', 'read'],
          description: '"grep" for regex search; "read" for single-file fetch.',
        },
        query: {
          type: 'string',
          description: 'Grep pattern (regex). Required when mode="grep".',
        },
        path: {
          type: 'string',
          description: 'File path relative to repo root. Required when mode="read".',
        },
        headLimit: {
          type: 'number',
          description: `Grep: max output lines. Default ${DEFAULT_HEAD_LIMIT}, hard cap ${MAX_HEAD_LIMIT}.`,
        },
        ignoreCase: { type: 'boolean', description: 'Grep: case-insensitive.' },
        glob: { type: 'string', description: 'Grep: filename glob (e.g. "**/*.ts").' },
        maxBytes: {
          type: 'number',
          description: `Read: byte cap. Default ${READ_MAX_BYTES}.`,
        },
      },
      required: ['owner', 'repo', 'mode'],
      additionalProperties: false,
    },
  };
}

type RgRunner = (argv: string[], cwd: string) => { stdout: string; stderr: string; status: number };

export function dispatchRefConsult(
  args: RefConsultArgs,
  opts: { runner?: RgRunner } = {},
): RefConsultResult {
  const host = args.host ?? 'github.com';
  const cacheRoot = args.cacheRoot ?? CACHE_ROOT_DEFAULT;
  // 대표 2026-10-14 — 비공개 소스(Claude Code 사본)는 캐시·로컬 ref 어느 쪽이든 조회하지 않는다.
  //   owner·repo 는 단일 경로 성분이어야 한다 — `<사본 이름>/.` 같은 값이 join() 정규화로 이름 판정을 우회하지 못하게.
  for (const [field, value] of [['owner', args.owner], ['repo', args.repo]] as const) {
    if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
      throw new Error(`RefConsult: ${field} must be a single path segment (got ${JSON.stringify(value)})`);
    }
  }
  //   판정은 `repo` 칸만 — 공개 저장소 owner 이름이 우연히 같아도 막지 않는다(로컬 중첩 경로는 아래에서 따로 거른다).
  if (denyNonPublicReference(args.repo)) {
    throw new Error(`RefConsult: ${args.owner}/${args.repo} is a non-public source and is not consulted. Use public documentation instead.`);
  }
  // ★ F3(2026-07-22) — repo 경로 해석을 fallback 체인으로: ①에이전트 scratch 캐시(SyncRepo 산출·있으면 우선)
  //   → ②로컬 canonical ref(~/source/ref/<repo>·flat bare-name·재클론 없이 90 repo 즉시 grep) → ③둘 다 없으면
  //   throw. 종전엔 캐시만 봐서 캐시 미존재 시 canonical ref 가 놀아도 "SyncRepo 먼저" 로 죽던 단절을 연결.
  //   grep/read 로직은 repoPath 만 바뀌면 무변경. 관측(debug.log)로 어느 소스서 resolve 됐는지 남긴다(제1원칙).
  const cachePath = join(cacheRoot, host, args.owner, args.repo);
  let repoPath = cachePath;
  let source: 'cache' | 'local-ref' = 'cache';
  if (!existsSync(join(cachePath, '.git'))) {
    const roots = args.referenceRoots ?? DEFAULT_REFERENCE_ROOTS;
    const localHit = roots
      .flatMap((root) => [
        join(root, args.repo),
        // 로컬 ref 의 <owner>/<repo> 중첩은 owner 디렉터리가 비공개 사본이면 그 아래로 내려가지 않는다.
        ...(denyNonPublicReference(args.owner) ? [] : [join(root, args.owner, args.repo)]),
      ])
      .find((p) => existsSync(join(p, '.git')));
    if (localHit) { repoPath = localHit; source = 'local-ref'; }
    else {
      throw new Error(
        `RefConsult: ${args.owner}/${args.repo} not in cache at ${cachePath} nor in local ref roots. Call SyncRepo first (or place under ~/source/ref).`,
      );
    }
  }
  try { debug.log('ref-consult', 'resolve', { owner: args.owner, repo: args.repo, source, path: repoPath.slice(-60) }); } catch { /* fail-soft */ }

  if (args.mode === 'grep') {
    const runner = opts.runner ?? defaultRgRunner;
    const query = args.query?.trim();
    if (!query) throw new Error('RefConsult: `query` required when mode="grep"');
    const headLimit = Math.min(
      Math.max(1, Math.floor(args.headLimit ?? DEFAULT_HEAD_LIMIT)),
      MAX_HEAD_LIMIT,
    );
    const argv = ['--line-number', '--no-heading', '--color=never'];
    if (args.ignoreCase) argv.push('-i');
    if (args.glob) argv.push('--glob', args.glob);
    argv.push('--max-count', String(headLimit));
    argv.push(query);
    const res = runner(argv, repoPath);
    // rg exit 0 = matches, 1 = no matches, 2 = error
    if (res.status !== 0 && res.status !== 1) {
      throw new Error(`RefConsult: ripgrep failed — ${res.stderr.trim() || res.stdout.trim()}`);
    }
    const lines = res.stdout.split('\n').filter((l) => l.length > 0);
    const truncated = lines.length >= headLimit;
    const display = truncated ? lines.slice(0, headLimit) : lines;
    const header = lines.length === 0
      ? `# RefConsult grep: 0 matches in ${args.owner}/${args.repo}`
      : `# RefConsult grep: ${display.length}${truncated ? `+ (truncated at ${headLimit})` : ''} matches in ${args.owner}/${args.repo}`;
    return {
      output: `${header}\n${display.join('\n')}`,
      mode: 'grep',
      repoPath,
      matches: display.length,
      truncated,
    };
  }

  // read mode
  const relPath = args.path?.trim();
  if (!relPath) throw new Error('RefConsult: `path` required when mode="read"');
  if (relPath.includes('..') || relPath.startsWith('/')) {
    throw new Error(`RefConsult: path must be relative and within the repo (got ${relPath})`);
  }
  const abs = join(repoPath, relPath);
  if (!existsSync(abs)) {
    throw new Error(`RefConsult: file not found: ${relPath}`);
  }
  const maxBytes = Math.max(1024, Math.floor(args.maxBytes ?? READ_MAX_BYTES));
  const stat = statSync(abs);
  if (stat.size > maxBytes * 4) {
    throw new Error(
      `RefConsult: file too large (${stat.size} bytes > ${maxBytes * 4} hard cap); read a subset with grep instead.`,
    );
  }
  const raw = readFileSync(abs);
  const truncated = raw.length > maxBytes;
  const body = truncated ? raw.slice(0, maxBytes).toString('utf8') : raw.toString('utf8');
  const header = `# RefConsult read: ${args.owner}/${args.repo}/${relPath} (${raw.length} bytes${truncated ? `, truncated to ${maxBytes}` : ''})`;
  return {
    output: `${header}\n${body}`,
    mode: 'read',
    repoPath,
    bytesRead: truncated ? maxBytes : raw.length,
  };
}

function defaultRgRunner(argv: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const res = spawnSync('rg', argv, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? -1,
  };
}

export const refConsultRuntime: ToolRuntime<RefConsultArgs, RefConsultResult> = {
  id: 'ref_consult',
  spec: buildRefConsultTool(),
  async run(req: RefConsultArgs, _ctx: ToolRuntimeContext): Promise<RefConsultResult> {
    return dispatchRefConsult(req);
  },
};
