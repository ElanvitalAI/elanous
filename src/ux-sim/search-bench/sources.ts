// SEARCH-BENCH corpus sources — where the corpora come FROM is decided only by the product's single source resolver
// (src/knowledge/search-roots.ts · #40044): config `knowledge.sources` / env `ELANOUS_SOURCES` by id, or explicit
// paths as scope `custom`. The device keeps no path logic of its own; with nothing configured it passes this tree /
// ~/source/ref as custom paths through the same resolver.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { resolveSearchSources, type ResolvedSearchSource, type SearchSourcesOpts } from '../../knowledge/search-roots.js';

export const BENCH_REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

export interface BenchSourceChoice { readonly repo?: string; readonly repoSource?: string; readonly refRoot?: string; readonly refSources?: string }

/** The elanous repo checkout to archive from. */
export function resolveRepoSource(o: BenchSourceChoice, opts: SearchSourcesOpts = {}): ResolvedSearchSource {
  if (o.repo) return resolveSearchSources({ ...opts, scope: 'custom', paths: [o.repo] })[0]!;
  if (o.repoSource) return resolveSearchSources({ ...opts, scope: 'custom', sourceIds: [o.repoSource] })[0]!;
  const configured = resolveSearchSources({ ...opts, scope: 'repo' }).find((s) => existsSync(join(s.path, '.git')));
  return configured ?? resolveSearchSources({ ...opts, scope: 'custom', paths: [BENCH_REPO_ROOT] })[0]!;
}

/** Each sampled reference repo → its directory, found among the resolved ref sources (a source IS the repo, or holds it). */
export function resolveRefRepos(repos: readonly string[], o: BenchSourceChoice, opts: SearchSourcesOpts = {}): { sources: ResolvedSearchSource[]; repos: Array<{ repo: string; path: string; sourceId: string }> } {
  const sources = o.refRoot ? resolveSearchSources({ ...opts, scope: 'custom', paths: [o.refRoot] })
    : o.refSources ? resolveSearchSources({ ...opts, scope: 'custom', sourceIds: o.refSources.split(',').map((s) => s.trim()).filter(Boolean) })
    : (() => { const ref = resolveSearchSources({ ...opts, scope: 'ref' }); return ref.length ? ref : resolveSearchSources({ ...opts, scope: 'custom', paths: [join(homedir(), 'source', 'ref')] }); })();
  const out: Array<{ repo: string; path: string; sourceId: string }> = [];
  const missing: string[] = [];
  for (const repo of repos) {
    const hit = sources.find((s) => basename(s.path) === repo) ?? sources.find((s) => existsSync(join(s.path, repo)));
    if (!hit) { missing.push(repo); continue; }
    out.push({ repo, path: basename(hit.path) === repo ? hit.path : join(hit.path, repo), sourceId: hit.id });
  }
  if (missing.length) throw new Error(`ref repos not found in sources ${sources.map((s) => `${s.id}=${s.path}`).join(', ')}: ${missing.join(', ')}`);
  return { sources, repos: out };
}
