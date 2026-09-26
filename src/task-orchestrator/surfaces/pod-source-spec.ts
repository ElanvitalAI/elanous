/** 사람이 고른 Pod 원천 spec — `commit:` · `pr:` · `worktree:` · `files:`.
 *  commit·pr 은 그대로 넘기고, worktree·files 는 호스트에서 포장해 bundle 로 만든다. */

import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { packSourceBundle } from './pod-source-bundle.js';
import type { PodSource } from './pod-source-receive.js';

export type ParsedPodSource =
  | { kind: 'commit'; sha: string }
  | { kind: 'pr'; number: number }
  | { kind: 'worktree'; path: string }
  | { kind: 'files'; paths: string[] };

const SHA40 = /^[0-9a-f]{40}$/;

export function parsePodSourceSpec(spec: string): ParsedPodSource {
  const text = spec.trim();
  const colon = text.indexOf(':');
  if (colon < 1) throw new Error(`unknown source spec '${spec}' — expected commit:<40-hex> | pr:<integer> | worktree:<path> | files:<path>[,<path>…]`);
  const kind = text.slice(0, colon);
  const rest = text.slice(colon + 1);
  if (kind === 'commit') {
    if (!SHA40.test(rest)) throw new Error(`commit sha must be 40 hex characters (got '${rest}')`);
    return { kind: 'commit', sha: rest };
  }
  if (kind === 'pr') {
    if (!/^[1-9][0-9]*$/.test(rest)) throw new Error(`pr number must be a positive integer (got '${rest}')`);
    const number = Number(rest);
    if (!Number.isSafeInteger(number)) throw new Error(`pr number must be a positive integer (got '${rest}')`);
    return { kind: 'pr', number };
  }
  if (kind === 'worktree') {
    if (!rest || rest.startsWith('-')) throw new Error(`worktree path is empty or unsafe (got '${rest}')`);
    return { kind: 'worktree', path: rest };
  }
  if (kind === 'files') {
    const paths = rest.split(',').map((path) => path.trim()).filter((path) => path.length > 0);
    if (paths.length === 0) throw new Error('files requires at least one path');
    if (paths.some((path) => path.startsWith('-') || isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.'))) {
      throw new Error('files requires nonempty relative paths inside the worktree');
    }
    return { kind: 'files', paths };
  }
  throw new Error(`unknown source kind '${kind}' — expected commit | pr | worktree | files`);
}

function gitRoot(start: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: start, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const e = error as Error & { stderr?: Buffer | string };
    throw new Error(`git rev-parse failed: ${String(e.stderr ?? e.message).trim()}`);
  }
}

/** commit·pr 는 그대로. worktree·files 는 `packSourceBundle` 로 `{ kind: 'bundle' }`. */
export function resolvePodSource(parsed: ParsedPodSource, opts: { base: string; outDir: string }): PodSource {
  if (parsed.kind === 'commit') return { kind: 'commit', sha: parsed.sha };
  if (parsed.kind === 'pr') return { kind: 'pr', number: parsed.number };
  if (parsed.kind === 'worktree') {
    const packed = packSourceBundle({ repoDir: resolve(parsed.path), kind: 'worktree', base: opts.base, outDir: opts.outDir });
    return { kind: 'bundle', bundlePath: packed.bundlePath, sha256: packed.sha256, sizeBytes: packed.sizeBytes, headCommit: packed.headCommit };
  }
  const first = resolve(parsed.paths[0]!);
  const root = gitRoot(first);
  const paths = parsed.paths.map((path) => {
    const abs = resolve(path);
    const rel = relative(root, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`files path '${path}' is outside git root ${root}`);
    return rel.split('\\').join('/');
  });
  const packed = packSourceBundle({ repoDir: root, kind: 'files', base: opts.base, paths, outDir: opts.outDir });
  return { kind: 'bundle', bundlePath: packed.bundlePath, sha256: packed.sha256, sizeBytes: packed.sizeBytes, headCommit: packed.headCommit };
}
