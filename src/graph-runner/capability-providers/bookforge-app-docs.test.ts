import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCapabilityRegistryForGraph } from '../plugin-graph-providers.js';
import { createBookforgeAppDocsRegistry, runBoundedBookforgeProcess } from './bookforge-app-docs.js';

test('bundled Bookforge graph resolves one provider and refuses missing design paths', async () => {
  const graph = join(import.meta.dir, '../../../plugins/bookforge/graphs/app-docs-pdf.yaml');
  const registry = await defaultCapabilityRegistryForGraph(graph);
  const providers = registry.providers.filter(provider => provider.provides.includes('bookforge.app-docs-pdf@1'));
  expect(providers).toHaveLength(1);
  const result = await providers[0]!.invoke({ graphId: 'bookforge-app-docs-pdf', runId: 'test',
    nodeId: 'reflow', requires: 'bookforge.app-docs-pdf@1', input: {}, graphInput: {}, outputs: {} });
  expect(result).toMatchObject({ ok: false, outcome: 'failed' });
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

test('renderer output and deadline stay bounded before a result can be accepted', async () => {
  const oversized = await runBoundedBookforgeProcess('python3', ['-c', 'print("x" * 140000)'], undefined, 2_000);
  expect(oversized.status).toBeNull();
  expect(oversized.error?.message).toContain('128 KiB');
  const expired = await runBoundedBookforgeProcess('python3', ['-c', 'import time; time.sleep(5)'], undefined, 50);
  expect(expired.aborted).toBe(true);
  expect(expired.status).toBeNull();
});
