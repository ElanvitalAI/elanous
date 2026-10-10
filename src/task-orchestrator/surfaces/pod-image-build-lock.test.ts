import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { rebuildLocalPodImageOnce, type PodImageFreshness } from './self-implement-pod.js';

const dirs: string[] = [];
const dir = () => { const path = mkdtempSync(join(tmpdir(), 'pod-local-image-build-')); dirs.push(path); return path; };
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

const stale: PodImageFreshness = { fresh: false, imageCommit: 'old', headCommit: 'new', reason: '이미지 old ≠ HEAD new' };
const fresh: PodImageFreshness = { ...stale, fresh: true, imageCommit: 'new', reason: 'HEAD 와 같다' };

function captureActions(): { actions: string[]; restore: () => void } {
  const actions: string[] = [];
  const original = debug.log;
  debug.log = ((category: string, event: string, data?: unknown) => {
    if (category === 'self-implement.pod' && event === 'image-build-local') actions.push((data as { action: string }).action);
  }) as typeof debug.log;
  return { actions, restore: () => { debug.log = original; } };
}

describe('local Pod image build single flight', () => {
  test('three simultaneous callers build once; both waiters reuse the fresh image', async () => {
    const lockDir = dir();
    const { actions, restore } = captureActions();
    let built = 0;
    let waits = 0;
    let image = stale;
    let releaseBuild!: () => void;
    const gate = new Promise<void>((resolve) => { releaseBuild = resolve; });
    try {
      const deps = {
        lockDir, freshness: () => image, onWait: () => { waits++; },
        build: async () => { built++; await gate; image = fresh; return { status: 0, stdout: '', stderr: '' }; },
      };
      const first = rebuildLocalPodImageOnce(deps);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const waiting = [rebuildLocalPodImageOnce(deps), rebuildLocalPodImageOnce(deps)];
      await new Promise((resolve) => setTimeout(resolve, 30));
      releaseBuild();
      const results = await Promise.all([first, ...waiting]);
      expect(results.map((result) => result.action).sort()).toEqual(['built', 'skipped-after-wait', 'skipped-after-wait']);
      expect(results.every((result) => result.image === fresh)).toBe(true);
      expect(actions.sort()).toEqual(['built', 'skipped-after-wait', 'skipped-after-wait']);
      expect(built).toBe(1);
      expect(waits).toBe(2);
      expect(existsSync(join(lockDir, 'local.build'))).toBe(false);
    } finally { releaseBuild(); restore(); }
  }, 10_000);

  test('already fresh bypasses lock creation and build', async () => {
    const lockDir = join(dir(), 'image-ship');
    let builds = 0;
    const result = await rebuildLocalPodImageOnce({ lockDir, freshness: () => fresh, build: async () => { builds++; return { status: 0, stdout: '', stderr: '' }; } });
    expect(result).toMatchObject({ action: 'fresh', image: fresh });
    expect(builds).toBe(0);
    expect(existsSync(lockDir)).toBe(false);
  });

  test('failed build records failed, releases lock, and the next call retries', async () => {
    const lockDir = dir();
    const { actions, restore } = captureActions();
    let builds = 0;
    try {
      const deps = { lockDir, freshness: () => stale, build: async () => { builds++; return { status: 1, stdout: '', stderr: 'failed build' }; } };
      const first = await rebuildLocalPodImageOnce(deps);
      expect(first).toMatchObject({ action: 'failed', image: stale });
      expect(first.error).toContain('--substrate pod: 이미지 굽기 실패 rc=1: failed build');
      expect(existsSync(join(lockDir, 'local.build'))).toBe(false);
      const second = await rebuildLocalPodImageOnce(deps);
      expect(second.action).toBe('failed');
      expect(builds).toBe(2);
      expect(actions).toEqual(['failed', 'failed']);
      expect(existsSync(join(lockDir, 'local.build'))).toBe(false);
    } finally { restore(); }
  });
});
