import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decidePwaRebuild, formatPwaRebuildDecision, main } from './pwa-rebuild-decide.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const past = new Date('2026-01-01T00:00:00.000Z');
const future = new Date('2026-01-02T00:00:00.000Z');
const artifactFuture = new Date('2026-01-03T00:00:00.000Z');

async function runCli(target: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({ cmd: ['bun', 'scripts/pwa-rebuild-decide.ts', target], cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function fixture(): Promise<{ target: string; source: string; bundle: string }> {
  const target = await mkdtemp(join(tmpdir(), 'pwa-rebuild-decide-'));
  const source = join(target, 'apps/pwa/src/page.tsx');
  const bundle = join(target, 'apps/pwa/out/index.html');
  await mkdir(join(target, 'apps/pwa/src'), { recursive: true });
  await mkdir(join(target, 'apps/pwa/out'), { recursive: true });
  await writeFile(source, 'source');
  await writeFile(bundle, 'bundle');
  await utimes(source, past, past);
  await utimes(bundle, future, future);
  return { target, source, bundle };
}

describe('PWA rebuild decision', () => {
  test('rebuilds when a source file is newer and names it', async () => {
    const tree = await fixture();
    try {
      await utimes(tree.source, future, future);
      await utimes(tree.bundle, past, past);
      await expect(decidePwaRebuild(tree.target)).resolves.toEqual({ action: 'rebuild', reason: 'source-newer', path: tree.target, source: 'apps/pwa/src/page.tsx' });
    } finally { await rm(tree.target, { recursive: true, force: true }); }
  });

  test('does not rebuild when the bundle is current', async () => {
    const tree = await fixture();
    try {
      await expect(decidePwaRebuild(tree.target)).resolves.toEqual({ action: 'not-needed', reason: 'bundle-current', path: tree.target });
    } finally { await rm(tree.target, { recursive: true, force: true }); }
  });

  test('does not rebuild when only .next build artifacts are newer', async () => {
    const tree = await fixture();
    try {
      const artifact = join(tree.target, 'apps/pwa/.next/trace');
      await mkdir(join(tree.target, 'apps/pwa/.next'), { recursive: true });
      await writeFile(artifact, 'generated');
      await utimes(artifact, artifactFuture, artifactFuture);
      await expect(decidePwaRebuild(tree.target)).resolves.toEqual({ action: 'not-needed', reason: 'bundle-current', path: tree.target });
    } finally { await rm(tree.target, { recursive: true, force: true }); }
  });

  test('rebuilds when the bundle directory is missing', async () => {
    const tree = await fixture();
    try {
      await rm(join(tree.target, 'apps/pwa/out'), { recursive: true });
      await expect(decidePwaRebuild(tree.target)).resolves.toEqual({ action: 'rebuild', reason: 'bundle-missing', path: tree.target });
    } finally { await rm(tree.target, { recursive: true, force: true }); }
  });

  test('reports unavailable and names a nonexistent target', async () => {
    const target = join(tmpdir(), `pwa-rebuild-missing-${crypto.randomUUID()}`);
    const decision = await decidePwaRebuild(target);
    expect(decision).toMatchObject({ action: 'unavailable', reason: 'target-unreadable', path: target });
    expect(formatPwaRebuildDecision(decision)).toContain(target);
  });

  test('CLI entrypoint accepts a positional target, exits successfully, and emits exactly one line', async () => {
    const tree = await fixture();
    try {
      const result = await runCli(tree.target);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(`pwa rebuild not needed: apps/pwa/out is current in ${tree.target}\n`);
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
    } finally {
      await rm(tree.target, { recursive: true, force: true });
    }
  });

  test('main formats an explicit target for programmatic callers', async () => {
    const tree = await fixture();
    const lines: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (line: string) => { lines.push(line); };
      await expect(main(tree.target)).resolves.toEqual({ action: 'not-needed', reason: 'bundle-current', path: tree.target });
      expect(lines).toEqual([`pwa rebuild not needed: apps/pwa/out is current in ${tree.target}`]);
    } finally {
      console.log = originalLog;
      await rm(tree.target, { recursive: true, force: true });
    }
  });
});
