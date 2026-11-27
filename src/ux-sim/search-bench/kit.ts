// SEARCH-BENCH kit — the tools a strategy may call, each recorded as a trace row with the bytes the MODEL gets back:
//   · product tools: the seat's real Glob / Grep / Read dispatchers (src/skills/tools/*) pointed at the corpus,
//   · docs search: the index stages (docs-index.ts) and the relation scorer (relation-graph.ts),
//   · exec: a command through a folding profile — `runshell` reproduces the seat RunShell contract
//     (argv, no shell, 30 s timeout, 200 000-byte head capture shared by stdout+stderr, the structured result the
//     model receives); other profiles reproduce external agents' documented caps.
// One kit per (strategy, query): the trace is per query. Indexes are shared per corpus (built once, cost reported).
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { spawnElanousSync } from '../../instance/spawn-elanous.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchGlob } from '../../skills/tools/glob.js';
import { dispatchGrep } from '../../skills/tools/grep.js';
import { dispatchRead } from '../../skills/tools/read.js';
import { resetSearchLoopGuardForTest } from '../../skills/tools/search-loop-guard.js';
import { DEFAULT_TIMEOUT_MS, SHELL_MAX_OUTPUT } from '../../shell-primitive/index.js';
import { dispatchDocsSearch } from '../../skills/tools/docs-search.js';
import { parseRunShellSearch, planRunShellSearch, finishRunShellSearch, type RunShellSearchDeps } from '../../skills/tools/run-shell-search.js';
import type { SearchSourceConfig } from '../../knowledge/search-roots.js';
import { buildCorpusIndex, buildStage0, buildStage1, type CorpusIndex, type DocsHit, type DocsIndex } from './docs-index.js';
import { buildRelationGraph, graphRelationScorer, type RelationGraph, type RelationScorer } from './relation-graph.js';
import type { TraceEntry } from './types.js';

export type Fold =
  | { readonly kind: 'runshell' }
  | { readonly kind: 'head'; readonly bytes: number }
  | { readonly kind: 'headtail'; readonly bytes: number }
  | { readonly kind: 'lines'; readonly lines: number; readonly lineChars?: number }
  | { readonly kind: 'none' };

export interface ExecResult { readonly visible: string; readonly exit: number | null; readonly rawBytes: number; readonly truncated: boolean }

/** Shared per-corpus state (indexes are lazy and built once). */
export class CorpusContext {
  readonly root: string;
  /** The corpus as search sources (repo / ref ids → paths inside the corpus) — fed to the product resolver. */
  readonly sources: readonly SearchSourceConfig[];
  private files: string[] | null = null;
  private stage0: Promise<DocsIndex> | null = null;
  private stage1: Promise<DocsIndex> | null = null;
  private codeIdx = new Map<string, Promise<CorpusIndex>>();
  private graph: RelationGraph | null = null;
  readonly buildNotes: Record<string, unknown> = {};
  private tmp: string | null = null;
  constructor(root: string, sources?: readonly SearchSourceConfig[]) {
    this.root = root;
    this.sources = sources ?? [{ id: 'corpus', type: 'repo', path: root }];
  }
  private dir(): string { return (this.tmp ??= mkdtempSync(join(tmpdir(), 'search-bench-idx-'))); }
  /** Remove the temp index databases (hundreds of MB on a full corpus). */
  dispose(): void { if (this.tmp) { rmSync(this.tmp, { recursive: true, force: true }); this.tmp = null; } }
  /** Tracked files (what a seat's git-aware tools see), sorted. */
  trackedFiles(): string[] {
    if (!this.files) {
      const r = spawnSync('git', ['ls-files', '-z'], { cwd: this.root, maxBuffer: 256 * 1024 * 1024 });
      this.files = r.status === 0 ? r.stdout.toString('utf8').split('\0').filter(Boolean).sort() : [];
    }
    return this.files;
  }
  docsIndex(stage: 0 | 1): Promise<DocsIndex> {
    if (stage === 0) return (this.stage0 ??= buildStage0(this.root, join(this.dir(), 'stage0.db')).then((ix) => { this.buildNotes.stage0 = { files: ix.files, chunks: ix.chunks, buildMs: Math.round(ix.buildMs) }; return ix; }));
    return (this.stage1 ??= buildStage1(this.root, join(this.dir(), 'stage1.db')).then((ix) => { this.buildNotes.stage1 = { files: ix.files, chunks: ix.chunks, buildMs: Math.round(ix.buildMs) }; return ix; }));
  }
  codeIndex(vectors: boolean): Promise<CorpusIndex> {
    const key = vectors ? 'vec' : 'bm25';
    let p = this.codeIdx.get(key);
    if (!p) {
      p = buildCorpusIndex(this.root, join(this.dir(), `code-${key}.db`), this.trackedFiles(), { vectors }).then((ix) => {
        this.buildNotes[`code-${key}`] = { files: ix.files, bytes: ix.bytes, dbBytes: ix.dbBytes, buildMs: Math.round(ix.buildMs) };
        return ix;
      });
      this.codeIdx.set(key, p);
    }
    return p;
  }
  relationGraph(): RelationGraph {
    if (!this.graph) {
      this.graph = buildRelationGraph(this.root, this.trackedFiles());
      this.buildNotes.relation = { edges: this.graph.edges, buildMs: Math.round(this.graph.buildMs) };
    }
    return this.graph;
  }
}

const enc = (s: string) => Buffer.byteLength(s, 'utf8');

/** Apply a folding profile to raw stdout/stderr → (what the model sees, bytes it pays). */
export function foldOutput(fold: Fold, stdout: string, stderr: string, exit: number | null): { visible: string; bytes: number; truncated: boolean } {
  switch (fold.kind) {
    case 'none': return { visible: stdout, bytes: enc(stdout) + enc(stderr), truncated: false };
    case 'head': {
      const b = Buffer.from(stdout, 'utf8');
      const truncated = b.length > fold.bytes;
      const visible = truncated ? b.subarray(0, fold.bytes).toString('utf8') : stdout;
      return { visible, bytes: enc(visible), truncated };
    }
    case 'headtail': {
      const b = Buffer.from(stdout, 'utf8');
      if (b.length <= fold.bytes) return { visible: stdout, bytes: b.length, truncated: false };
      const half = Math.floor(fold.bytes / 2);
      const visible = `${b.subarray(0, half).toString('utf8')}\n…[truncated]…\n${b.subarray(b.length - half).toString('utf8')}`;
      return { visible, bytes: enc(visible), truncated: true };
    }
    case 'lines': {
      const all = stdout.split('\n').filter(Boolean);
      const kept = all.slice(0, fold.lines).map((l) => (fold.lineChars && l.length > fold.lineChars ? `${l.slice(0, fold.lineChars)}...` : l));
      const visible = kept.join('\n');
      return { visible, bytes: enc(visible), truncated: all.length > fold.lines };
    }
    case 'runshell': {
      // RunShell: one byte budget (SHELL_MAX_OUTPUT) shared by stdout then stderr, head kept, rest dropped
      // (src/shell-primitive/runtime.ts append()); the model receives the structured dispatch result.
      const out = Buffer.from(stdout, 'utf8');
      const keptOut = out.subarray(0, SHELL_MAX_OUTPUT);
      const left = SHELL_MAX_OUTPUT - keptOut.length;
      const err = Buffer.from(stderr, 'utf8').subarray(0, Math.max(0, left));
      const truncated = out.length > keptOut.length || enc(stderr) > err.length;
      const visible = keptOut.toString('utf8');
      const result = { output: `exit ${exit ?? 'null'}`, exitCode: exit, outcome: 'exit', elapsedMs: 0, stdout: visible, stderr: err.toString('utf8'), truncated };
      return { visible, bytes: enc(JSON.stringify(result)), truncated };
    }
  }
}

export class SearchKit {
  readonly ctx: CorpusContext;
  readonly trace: TraceEntry[] = [];
  constructor(ctx: CorpusContext) { this.ctx = ctx; resetSearchLoopGuardForTest(); }
  get root(): string { return this.ctx.root; }
  rel(p: string): string {
    const r = p.trim().replace(/^\.\//, '');
    return r.startsWith(`${this.root}/`) ? r.slice(this.root.length + 1) : r;
  }
  private record(entry: TraceEntry): void { this.trace.push(entry); }

  /** Product Glob (rg --files --glob, mtime-sorted, head_limit default 200). */
  async glob(pattern: string, opts: { head_limit?: number } = {}): Promise<string[]> {
    const t = performance.now();
    try {
      const r = await dispatchGlob({ pattern, path: this.root, ...(opts.head_limit ? { head_limit: opts.head_limit } : {}) });
      const paths = r.output.split('\n').filter((l) => l.startsWith(`${this.root}/`)).map((l) => this.rel(l));
      this.record({ tool: 'Glob', args: pattern, bytes: enc(r.output), ms: performance.now() - t, hits: paths.length });
      return paths;
    } catch (error) {
      this.record({ tool: 'Glob', args: pattern, bytes: 0, ms: performance.now() - t, hits: 0, error: String((error as Error).message ?? error) });
      return [];
    }
  }

  /** Product Grep, files_with_matches: the suggestion block first, then the list (what the model reads, in order). */
  async grep(pattern: string, opts: { i?: boolean; glob?: string; type?: string; head_limit?: number } = {}): Promise<string[]> {
    const t = performance.now();
    try {
      const r = await dispatchGrep({ pattern, path: this.root, ...(opts.i ? { '-i': true } : {}), ...(opts.glob ? { glob: opts.glob } : {}),
        ...(opts.type ? { type: opts.type } : {}), ...(opts.head_limit ? { head_limit: opts.head_limit } : {}) });
      const seen = new Set<string>();
      const paths: string[] = [];
      for (const line of r.output.split('\n')) {
        const raw = line.startsWith('- ') ? line.slice(2) : line;
        if (!raw.startsWith(`${this.root}/`)) continue;
        const p = this.rel(raw);
        if (!seen.has(p)) { seen.add(p); paths.push(p); }
      }
      this.record({ tool: 'Grep', args: `${pattern}${opts.i ? ' -i' : ''}`, bytes: enc(r.output), ms: performance.now() - t, hits: paths.length });
      return paths;
    } catch (error) {
      this.record({ tool: 'Grep', args: pattern, bytes: 0, ms: performance.now() - t, hits: 0, error: String((error as Error).message ?? error) });
      return [];
    }
  }

  /** Product Read (line-numbered window). */
  async read(path: string, limit = 400): Promise<string> {
    const t = performance.now();
    try {
      const r = await dispatchRead({ file_path: join(this.root, path), limit });
      this.record({ tool: 'Read', args: path, bytes: enc(r.output), ms: performance.now() - t, hits: 1 });
      return r.output;
    } catch (error) {
      this.record({ tool: 'Read', args: path, bytes: 0, ms: performance.now() - t, hits: 0, error: String((error as Error).message ?? error) });
      return '';
    }
  }

  /** Docs search at an index stage (0 = pre-#40031 · 1 = current). Output bytes ≈ the CLI's one line per hit. */
  async docs(stage: 0 | 1, query: string, k = 8): Promise<DocsHit[]> {
    const t = performance.now();
    const ix = await this.ctx.docsIndex(stage);
    const hits = await ix.query(query, k);
    this.record({ tool: `DocsSearch@${stage}`, args: query, bytes: hits.reduce((n, h) => n + 200 + h.path.length, 0), ms: performance.now() - t, hits: hits.length });
    return hits;
  }

  /** Stage 1b — the product DocsSearch tool (#40041 fallback ⊕ #40044 single source resolver) over the corpus sources:
   *  index first (the stage-1 index of this corpus), filename+content fallback over the same roots when the index is
   *  empty/semantic-only, scope repo|ref|both. Sources reach it only through `resolveSearchSources` (ELANOUS_SOURCES). */
  async docsTool(query: string, scope: 'repo' | 'ref' | 'both', k = 8): Promise<string[]> {
    const t = performance.now();
    const ix = await this.ctx.docsIndex(1);
    try {
      const r = await dispatchDocsSearch({ query, scope, limit: k }, {
        sourcesOpts: { env: { NODE_ENV: process.env.NODE_ENV, ELANOUS_SOURCES: JSON.stringify(this.ctx.sources) } },
        autoRepoRoots: () => [],
        indexSearch: ix.matches ? (q, n) => ix.matches!(q, n) : null,
      });
      const paths = [...new Set(r.hits.map((h) => this.rel(h.path)))];
      this.record({ tool: 'DocsSearch@1b', args: `${query} [${scope}]`, bytes: enc(r.output), ms: performance.now() - t, hits: paths.length });
      return paths;
    } catch (error) {
      this.record({ tool: 'DocsSearch@1b', args: query, bytes: 0, ms: performance.now() - t, hits: 0, error: String((error as Error).message ?? error) });
      return [];
    }
  }

  /** Code/source index (Track I over code · any corpus). */
  async codeIndex(query: string, k = 10, vectors = true): Promise<DocsHit[]> {
    const t = performance.now();
    const ix = await this.ctx.codeIndex(vectors);
    const hits = await ix.query(query, k);
    this.record({ tool: `CodeIndex${vectors ? '' : '-bm25'}`, args: query, bytes: hits.reduce((n, h) => n + 120 + h.path.length, 0), ms: performance.now() - t, hits: hits.length });
    return hits;
  }

  relation(weights?: Parameters<typeof graphRelationScorer>[1]): RelationScorer {
    return graphRelationScorer(this.ctx.relationGraph(), weights);
  }

  /** Run argv (no shell) in the corpus root and fold the output like `fold` says. */
  exec(tool: string, argv: readonly string[], fold: Fold, opts: { timeoutMs?: number; input?: string } = {}): ExecResult {
    const t = performance.now();
    const r = spawnSync(argv[0]!, argv.slice(1), { cwd: this.root, encoding: 'utf8', timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024,
      ...(opts.input !== undefined ? { input: opts.input } : {}) });
    const stdout = r.stdout ?? '';
    const stderr = r.stderr ?? '';
    const folded = foldOutput(fold, stdout, stderr, r.status);
    const error = r.error ? String(r.error.message) : undefined;
    this.record({ tool, args: argv.join(' '), bytes: folded.bytes, ms: performance.now() - t, hits: folded.visible ? folded.visible.split('\n').filter(Boolean).length : 0, ...(error ? { error } : {}) });
    return { visible: folded.visible, exit: r.status, rawBytes: enc(stdout), truncated: folded.truncated };
  }

  /** The seat's RunShell search path — the 'via RunShell' arm (RUNSHELL-SEARCH-PARITY): product plan
   *  (policy deny · roots · stale-cwd hints) → head-captured run (fold 'runshell') → parity finish
   *  (repo:/ref: citations · hit count). Refused argv never spawns — the model receives the same structured
   *  denied result the seat's dispatchRunShell returns; accepted searches get the `search=… hits=…` summary. */
  runshell(argv: readonly string[]): string {
    const t = performance.now();
    const deps: RunShellSearchDeps = {
      staleCwd: () => null, // a bench corpus root is created for the run — never stale
      sources: (scope) => this.ctx.sources.filter((s) => scope === 'both' || s.type === scope).map((s) => ({ id: s.id, type: s.type, path: s.path })),
      exists: existsSync,
      log: () => {}, // the sim scores what the model receives; debug-side miss/summary logs stay product-side
    };
    const parsed = parseRunShellSearch(argv);
    if (parsed?.refused) {
      const result = {
        output: `RunShell refused a search flag: ${parsed.refused}. Search argv is read-only (rg · git grep · ast-grep run|scan · eln docs search).`,
        exitCode: null, outcome: 'denied', elapsedMs: 0, stdout: '', stderr: parsed.refused, truncated: false, approvalKey: 'rejected:search-flag',
      };
      const visible = JSON.stringify(result);
      this.record({ tool: 'RunShell', args: argv.join(' '), bytes: enc(visible), ms: performance.now() - t, hits: 0 });
      return visible;
    }
    const plan = planRunShellSearch(argv, this.root, deps);
    const runArgv = plan ? plan.argv : argv;
    const opts = {
      cwd: this.root, encoding: 'utf8' as const, timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024,
      ...(plan?.parsed.tool === 'docs' ? { env: { ...process.env, ELANOUS_SOURCES: JSON.stringify(this.ctx.sources) } } : {}), // corpus-bound `eln docs search`
    };
    const r = plan?.parsed.tool === 'docs'
      ? spawnElanousSync(runArgv.slice(1), { ...opts, executable: runArgv[0] }) as SpawnSyncReturns<string>
      : spawnSync(runArgv[0]!, runArgv.slice(1), opts);
    const out = Buffer.from(r.stdout ?? '', 'utf8');
    const keptOut = out.subarray(0, SHELL_MAX_OUTPUT); // fold 'runshell': stdout then stderr share one byte budget
    const err = Buffer.from(r.stderr ?? '', 'utf8').subarray(0, Math.max(0, SHELL_MAX_OUTPUT - keptOut.length));
    const truncated = out.length > keptOut.length || enc(r.stderr ?? '') > err.length;
    let stdoutVisible = keptOut.toString('utf8');
    let hits = stdoutVisible ? stdoutVisible.split('\n').filter(Boolean).length : 0;
    let output = `exit ${r.status ?? 'null'}`;
    let extra: { searchRawBytes?: number; search?: { tool: string; hits: number; rawBytes: number; returnedBytes: number; addedRoots: number } } = {};
    if (plan) {
      const finished = finishRunShellSearch(plan, { stdout: stdoutVisible, exitCode: r.status, outcome: 'exit' }, this.root, deps);
      stdoutVisible = finished.stdout;
      hits = finished.hits;
      output = `${output} search=${plan.parsed.tool} hits=${finished.hits}${plan.addedRoots.length ? ` roots+${plan.addedRoots.length}` : ''}`;
      extra = { searchRawBytes: finished.rawBytes, search: { tool: plan.parsed.tool, hits: finished.hits, rawBytes: finished.rawBytes, returnedBytes: finished.returnedBytes, addedRoots: plan.addedRoots.length } };
    }
    const result = { output, exitCode: r.status, outcome: 'exit', elapsedMs: Math.round(performance.now() - t), stdout: stdoutVisible, stderr: err.toString('utf8'), truncated, ...extra };
    const visible = JSON.stringify(result);
    this.record({ tool: 'RunShell', args: argv.join(' '), bytes: enc(visible), ms: performance.now() - t, hits, ...(r.error ? { error: String(r.error.message) } : {}) });
    return visible;
  }

  /** Account for work done without a tool call (e.g. a pipe stage that costs no model bytes). */
  note(tool: string, args: string): void { this.record({ tool, args, bytes: 0, ms: 0, hits: 0 }); }
}
