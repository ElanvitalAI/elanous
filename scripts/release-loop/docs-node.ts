#!/usr/bin/env bun
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import type { ReleaseManifest } from '../../src/release-loop/manifest.js';
import { flipNextReleaseMarkers, foldPreLandedNotes, renderReleaseNotes } from './release-docs.js';
import { emitNodeResult, readGraphContext } from './node-verdict.js';

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

if (import.meta.main) {
  let result: DocsResult | undefined;
  const graphContext = process.env.ELANOUS_GRAPH_CONTEXT;
  let isReleaseGraph = false;
  try {
    if (graphContext) {
      const value = JSON.parse(graphContext.trimStart().startsWith('{') ? graphContext : readFileSync(graphContext, 'utf8')) as { input?: { previousVersion?: unknown }; outputs?: unknown };
      isReleaseGraph = value?.input?.previousVersion !== undefined || value?.outputs !== undefined;
    }
  } catch (error) {
    result = { outcome: 'error', version: null, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result && isReleaseGraph) {
    let version: string | null = null;
    let tree: string | undefined;
    try {
      const context = readGraphContext();
      version = context.input.version;
      for (const node of ['upgrade', 'tui', 'prepare', 'gate']) if (context.outputs[node]?.outcome !== 'ok') throw new Error(`${node} did not pass`);
      const branch = `release-docs/${version}`;
      const run = (command: string, args: string[], cwd = process.cwd()) => {
        const output = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        if (output.status !== 0) throw new Error(`${command} ${args[0]} failed: ${output.stderr || output.stdout}`);
        return output.stdout.trim();
      };
      run('git', ['fetch', 'origin', 'main']);
      tree = mkdtempSync(join(tmpdir(), 'release-docs-'));
      const worktree = join(tree, 'tree');
      run('git', ['worktree', 'add', '-b', branch, worktree, 'origin/main']);
      run('bun', ['install', '--frozen-lockfile'], worktree);
      result = runDocs(['--version', version, '--base', worktree, '--json']);
      if (result.outcome !== 'ok') throw new Error(result.error ?? 'docs generation failed');
      run('git', ['add', 'release/public/docs', 'website/pages.json'], worktree);
      run('git', ['commit', '-m', `docs: release ${version}`], worktree);
      run('git', ['push', '-u', 'origin', branch], worktree);
      result = { ...result, branch, worktree };
    } catch (error) {
      result = { outcome: 'error', version, error: error instanceof Error ? error.message : String(error), ...(tree ? { worktree: join(tree, 'tree') } : {}) };
    }
  } else if (!result) result = runDocs(process.argv.slice(2));
  debug.log('release-loop.docs', 'result', { version: result.version, outcome: result.outcome });
  emitNodeResult({ ...result, verdict: result.outcome === 'ok' ? 'pass' : 'fail', summary: result.outcome === 'ok' ? `docs v${result.version} · ${result.flipped?.length ?? 0} pages` : `docs: ${result.error ?? 'failed'}` });
  if (result.outcome === 'error') process.exitCode = 1;
}
