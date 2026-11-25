// RUNSHELL-SEARCH-PARITY — RunShell searches get the same roots, citations and miss signal as Grep/DocsSearch.
//
// Observation: a model that searched with `rg`/`git grep`/`ast-grep` through RunShell ran in the seat cwd only —
// a days-old worktree answered «not found» while the latest checkout had the doc (#40041 fixed this for Grep/Glob,
// #40044 added the single source resolver). This file reuses those helpers; it adds no path logic of its own:
//   roots     resolveSearchSources (knowledge.sources / ELANOUS_SOURCES) · staleCwdFor / staleCwdHint
//   citations citeSourcePath → repo:<id>/<rel> · ref:<id>/<rel>
//   miss      docs.search-miss {surface: 'runshell'} when a search returns no hits
// Judgment: roots are added only when the model gave no path and (the cwd is stale or the filter is markdown).
// Repair/handoff: the stale-cwd hint names the latest root, so a model that sees it can repeat with that path.

import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { citeSourcePath, resolveSearchSources, type ResolvedSearchSource } from '../../knowledge/search-roots.js';
import { staleCwdFor, staleCwdHint, type StaleCwd } from '../../knowledge/stale-cwd.js';
import { debug } from '../../debug/log.js';
import { parseRunShellSearch, type ParsedSearchArgv } from './run-shell-search-policy.js';

export { parseRunShellSearch, searchCommandPolicy } from './run-shell-search-policy.js';

export interface RunShellSearchDeps {
  staleCwd: (cwd: string) => StaleCwd | null;
  /** Configured sources for a scope; [] when none are configured. */
  sources: (scope: 'repo' | 'both') => ResolvedSearchSource[];
  exists: (path: string) => boolean;
  log: (category: string, event: string, data: Record<string, unknown>) => void;
}

const defaultDeps: RunShellSearchDeps = {
  staleCwd: staleCwdFor,
  // A throwing resolver propagates: planRunShellSearch then adds no roots (the search runs as the model wrote it).
  sources: (scope) => resolveSearchSources({ scope }),
  exists: existsSync,
  log: (category, event, data) => debug.log(category, event, data, { level: event === 'search-miss' ? 'warn' : 'info' }),
};

export interface RunShellSearchPlan {
  parsed: ParsedSearchArgv;
  /** argv to run (roots appended when parity applies). */
  argv: string[];
  /** Roots appended to the argv (absolute). */
  addedRoots: string[];
  /** Lines put ahead of the results (stale-cwd hint · also searched). */
  hints: string[];
  /** Sources used to cite result paths. */
  citeSources: ResolvedSearchSource[];
}

function within(path: string, root: string): boolean {
  const p = resolve(path); const r = resolve(root);
  return p === r || p.startsWith(r + sep);
}

/** Plan a RunShell search: null when the argv is not an accepted search. */
export function planRunShellSearch(argv: readonly string[], cwd: string, deps: RunShellSearchDeps = defaultDeps): RunShellSearchPlan | null {
  const parsed = parseRunShellSearch(argv);
  if (!parsed || parsed.refused) return null;
  const plan: RunShellSearchPlan = { parsed, argv: [...argv], addedRoots: [], hints: [], citeSources: [] };
  // Resolver failure (bad config, unreadable file) → no roots, no hints, no citations: the argv runs unchanged.
  let citeSources: ResolvedSearchSource[];
  try { citeSources = deps.sources('both'); } catch { return plan; }
  plan.citeSources = citeSources;
  // `eln docs search` resolves its own roots (scope repo|ref|both|custom) and cites them itself.
  if (parsed.tool === 'docs' || parsed.explicitPaths) return plan;
  let stale: StaleCwd | null;
  try { stale = deps.staleCwd(cwd); } catch { return plan; }
  if (!stale && !parsed.docsIntent) return plan;
  if (parsed.tool === 'git-grep') {
    // git grep reads only the cwd repository — say where the latest tree is instead of guessing a path.
    if (stale) plan.hints.push(`${staleCwdHint(stale).replace('searched latest too', 'git grep saw only this tree')} — repeat with rg or eln docs search`);
    return plan;
  }
  const add: string[] = [];
  if (stale) add.push(stale.latestRoot);
  // Raw tools search repo sources only; ref sources join through `eln docs search --scope ref|both`.
  for (const s of citeSources) {
    if (s.type !== 'repo' || !deps.exists(s.path)) continue;
    if (within(cwd, s.path) || within(s.path, cwd)) continue;
    if (stale && (within(s.path, stale.cwdRoot) || within(stale.cwdRoot, s.path))) continue;
    if (add.some((a) => within(s.path, a) || within(a, s.path))) continue;
    add.push(s.path);
  }
  if (stale) plan.hints.push(staleCwdHint(stale));
  if (add.length === 0) return plan;
  plan.addedRoots = add;
  plan.argv = [...argv, '.', ...add];
  const named = add.map((root) => citeSourcePath(root, citeSources)).map((c) => (c.endsWith('/') ? c.slice(0, -1) : c));
  plan.hints.push(`also searched: ${named.join(', ')}`);
  return plan;
}

/** Rewrite only the fields that hold a file name into repo:<id>/<rel> · ref:<id>/<rel> citations:
 *  list → the whole line · match → the `path:` prefix · json → rg's `path.text` · none → nothing
 *  (match text such as «README.md» under --no-filename is never touched). */
export function citeSearchOutput(stdout: string, cwd: string, sources: readonly ResolvedSearchSource[],
  output: ParsedSearchArgv['output'], exists: (path: string) => boolean = existsSync, maxLines = 5000): string {
  if (!stdout || sources.length === 0 || output === 'none') return stdout;
  const seen = new Map<string, string | null>();
  const cite = (candidate: string): string | null => {
    if (!candidate || candidate.length > 1024 || /[\u0000-\u001f]/u.test(candidate) || /^(?:repo|ref|custom):/u.test(candidate)) return null;
    let cited = seen.get(candidate);
    if (cited === undefined) {
      const abs = resolve(cwd, candidate);
      const c = citeSourcePath(abs, sources);
      cited = c !== abs && exists(abs) ? c : null;
      seen.set(candidate, cited);
    }
    return cited;
  };
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i]!;
    if (!line) continue;
    if (output === 'json') {
      if (!line.includes('"path"')) continue;
      try {
        const event = JSON.parse(line) as { data?: { path?: { text?: unknown } } };
        const text = event.data?.path?.text;
        const cited = typeof text === 'string' ? cite(text) : null;
        if (cited) { event.data!.path!.text = cited; lines[i] = JSON.stringify(event); }
      } catch { /* not an rg event line */ }
      continue;
    }
    if (output === 'list') {
      const cited = cite(line);
      if (cited) lines[i] = cited;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue; // a match line always carries `path:`
    const cited = cite(line.slice(0, colon));
    if (cited) lines[i] = cited + line.slice(colon);
  }
  return lines.join('\n');
}

/** Hit count: non-empty result lines (rg --json: match events). */
export function countSearchHits(stdout: string, parsed: ParsedSearchArgv): number {
  const lines = stdout.split('\n').filter((l) => l.trim() && !l.startsWith('[search] '));
  if (parsed.json && parsed.tool === 'rg') return lines.filter((l) => l.includes('"type":"match"')).length;
  return lines.length;
}

export interface FinishedSearch {
  stdout: string;
  hits: number;
  rawBytes: number;
  returnedBytes: number;
}

/** After the run: hints ahead · citations · miss log · byte summary. Exit 1 with no output is a miss, not an error. */
export function finishRunShellSearch(plan: RunShellSearchPlan, result: { stdout: string; exitCode: number | null; outcome: string },
  cwd: string, deps: RunShellSearchDeps = defaultDeps): FinishedSearch {
  const rawBytes = Buffer.byteLength(result.stdout);
  let stdout = result.stdout;
  if (plan.parsed.tool !== 'docs') stdout = citeSearchOutput(stdout, cwd, plan.citeSources, plan.parsed.output, deps.exists);
  const hits = result.outcome === 'exit' && (result.exitCode === 0 || result.exitCode === 1) ? countSearchHits(stdout, plan.parsed) : -1;
  if (!plan.parsed.json && plan.hints.length) stdout = `${plan.hints.map((h) => `[search] ${h}`).join('\n')}\n${stdout}`;
  const returnedBytes = Buffer.byteLength(stdout);
  // `eln docs search` logs its own miss in the child (docs-cli) — do not count it twice.
  if (hits === 0 && plan.parsed.tool !== 'docs') {
    deps.log('docs', 'search-miss', { query: plan.parsed.query ?? null, roots: [cwd, ...plan.addedRoots], hits: 0,
      surface: 'runshell', tool: plan.parsed.tool });
  }
  deps.log('shell.run', 'search.summary', { tool: plan.parsed.tool, hits, rawBytes, returnedBytes,
    addedRoots: plan.addedRoots.length, hinted: plan.hints.length > 0 });
  return { stdout, hits, rawBytes, returnedBytes };
}

export interface RunShellSearchStrategyOpts {
  cwd: string;
  /** Engine argv family. Default rg. */
  engine?: 'rg' | 'git-grep' | 'ast-grep' | 'docs';
  /** Extra flags placed before the query (e.g. ['-l'], ['-t', 'md']). */
  flags?: readonly string[];
  deps?: RunShellSearchDeps;
  /** The device's runner (its RunShell kit) — this module never spawns (single process gateway). */
  exec: (argv: readonly string[], cwd: string) => { stdout: string; exitCode: number | null };
}

export interface RunShellSearchStrategyResult extends FinishedSearch {
  argv: string[];
  addedRoots: string[];
  hints: string[];
}

/** Sim-device adapter (search-bench): the RunShell search path as one call — plan, run, cite, count. */
export function runShellSearchStrategy(query: string, opts: RunShellSearchStrategyOpts): RunShellSearchStrategyResult {
  const engine = opts.engine ?? 'rg';
  const flags = [...(opts.flags ?? [])];
  const base = engine === 'rg' ? ['rg', ...flags, query]
    : engine === 'git-grep' ? ['git', 'grep', ...flags, query]
      : engine === 'ast-grep' ? ['ast-grep', 'run', ...flags, '-p', query]
        : ['eln', 'docs', 'search', ...flags, query];
  const deps = opts.deps ?? defaultDeps;
  const plan = planRunShellSearch(base, opts.cwd, deps);
  if (!plan) throw new Error(`runShellSearchStrategy: refused argv ${base.join(' ')}`);
  const ran = opts.exec(plan.argv, opts.cwd);
  const finished = finishRunShellSearch(plan, { ...ran, outcome: 'exit' }, opts.cwd, deps);
  return { ...finished, argv: plan.argv, addedRoots: plan.addedRoots, hints: plan.hints };
}
