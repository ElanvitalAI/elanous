#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute, basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import type { ReleaseManifest } from '../../src/release-loop/manifest.js';
import { flipNextReleaseMarkers, foldPreLandedNotes, renderReleaseNotes } from './release-docs.js';
import { emitNodeResult, lastResult, nodeOutput, readGraphContext, type GraphContext } from './node-verdict.js';
import { reusableTui, withTuiOutcome } from './tui-node-checks.js';

interface DocsResult {
  outcome: 'ok' | 'error';
  version: string | null;
  notes?: string;
  flipped?: string[];
  pages?: string;
  error?: string;
  branch?: string;
  worktree?: string;
}

function* markdownFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* markdownFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield path;
  }
}

function atomicWrite(path: string, text: string, writeTemp: (path: string, text: string) => void): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeTemp(temp, text);
    if (existsSync(path)) chmodSync(temp, statSync(path).mode);
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function graphInput(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const value = env.ELANOUS_GRAPH_CONTEXT;
  if (!value) return {};
  const context: unknown = JSON.parse(value.trimStart().startsWith('{') ? value : readFileSync(value, 'utf8'));
  if (!context || typeof context !== 'object' || !('input' in context)) return {};
  const input = context.input;
  return input && typeof input === 'object' ? input as Record<string, unknown> : {};
}

/** Apply the cutoff manifest to the public documentation checkout. */
export function runDocs(
  args: string[], base = process.cwd(), env: NodeJS.ProcessEnv = process.env,
  deps: { stateRoot?: string; writeTemp?: (path: string, text: string) => void } = {},
): DocsResult {
  let version: string | null = null;
  try {
    const input = graphInput(env);
    version = typeof input.version === 'string' ? input.version : null;
    let root = typeof input.base === 'string' ? input.base : base;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--json') continue;
      if (arg === '--version' || arg === '--base') {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error(`value required for ${arg}`);
        if (arg === '--version') version = value;
        else root = value;
        continue;
      }
      throw new Error(`unknown argument: ${arg}`);
    }
    if (!version || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:rc|alpha|beta)\.(?:0|[1-9]\d*))?$/.test(version)) {
      throw new Error('version required (--version or ELANOUS_GRAPH_CONTEXT.input.version): x.y.z');
    }
    root = resolve(root);
    const manifestPath = join(deps.stateRoot ?? effectiveInstanceRoot(), 'release', version, 'manifest.json');
    const manifest: ReleaseManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== version || !Array.isArray(manifest.in)) throw new Error(`invalid release manifest: ${manifestPath}`);
    const notes = join(root, 'release/public/docs/releases', `${version}.md`);
    const pages = join(root, 'website/pages.json');
    const docRoot = join(root, 'release/public/docs');
    const id = `releases/${version}`;
    const registry: { pages?: Array<{ id: string; [key: string]: unknown }> } = JSON.parse(readFileSync(pages, 'utf8'));
    if (!Array.isArray(registry.pages)) throw new Error(`invalid pages registry: ${pages}`);
    const count = registry.pages.filter((page) => page.id === id).length;
    if (count > 1) throw new Error(`duplicate pages entry: ${id}`);
    const renderedNotes = renderReleaseNotes(manifest, version);
    // A PR may land its own line (or the headline) in this version's notes before the loop runs.
    // Fold it in rather than refusing (which stalled the release) or overwriting (which lost it).
    let notesText: string | null = null;
    if (count === 0 && existsSync(notes)) {
      const existing = readFileSync(notes, 'utf8');
      if (existing !== renderedNotes) {
        const fold = foldPreLandedNotes(existing, renderedNotes);
        notesText = fold.text;
        debug.log('release-loop.docs', 'pre-landed-lines-folded', { version, count: fold.folded });
      }
    }
    if (count === 0) {
      const first = registry.pages.findIndex((page) => page.id.startsWith('releases/'));
      registry.pages.splice(first < 0 ? registry.pages.length : first, 0, {
        id, slug: `/releases/${version.replaceAll('.', '-')}`,
        source: `release/public/docs/releases/${version}.md`, title: version,
        summary: `Changes in ${version}.`, read_when: [`You want to know what changed in ${version}`],
        position: 0, since: version,
      });
    }
    const changed: Array<[string, string]> = [];
    for (const path of markdownFiles(docRoot)) {
      if (path === notes) continue;
      const before = readFileSync(path, 'utf8');
      const after = flipNextReleaseMarkers(before, version);
      if (after !== before) changed.push([path, after]);
    }
    const writeTemp = deps.writeTemp ?? writeFileSync;
    if (notesText !== null) atomicWrite(notes, notesText, writeTemp);
    else if (!existsSync(notes)) atomicWrite(notes, renderedNotes, writeTemp);
    for (const [path, text] of changed) atomicWrite(path, text, writeTemp);
    if (count === 0) atomicWrite(pages, JSON.stringify(registry, null, 2) + '\n', writeTemp);
    return { outcome: 'ok', version, notes, flipped: changed.map(([path]) => path), pages };
  } catch (error) {
    return { outcome: 'error', version, error: error instanceof Error ? error.message : String(error) };
  }
}

// Prefetch artifacts live alongside THIS graph run's numbered context files, never in a global version cache.
const SHA = /^[0-9a-f]{40}$/i;
const PREFETCH_DEADLINE_MS = 15 * 60_000;
type Cut = { version: string; commit: string; manifestHash: string };
type PrefetchCache = Cut & { main: string; tree: string; docs: DocsResult; tui: Record<string, unknown> | null };
type Runner = (command: string, args: string[], cwd?: string, timeout?: number, env?: NodeJS.ProcessEnv) => string;
export const commandRunner: Runner = (command, args, cwd, timeout, env) => {
  const output = spawnSync(command, args, { cwd, env: env ?? process.env, timeout: timeout ?? 15 * 60_000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (output.status !== 0 || output.error) throw new Error(`${command} ${args[0]} failed: ${output.error ?? output.stderr ?? output.stdout}`);
  return output.stdout.trim();
};

function runCacheDir(env: NodeJS.ProcessEnv): string {
  const path = env.ELANOUS_GRAPH_CONTEXT;
  if (!path || !isAbsolute(path) || !/^\d+\.json$/.test(basename(path)) || !dirname(path).endsWith('.json.contexts')) {
    throw new Error('prefetch requires an absolute graph run context file');
  }
  return join(dirname(path), 'docs-prefetch');
}
function cutFor(context: GraphContext, stateRoot: string): Cut {
  const version = context.input.version;
  const commit = nodeOutput(context, 'version-release', 'commit');
  if (context.outputs['version-release']?.outcome !== 'ok' || !SHA.test(commit)) throw new Error('invalid release commit');
  const raw = readFileSync(join(stateRoot, 'release', version, 'manifest.json'));
  const manifest = JSON.parse(raw.toString()) as ReleaseManifest;
  if (manifest.version !== version || manifest.cutoff?.sha !== commit || !Array.isArray(manifest.in)) throw new Error('manifest cutoff differs from release commit');
  return { version, commit, manifestHash: createHash('sha256').update(raw).digest('hex') };
}
/** Exclusive create — true iff this caller is the first to claim the run's prefetch slot. */
function claimPrefetch(dir: string, owner: 'worker' | 'docs'): boolean {
  try { writeFileSync(join(dir, 'claim'), owner, { flag: 'wx' }); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
}
function cacheFile(dir: string, cut: Cut): string {
  return join(dir, `${cut.commit}-${cut.manifestHash}.json`);
}
function loadCache(dir: string, cut: Cut): PrefetchCache | null {
  try {
    const value = JSON.parse(readFileSync(cacheFile(dir, cut), 'utf8')) as PrefetchCache;
    if (value.version !== cut.version || value.commit !== cut.commit || value.manifestHash !== cut.manifestHash
      || !SHA.test(value.main) || value.tree !== join(dir, 'tree') || !existsSync(value.tree)
      || value.docs?.outcome !== 'ok' || value.docs.version !== cut.version
      || value.docs.notes !== join(value.tree, 'release/public/docs/releases', `${cut.version}.md`)
      || value.docs.pages !== join(value.tree, 'website/pages.json')
      || !existsSync(value.docs.notes) || !existsSync(value.docs.pages)) return null;
    return value;
  } catch { return null; }
}

/** Worker performs ONLY local reads and temporary worktree writes; failure is a cache miss, not a gate failure. */
export function stagePrefetch(context: GraphContext, env: NodeJS.ProcessEnv = process.env, repo = process.cwd(),
  runner: Runner = commandRunner, deps: { stateRoot?: string; tui?: (commit: string) => Record<string, unknown> | null; deadline?: number } = {}): PrefetchCache {
  // One whole-worker deadline: every step gets at most the time left, and no step starts after it.
  const deadline = deps.deadline ?? Date.now() + PREFETCH_DEADLINE_MS;
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('prefetch worker deadline exceeded');
    return ms;
  };
  const run: Runner = (command, args, cwd, timeout, childEnv) => runner(command, args, cwd, Math.min(timeout ?? 15 * 60_000, left()), childEnv);
  const dir = runCacheDir(env);
  const stateRoot = deps.stateRoot ?? effectiveInstanceRoot();
  const cut = cutFor(context, stateRoot);
  mkdirSync(dir, { recursive: true });
  const already = loadCache(dir, cut);
  if (already) return already;
  const tree = join(dir, 'tree');
  let added = false;
  try {
    const main = run('git', ['rev-parse', '--verify', 'origin/main^{commit}'], repo);
    if (!SHA.test(main)) throw new Error('invalid origin/main commit');
    // TUI runs against the cut, on its own isolated worktree, before touching the docs checkout.
    // tui-sim-node.ts prints the RAW result (no `outcome`); judge it the way node-verdict.ts tui would before reuse.
    const tuiData = deps.tui ? deps.tui(cut.commit) : (() => {
      const tuiRun = spawnSync('bun', ['scripts/release-loop/tui-sim-node.ts', '--commit', cut.commit, '--json'], {
        cwd: repo, timeout: Math.min(6 * 60_000, left()), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      });
      return tuiRun.status === 0 ? lastResult({ status: tuiRun.status, stdout: tuiRun.stdout ?? '', stderr: tuiRun.stderr ?? '' }) ?? null : null;
    })();
    const tui = reusableTui(withTuiOutcome(0, tuiData), cut.commit);
    run('git', ['worktree', 'add', '--detach', tree, main], repo);
    added = true;
    run('bun', ['install', '--frozen-lockfile'], tree);
    // Docs staging runs as its own process so the whole-worker deadline can stop it (an in-process call could not be).
    const docsOut = run(process.execPath, [resolve(import.meta.filename), '--version', cut.version, '--base', tree, '--json'], repo, undefined,
      { ...process.env, ELANOUS_GRAPH_CONTEXT: '', ELANOUS_STATE_DIR: stateRoot });
    const docs = JSON.parse(docsOut.trim().split('\n').at(-1) ?? 'null') as DocsResult;
    if (!docs || typeof docs !== 'object') throw new Error('docs staging returned no result');
    if (docs.outcome !== 'ok') throw new Error(docs.error ?? 'docs staging failed');
    // Recheck the cut before publishing an atomic result; stale results are never reused.
    left();
    const finalCut = cutFor(context, stateRoot);
    if (finalCut.manifestHash !== cut.manifestHash) throw new Error('manifest changed during prefetch');
    const result: PrefetchCache = { ...cut, main, tree, docs, tui };
    const final = cacheFile(dir, cut);
    const staged = `${final}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(staged, JSON.stringify(result) + '\n');
    // Publication handshake: whoever creates `claim` first (O_EXCL) wins. The docs node claims before it reads,
    // so a worker that loses can never publish a cache that a docs attempt would consume.
    if (!claimPrefetch(dir, 'worker')) {
      rmSync(staged, { force: true });
      throw new Error('docs node already ran; late prefetch is discarded');
    }
    renameSync(staged, final);
    return result;
  } catch (error) {
    if (added) { try { runner('git', ['worktree', 'remove', '--force', tree], repo, 60_000); } catch { /* preserve original failure */ } }
    throw error;
  }
}

/** TUI is measured against the cut commit, so reuse keys on commit ⊕ manifest hash only — origin/main is a docs-tree input, not a TUI input. */
export function joinTui(context: GraphContext, env: NodeJS.ProcessEnv, repo: string,
  fallback: (commit: string) => { status: number | null; stdout: string; stderr: string } = (commit) => {
    const output = spawnSync('bun', ['scripts/release-loop/node-verdict.ts', 'tui'], {
      cwd: repo, env, encoding: 'utf8', timeout: 7 * 60_000, maxBuffer: 16 * 1024 * 1024,
    });
    return { status: output.status, stdout: output.stdout ?? '', stderr: output.stderr ?? '' };
  }, stateRoot = effectiveInstanceRoot()): Record<string, unknown> {
  if (context.outputs.upgrade?.outcome !== 'ok') throw new Error('upgrade did not pass');
  // Any failure to key the cache (no manifest, cutoff mismatch, no run dir) is a cache miss → original TUI path.
  let cut: Cut | null = null;
  let cached: PrefetchCache | null = null;
  try { cut = cutFor(context, stateRoot); cached = loadCache(runCacheDir(env), cut); } catch { /* cache miss */ }
  const reused = cut && cached?.tui && reusableTui(cached.tui, cut.commit);
  if (reused) return { ...reused, outcome: 'ok', summary: `tui ${reused.verdict}` };
  // Preserve node-verdict.ts's exit convention and last-JSON output on a cache miss.
  const output = fallback(cut?.commit ?? String(context.outputs['version-release']?.commit ?? ''));
  const data = lastResult(output);
  if (!data) throw new Error(`tui fallback returned no verdict: ${output.stderr}`);
  // A timed-out or crashed fallback never passes on an earlier success line: exit status, outcome and verdict must agree.
  // node-verdict.ts convention: ok ↔ exit 0 with pass|flaky · fail ↔ exit 1 with fail · error ↔ exit 2.
  const agrees = output.status === 0 ? data.outcome === 'ok' && (data.verdict === 'pass' || data.verdict === 'flaky')
    : output.status === 1 ? data.outcome === 'fail' && data.verdict === 'fail'
      : output.status === 2 ? data.outcome === 'error' && data.verdict === 'fail' : false;
  if (!agrees) {
    throw new Error(`tui fallback exited ${output.status} with outcome ${String(data.outcome)} / verdict ${String(data.verdict)}`);
  }
  return data;
}

export function graphDocs(context: GraphContext, env: NodeJS.ProcessEnv, repo: string, run: Runner = commandRunner,
  stateRoot = effectiveInstanceRoot()): DocsResult {
  const version = context.input.version;
  let tree: string | undefined;
  // Before ANY check (and so also on every failure path): only the first docs attempt may consume a staged cache,
  // and only when the worker won the claim; otherwise this attempt claims the slot so a late worker cannot publish.
  let mayConsume = false;
  let cacheDir: string | undefined;
  try {
    cacheDir = runCacheDir(env);
    mkdirSync(cacheDir, { recursive: true });
    const closed = join(cacheDir, 'docs-closed');
    const firstAttempt = !existsSync(closed);
    writeFileSync(closed, `${new Date().toISOString()}\n`);
    const docsWon = claimPrefetch(cacheDir, 'docs');
    mayConsume = firstAttempt && !docsWon && readFileSync(join(cacheDir, 'claim'), 'utf8') === 'worker';
  } catch { /* standalone/legacy graph — no prefetch */ }
  try {
    // No fetch (nor any write to remote) until every gate is verified.
    for (const node of ['gate', 'prepare', 'upgrade', 'tui']) if (context.outputs[node]?.outcome !== 'ok') throw new Error(`${node} did not pass`);
    let cached: PrefetchCache | null = null;
    // A cache key that cannot be computed is a miss — the original fresh-worktree path runs.
    if (mayConsume && cacheDir) { try { const cut = cutFor(context, stateRoot); cached = loadCache(cacheDir, cut); } catch { cached = null; } }
    const branch = `release-docs/${version}`;
    run('git', ['fetch', 'origin', 'main'], repo);
    const main = run('git', ['rev-parse', '--verify', 'origin/main^{commit}'], repo);
    if (cached && cached.main === main && SHA.test(main)) {
      tree = cached.tree;
      // Attach the staged detached checkout to the branch only at the late docs node.
      run('git', ['-C', tree, 'switch', '-c', branch], repo);
      // Consumed: a resumed run must not reuse a tree that is now on the branch (fresh path instead).
      rmSync(cacheFile(cacheDir!, cached), { force: true });
    } else {
      const root = mkdtempSync(join(tmpdir(), 'release-docs-'));
      tree = join(root, 'tree');
      run('git', ['worktree', 'add', '-b', branch, tree, 'origin/main'], repo);
      run('bun', ['install', '--frozen-lockfile'], tree);
    }
    const result = cached && cached.main === main ? cached.docs : runDocs(['--version', version, '--base', tree, '--json'], repo, env, { stateRoot });
    if (result.outcome !== 'ok') throw new Error(result.error ?? 'docs generation failed');
    run('git', ['add', 'release/public/docs', 'website/pages.json'], tree);
    run('git', ['commit', '-m', `docs: release ${version}`], tree);
    run('git', ['push', '-u', 'origin', branch], tree);
    return { ...result, branch, worktree: tree };
  } catch (error) {
    return { outcome: 'error', version, error: error instanceof Error ? error.message : String(error), ...(tree ? { worktree: tree } : {}) };
  }
}

/** Detached prefetch worker; an asynchronous spawn failure is logged as a cache miss and never escapes the node. */
export function startPrefetchWorker(version: string, commit: string,
  spawnWorker: () => ReturnType<typeof spawn> = () => spawn(process.execPath, [resolve(import.meta.filename), '--prefetch-worker'], {
    cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
  })): number {
  const child = spawnWorker();
  child.on('error', (error) => debug.log('release-loop.docs', 'prefetch-skipped', { version, commit, reason: `worker spawn error: ${error.message}` }));
  if (!child.pid) throw new Error('prefetch worker did not start');
  child.unref();
  return child.pid;
}

function graphNodeId(env: NodeJS.ProcessEnv): string | null {
  const location = env.ELANOUS_GRAPH_CONTEXT;
  if (!location) return null;
  const context = JSON.parse(location.trimStart().startsWith('{') ? location : readFileSync(location, 'utf8')) as { nodeId?: unknown; input?: { previousVersion?: unknown }; outputs?: unknown };
  return typeof context.nodeId === 'string' ? context.nodeId : context.input?.previousVersion !== undefined || context.outputs !== undefined ? 'docs' : null;
}

if (import.meta.main) {
  let result: DocsResult | (Record<string, unknown> & { outcome: 'ok' | 'error' | 'fail'; version?: string | null; error?: string });
  let node: string | null = null;
  try {
    node = graphNodeId(process.env);
    if (process.argv.includes('--prefetch-worker')) {
      if (node !== 'prefetch') throw new Error('prefetch worker requires prefetch node');
      const context = readGraphContext();
      stagePrefetch(context);
      // Worker stdout is not a graph verdict; the initiating node has already returned.
      process.exit(0);
    }
    if (node === 'prefetch') {
      let version: string | null = null;
      try {
        const context = readGraphContext();
        version = context.input.version;
        const cut = cutFor(context, effectiveInstanceRoot());
        const dir = runCacheDir(process.env);
        mkdirSync(dir, { recursive: true });
        if (!loadCache(dir, cut)) {
          const pid = startPrefetchWorker(cut.version, cut.commit);
          // This is not a gate: the late nodes validate the atomic artifact or run their original path.
          debug.log('release-loop.docs', 'prefetch-start', { version: cut.version, commit: cut.commit, pid });
        }
        result = { outcome: 'ok', version: cut.version, summary: `prefetch v${cut.version} started` };
      } catch (error) {
        // Any pre-worker failure is a cache miss — the gate and the late nodes' original paths still run.
        const reason = error instanceof Error ? error.message : String(error);
        debug.log('release-loop.docs', 'prefetch-skipped', { version, reason });
        result = { outcome: 'ok', version, summary: `prefetch skipped (cache miss): ${reason}` };
      }
    } else if (node === 'tui') {
      const context = readGraphContext();
      result = { ...joinTui(context, process.env, process.cwd()), version: context.input.version } as typeof result;
    } else if (node === 'docs') {
      result = graphDocs(readGraphContext(), process.env, process.cwd(), commandRunner);
    } else if (node === null) result = runDocs(process.argv.slice(2));
    else throw new Error(`unknown release docs node: ${node}`);
  } catch (error) {
    result = { outcome: 'error', version: null, error: error instanceof Error ? error.message : String(error) };
  }
  debug.log('release-loop.docs', 'result', { node, version: result.version, outcome: result.outcome });
  const details = result as Record<string, unknown>;
  const verdict = details.verdict;
  emitNodeResult({ ...details, outcome: result.outcome, verdict: verdict === 'pass' || verdict === 'flaky' || verdict === 'fail' ? verdict : result.outcome === 'ok' ? 'pass' : 'fail',
    summary: typeof details.summary === 'string' ? details.summary : result.outcome === 'ok'
      ? `docs v${result.version} · ${(details.flipped as string[] | undefined)?.length ?? 0} pages` : `docs: ${result.error ?? 'failed'}` });
  if (result.outcome !== 'ok') process.exitCode = result.outcome === 'fail' ? 1 : node === 'tui' ? 2 : 1;
}
