// SEARCH-BENCH corpus — a pinned snapshot (git sha) of docs/ + src/ (+ root .gitignore) materialized into a temp dir by
// `git archive`, turned into a one-commit git repo (seats search inside worktrees, so rg's .gitignore rules and
// `git grep` see the same thing a seat sees), plus an IGNORED decoy directory (node_modules/@decoy) holding copies of
// files so ignore-rule behaviour is measurable (decoy hits in the top 5 = noise). Files are made read-only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DECOY_DIR = 'node_modules/@decoy/pkg';

export interface Corpus {
  readonly root: string;
  readonly sha: string;
  readonly files: number;
}

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

/** Resolve a ref to a full sha in `repoDir`. */
export function resolveSha(repoDir: string, ref: string): string {
  return git(repoDir, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
}

function walkFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, rel)).sort()) {
    if (rel === '' && name === '.git') continue;
    const p = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(root, p));
    if (st.isSymbolicLink()) continue; // dangling or out-of-tree links are not corpus files
    if (st.isDirectory()) out.push(...walkFiles(root, p));
    else out.push(p);
  }
  return out;
}

/** Fixed timestamp for every file → mtime-sorted tools (Glob, grok-cli, hermes) tie-break deterministically. */
const FIXED_MTIME = new Date('2026-01-01T00:00:00Z');

/** Make a corpus dir into a one-commit repo with a fixed identity/date (deterministic, no network). */
export function commitCorpus(root: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'search-bench', GIT_AUTHOR_EMAIL: 'bench@invalid', GIT_COMMITTER_NAME: 'search-bench',
    GIT_COMMITTER_EMAIL: 'bench@invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  git(root, ['init', '-q'], env);
  git(root, ['config', 'gc.auto', '0'], env); // no background repack inside a throwaway corpus
  git(root, ['add', '-A'], env);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'corpus'], env);
}

/** Plant ignored copies of `decoyOf` paths under node_modules/@decoy (root .gitignore must ignore node_modules). */
export function plantDecoys(root: string, decoyOf: readonly string[]): number {
  let planted = 0;
  for (const rel of decoyOf) {
    const src = join(root, rel);
    if (!existsSync(src)) continue;
    const dst = join(root, DECOY_DIR, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
    planted += 1;
  }
  return planted;
}

function freeze(root: string, files: readonly string[]): void {
  for (const rel of files) {
    const p = join(root, rel);
    utimesSync(p, FIXED_MTIME, FIXED_MTIME);
    chmodSync(p, 0o444);
  }
}

/**
 * Materialize `sha` (docs/ src/ .gitignore) from `repoDir` into `outDir` (must not exist or be empty).
 * `decoyOf` = paths copied into the ignored decoy dir (normally the gold targets).
 */
export function materializeCorpus(options: { repoDir: string; sha: string; outDir: string; paths?: readonly string[]; decoyOf?: readonly string[] }): Corpus {
  const sha = resolveSha(options.repoDir, options.sha);
  mkdirSync(options.outDir, { recursive: true });
  if (readdirSync(options.outDir).length > 0) throw new Error(`corpus dir is not empty: ${options.outDir}`);
  const paths = options.paths ?? ['docs', 'src', '.gitignore'];
  const archive = spawnSync('git', ['archive', '--format=tar', sha, ...paths], { cwd: options.repoDir, maxBuffer: 1024 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr.toString().trim()}`);
  const tar = spawnSync('tar', ['-x', '-f', '-', '-C', options.outDir], { input: archive.stdout, maxBuffer: 64 * 1024 * 1024 });
  if (tar.status !== 0) throw new Error(`tar -x failed: ${tar.stderr.toString().trim()}`);
  if (!existsSync(join(options.outDir, '.gitignore'))) writeFileSync(join(options.outDir, '.gitignore'), 'node_modules/\n');
  commitCorpus(options.outDir);
  plantDecoys(options.outDir, options.decoyOf ?? []);
  const files = walkFiles(options.outDir);
  freeze(options.outDir, files);
  return { root: options.outDir, sha, files: files.filter((f) => !f.startsWith('node_modules/')).length };
}

/** Build a corpus from literal files (tests · DR scenario). Same repo/decoy/freeze treatment as the real one. */
export function fixtureCorpus(outDir: string, files: Readonly<Record<string, string>>, decoyOf: readonly string[] = []): Corpus {
  mkdirSync(outDir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(outDir, rel)), { recursive: true });
    writeFileSync(join(outDir, rel), text);
  }
  if (!existsSync(join(outDir, '.gitignore'))) writeFileSync(join(outDir, '.gitignore'), 'node_modules/\n');
  commitCorpus(outDir);
  plantDecoys(outDir, decoyOf);
  const all = walkFiles(outDir);
  freeze(outDir, all);
  return { root: outDir, sha: git(outDir, ['rev-parse', 'HEAD']).trim(), files: all.filter((f) => !f.startsWith('node_modules/')).length };
}

/** Make a frozen corpus removable again (rmSync needs write permission on files under macOS for some dirs). */
export function thawCorpus(root: string): void {
  for (const rel of walkFiles(root)) { try { chmodSync(join(root, rel), 0o644); } catch { /* best effort */ } }
}

export interface RefRepoPin { readonly repo: string; readonly git: string | null; readonly files: number; readonly bytes: number; readonly contentHash: string }

/** Reference corpus (owner «source/ref 아래 참조 소스»): sampled repos copied read-only from their resolved sources (never written),
 *  vendored/build dirs left out (.git node_modules target .build). Pin = per-repo git HEAD when it is a git checkout,
 *  else a content hash over (path, size) — corpusSha = sha256 over the pins. */
export function materializeRefCorpus(options: { repos: ReadonlyArray<{ repo: string; path: string }>; outDir: string; decoyOf?: readonly string[] }): Corpus & { pins: RefRepoPin[] } {
  mkdirSync(options.outDir, { recursive: true });
  if (readdirSync(options.outDir).length > 0) throw new Error(`corpus dir is not empty: ${options.outDir}`);
  const pins: RefRepoPin[] = [];
  for (const { repo, path: src } of options.repos) {
    if (!existsSync(src)) throw new Error(`ref repo missing: ${src}`);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf8' });
    const r = spawnSync('rsync', ['-a', '--exclude=.git', '--exclude=node_modules', '--exclude=target', '--exclude=.build', `${src}/`, join(options.outDir, repo)], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`rsync ${repo} failed: ${r.stderr.trim()}`);
    const files = walkFiles(join(options.outDir, repo));
    const hash = createHash('sha256');
    let bytes = 0;
    for (const f of files) { const size = statSync(join(options.outDir, repo, f)).size; bytes += size; hash.update(`${f}\t${size}\n`); }
    pins.push({ repo, git: head.status === 0 ? head.stdout.trim() : null, files: files.length, bytes, contentHash: hash.digest('hex') });
  }
  writeFileSync(join(options.outDir, '.gitignore'), 'node_modules/\n');
  commitCorpus(options.outDir);
  plantDecoys(options.outDir, options.decoyOf ?? []);
  const all = walkFiles(options.outDir);
  freeze(options.outDir, all);
  const sha = createHash('sha256').update(JSON.stringify(pins)).digest('hex');
  return { root: options.outDir, sha, files: all.filter((f) => !f.startsWith('node_modules/')).length, pins };
}
