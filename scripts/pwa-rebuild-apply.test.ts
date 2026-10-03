import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { applyPwaRebuild } from './pwa-rebuild-apply.js';
import type { PwaRebuildDecision } from './pwa-rebuild-decide.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const target = '/tmp/pwa-rebuild-apply-target';

function decider(decision: PwaRebuildDecision): () => Promise<PwaRebuildDecision> {
  return async () => decision;
}

describe('PWA rebuild application', () => {
  test('runs the injectable build seam only when the structured decision requires a rebuild', async () => {
    let buildCalls = 0;
    const result = await applyPwaRebuild(target, {
      decider: decider({ action: 'rebuild', reason: 'source-newer', path: target, source: 'apps/pwa/src/page.tsx' }),
      buildRunner: async (receivedTarget) => { buildCalls++; expect(receivedTarget).toBe(target); },
    });

    expect(buildCalls).toBe(1);
    expect(result.outcome).toBe('rebuilt');
    if (result.outcome !== 'rebuilt') throw new Error('expected rebuild success');
    expect(result.message).toContain('pwa rebuild succeeded');
    expect(result.message).toContain('nexus build completed');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('does not build when the structured decision is not-needed', async () => {
    let buildCalls = 0;
    const result = await applyPwaRebuild(target, {
      decider: decider({ action: 'not-needed', reason: 'bundle-current', path: target }),
      buildRunner: async () => { buildCalls++; },
    });

    expect(buildCalls).toBe(0);
    expect(result.outcome).toBe('not-needed');
    expect(result.message).toContain('pwa rebuild not needed');
    expect(result.message).toContain('was not run');
  });

  test('does not build when the structured decision is unavailable and distinguishes its message', async () => {
    let buildCalls = 0;
    const result = await applyPwaRebuild(target, {
      decider: decider({ action: 'unavailable', reason: 'target-unreadable', path: target, error: 'permission denied' }),
      buildRunner: async () => { buildCalls++; },
    });

    expect(buildCalls).toBe(0);
    expect(result.outcome).toBe('unavailable');
    expect(result.message).toContain('pwa rebuild unavailable');
    expect(result.message).not.toContain('pwa rebuild not needed');
    expect(result.message).toContain('was not run');
  });

  test('reports build failure distinctly from rebuild success', async () => {
    const result = await applyPwaRebuild(target, {
      decider: decider({ action: 'rebuild', reason: 'bundle-missing', path: target }),
      buildRunner: async () => { throw new Error('build runner exploded'); },
    });

    expect(result.outcome).toBe('build-failed');
    if (result.outcome !== 'build-failed') throw new Error('expected rebuild failure');
    expect(result.message).toContain('pwa rebuild failed');
    expect(result.message).not.toContain('pwa rebuild succeeded');
    expect(result.message).toContain('build runner exploded');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('CLI entrypoint refuses a missing target without triggering a real build', async () => {
    const child = Bun.spawn({ cmd: ['bun', 'scripts/pwa-rebuild-apply.ts'], cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe('');
    expect(stdout).toContain('explicit absolute target tree path is required');
    expect(stdout).toContain('refusing to infer it from process.cwd()');
  });

  test('refuses missing and relative targets without calling decider or build seam', async () => {
    let deciderCalls = 0;
    let buildCalls = 0;
    const seams = {
      decider: async () => { deciderCalls++; return { action: 'not-needed', reason: 'bundle-current', path: target } as const; },
      buildRunner: async () => { buildCalls++; },
    };

    const missing = await applyPwaRebuild(undefined, seams);
    const relative = await applyPwaRebuild('relative/tree', seams);

    expect(deciderCalls).toBe(0);
    expect(buildCalls).toBe(0);
    expect(missing.outcome).toBe('unavailable');
    expect(relative.outcome).toBe('unavailable');
    expect(missing.message).toContain('explicit absolute target tree path is required');
    expect(missing.message).toContain('refusing to infer it from process.cwd()');
  });
});
