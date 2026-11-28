import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCapabilityRegistryForGraph } from '../plugin-graph-providers.js';
import { runGraph } from '../runner.js';
import { createRichSourceBuildWithApprovalRegistry } from './app-build-rich-traversal.js';
import { createBookforgeAppDocsRegistry, runBoundedBookforgeProcess } from './bookforge-app-docs.js';

/** Same selector the provider uses: first Python 3.10+ on PATH, not the 3.9 `python3`. */
const BOOKFORGE_PYTHON = [
  'import getpass, os, shutil, subprocess, sys',
  'from pathlib import Path',
  'need = sys.argv[1:]',
  'cands = []',
  'homes = [Path(os.environ["HOME"])] if os.environ.get("HOME") else []',
  'account = Path("~" + getpass.getuser()).expanduser()',
  'homes += [account] if account not in homes else []',
  'names = ("python3.15", "python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "python3")',
  'fixed = [home / ".local/share/elanous/bin/python3" for home in homes]',
  'fixed += [Path(f"/opt/homebrew/bin/{name}") for name in names]',
  'fixed += [Path(f"/usr/local/bin/{name}") for name in names]',
  'for path in [shutil.which(name) for name in names] + [str(path) for path in fixed if path.is_file()]:',
  '    if path and path not in cands: cands.append(path)',
  'for path in cands:',
  '    probe = subprocess.run([path, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], capture_output=True)',
  '    if probe.returncode == 0: os.execv(path, [path, *need])',
  'raise SystemExit(1)',
].join('\n');

test('bundled Bookforge graph resolves one provider and refuses missing design paths', async () => {
  const graph = join(import.meta.dir, '../../../plugins/bookforge/graphs/app-docs-pdf.yaml');
  const registry = await defaultCapabilityRegistryForGraph(graph);
  const providers = registry.providers.filter(provider => provider.provides.includes('bookforge.app-docs-pdf@1'));
  expect(providers).toHaveLength(1);
  const result = await providers[0]!.invoke({ graphId: 'bookforge-app-docs-pdf', runId: 'test',
    nodeId: 'reflow', requires: 'bookforge.app-docs-pdf@1', input: {}, graphInput: {}, outputs: {} });
  expect(result).toMatchObject({ ok: false, outcome: 'failed' });
});

test('app-build file output supplies ARCHITECTURE.md without a direct design path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bookforge-app-build-'));
  try {
    const designPath = join(root, 'ARCHITECTURE.md');
    writeFileSync(designPath, '# 설계\n\n## 배경\n이 절의 본문은 스무 글자를 넘긴다.\n');
    const provider = createBookforgeAppDocsRegistry(root).providers[0]!;
    const result = await provider.invoke({ graphId: 'app-build', runId: 'files-then-pdf',
      nodeId: 'architecture-pdf', requires: 'bookforge.app-docs-pdf@1', input: {}, graphInput: {},
      outputs: { files: { result: { files: [{ path: 'ARCHITECTURE.md', absolutePath: designPath }] } },
        'source-reserve': { result: { scratchDir: join(root, 'scratch') } } } });
    expect(result.ok).toBe(false);
    expect(String((result as { error?: string }).error ?? '')).not.toBe('Bookforge graph input missing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an installed plugin root invokes the bundled engine and rejects a missing manuscript', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bookforge-installed-'));
  try {
    const provider = createBookforgeAppDocsRegistry(root).providers[0]!;
    const result = await provider.invoke({ graphId: 'bookforge-app-docs-pdf', runId: 'test',
      nodeId: 'reflow', requires: 'bookforge.app-docs-pdf@1', input: {}, outputs: {},
      graphInput: { designPath: join(root, 'missing.md'), outDir: join(root, 'out'), title: 'Test' } });
    expect(result).toMatchObject({ ok: false, outcome: 'failed',
      error: 'designPath must be a regular Markdown file of at most 128 KiB' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an already canceled graph starts no renderer child and cannot return a PDF', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bookforge-canceled-'));
  try {
    const designPath = join(root, 'ARCHITECTURE.md');
    writeFileSync(designPath, '# Test\n\nActual design content.\n');
    const abort = new AbortController(); abort.abort();
    const provider = createBookforgeAppDocsRegistry(root).providers[0]!;
    const result = await provider.invoke({ graphId: 'bookforge-app-docs-pdf', runId: 'canceled',
      nodeId: 'reflow', requires: 'bookforge.app-docs-pdf@1', input: {}, outputs: {},
      graphInput: { designPath, outDir: join(root, 'out'), title: 'Test' }, signal: abort.signal });
    expect(result).toMatchObject({ ok: false, outcome: 'failed', evidence: { aborted: true } });
    expect(JSON.stringify(result)).not.toContain('pdfPath');
    expect(existsSync(join(root, 'out'))).toBe(false);
    const marker = join(root, 'started');
    const direct = await runBoundedBookforgeProcess('python3', ['-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text("started")', marker], abort.signal);
    expect(direct.aborted).toBe(true);
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cancellation kills a running renderer and its child before either can leave output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bookforge-child-abort-'));
  try {
    const started = join(root, 'started');
    const childStarted = join(root, 'child-started');
    const late = join(root, 'late');
    const grandchild = join(root, 'grandchild.py');
    writeFileSync(grandchild, 'import pathlib,sys,time\npathlib.Path(sys.argv[1]).write_text("child")\ntime.sleep(0.4)\npathlib.Path(sys.argv[2]).write_text("late")\n');
    const parent = join(root, 'parent.py');
    writeFileSync(parent, 'import pathlib,subprocess,sys,time\npathlib.Path(sys.argv[1]).write_text("started")\nsubprocess.Popen([sys.executable,sys.argv[2],sys.argv[3],sys.argv[4]])\ntime.sleep(5)\n');
    const abort = new AbortController();
    const running = runBoundedBookforgeProcess('python3', [parent, started, grandchild, childStarted, late], abort.signal, 2_000);
    for (let attempt = 0; attempt < 40 && !existsSync(childStarted); attempt++)
      await new Promise(done => setTimeout(done, 10));
    expect(existsSync(started)).toBe(true);
    expect(existsSync(childStarted)).toBe(true);
    abort.abort();
    const result = await running;
    expect(result.aborted).toBe(true);
    expect(result.status).toBeNull();
    await new Promise(done => setTimeout(done, 600));
    expect(existsSync(late)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the production app-build registry runs architecture-pdf through the graph and renders one PDF', async () => {
  const appGraph = join(import.meta.dir, '../../../plugins/elanous-app-build/graph/app-build.yaml');
  const registry = await defaultCapabilityRegistryForGraph(appGraph);
  const providers = registry.providers.filter(provider => provider.provides.includes('bookforge.app-docs-pdf@1'));
  expect(providers).toHaveLength(1);
  expect(createRichSourceBuildWithApprovalRegistry().providers
    .filter(provider => provider.provides.includes('bookforge.app-docs-pdf@1'))).toHaveLength(1);
  const root = mkdtempSync(join(tmpdir(), 'bookforge-runner-'));
  const state = mkdtempSync(join(tmpdir(), 'bookforge-graph-state-'));
  const design = join(root, 'ARCHITECTURE.md');
  const out = join(root, 'out');
  writeFileSync(design, '# 설계\n\n## 배경\n' + '이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. 이 절의 본문은 스무 글자를 넘긴다. ' + '\n');
  const graph = join(root, 'graph.yaml');
  writeFileSync(graph, [
    'apiVersion: elanous.dev/graph/v2',
    'graph: { id: bookforge-app-docs-pdf, version: 1.0.0, layer: flow, purpose: "render one architecture PDF" }',
    'entry: architecture-pdf',
    'nodes:',
    '  - { id: architecture-pdf, type: capability, requires: bookforge.app-docs-pdf@1, max_visits: 2 }',
    'edges:',
    '  - { from: architecture-pdf, on: outcome, map: { done: done, failed: failed } }',
    'terminal: [done, failed]',
  ].join('\n'));
  try {
    const run = await runGraph(graph, { runId: 'wired-pdf', quiet: true,
      deps: { root: state, capabilityProviders: registry },
      input: { designPath: design, outDir: out, title: '설계' } });
    const node = run.nodes.find(item => item.nodeId === 'architecture-pdf');
    const parsed: unknown = typeof node?.output === 'string' ? JSON.parse(node.output) : node?.output;
    const output = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as { outcome?: string; result?: { pdfPath?: string; pageCount?: number } } : undefined;
    if (run.status !== 'done') throw new Error('GRAPH ' + JSON.stringify(parsed).slice(0, 1500));
    expect(run.status).toBe('done');
    expect(output?.outcome).toBe('done');
    const pdfPath = output?.result?.pdfPath ?? '';
    expect(existsSync(pdfPath)).toBe(true);
    const pdf = readFileSync(pdfPath);
    expect(pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    const pages = output?.result?.pageCount;
    expect(typeof pages).toBe('number');
    expect((pages as number) > 0).toBe(true);
    expect(pdf.includes(Buffer.from('/Type /Page')) || pdf.includes(Buffer.from('/Type/Page'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('a repair loop visits architecture-pdf twice and the second render replaces the project', async () => {
  const yaml = await Bun.file(join(import.meta.dir, '../../../plugins/elanous-app-build/graph/app-build.yaml')).text();
  const node = yaml.split('\n').find(line => line.includes('id: architecture-pdf'));
  expect(node).toContain('max_visits: 2');
  const root = mkdtempSync(join(tmpdir(), 'bookforge-revisit-'));
  const design = join(root, 'ARCHITECTURE.md');
  const out = join(root, 'scratch');
  const project = join(out, 'bookforge-project');
  writeFileSync(design, '# 설계\n\n## 배경\n' + '이 절의 본문은 스무 글자를 넘긴다. '.repeat(40) + '\n');
  const script = join(import.meta.dir, '../../../skills/bookforge/render_app_docs.py');
  const first = await runBoundedBookforgeProcess('python3', ['-c', BOOKFORGE_PYTHON, script, '--design', design, '--out', out, '--title', '설계']);
  const firstResult = JSON.parse(first.stdout) as { ok?: boolean; error?: string; pdfPath?: string; pageCount?: number };
  if (firstResult.ok !== true) throw new Error('RENDER ' + JSON.stringify({ stdout: first.stdout.slice(0, 800), stderr: first.stderr.slice(0, 800), status: first.status }));
  expect(firstResult.ok).toBe(true);
  expect(existsSync(firstResult.pdfPath ?? '')).toBe(true);
  expect(typeof firstResult.pageCount).toBe('number');
  expect((firstResult.pageCount as number) > 0).toBe(true);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'stale'), 'stale');
  const second = await runBoundedBookforgeProcess('python3', ['-c', BOOKFORGE_PYTHON, script, '--design', design, '--out', out, '--title', '설계']);
  const again = JSON.parse(second.stdout) as { error?: string };
  expect(again.error ?? '').not.toContain('already exists');
  expect(existsSync(join(project, 'stale'))).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test('renderer output and deadline stay bounded before a result can be accepted', async () => {
  const oversized = await runBoundedBookforgeProcess('python3', ['-c', 'print("x" * 140000)'], undefined, 2_000);
  expect(oversized.status).toBeNull();
  expect(oversized.error?.message).toContain('128 KiB');
  const expired = await runBoundedBookforgeProcess('python3', ['-c', 'import time; time.sleep(5)'], undefined, 50);
  expect(expired.aborted).toBe(true);
  expect(expired.status).toBeNull();
});
