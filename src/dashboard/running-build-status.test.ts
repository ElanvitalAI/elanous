// 상태줄 «실행 판» — 값 공급(createRunningBuildStatus) ⊕ 렌더(runningBuildSegment · git 「트리」 라벨) ⊕ 상태줄 배선.
import { describe, expect, test } from 'bun:test';
import { createRunningBuildStatus } from './running-build-status.js';
import { gitSegment, runningBuildSegment } from '../status/bar.js';
import { createDashboardMouseWiring } from './input/mouse-wiring.js';
import type { ActiveProviderInfo } from '../provider-summary.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('createRunningBuildStatus', () => {
  test('installed boot build: same → not stale; installed moved → stale with the relaunch target', () => {
    let installedSha = SHA_A; let t = 0;
    const status = createRunningBuildStatus({
      build: () => ({ version: 'v', sha: SHA_A, source: 'installed' }), readInstalled: () => ({ sha: installedSha }), now: () => t, ttlMs: 1000,
    });
    expect(status()).toEqual({ sha: SHA_A, stale: false });
    installedSha = SHA_B;
    t = 500; expect(status()).toEqual({ sha: SHA_A, stale: false });   // TTL 안에서는 다시 안 읽는다
    t = 1500; expect(status()).toEqual({ sha: SHA_A, stale: true, currentSha: SHA_B });
  });

  test('checkout boot build compares against that checkout HEAD; unknown sha hides the pill', () => {
    const checkout = createRunningBuildStatus({
      build: () => ({ version: 'v', sha: SHA_A, source: 'checkout', codeRoot: '/r' }), readCheckoutHead: () => SHA_B, readInstalled: () => ({ sha: SHA_A }),
    });
    expect(checkout()).toEqual({ sha: SHA_A, stale: true, currentSha: SHA_B });
    expect(createRunningBuildStatus({ build: () => ({ version: 'v', sha: '', source: 'unknown' }) })()).toEqual({ sha: '', stale: null });
    expect(createRunningBuildStatus({ build: () => { throw new Error('x'); } })()).toEqual({ sha: '', stale: null });
    // 비교 대상 판독이 터져도 기동 판은 남는다.
    expect(createRunningBuildStatus({ build: () => ({ version: 'v', sha: SHA_A, source: 'installed' }), readInstalled: () => { throw new Error('io'); } })()).toEqual({ sha: SHA_A, stale: null });
    // 비교 대상을 못 읽으면 null — «안 낡았다»로 접지 않는다.
    expect(createRunningBuildStatus({ build: () => ({ version: 'v', sha: SHA_A, source: 'installed' }), readInstalled: () => ({}) })()).toEqual({ sha: SHA_A, stale: null });
  });
});

describe('runningBuildSegment / git label', () => {
  test('renders the boot sha, and a relaunch marker when stale', () => {
    expect(strip(runningBuildSegment({ sha: SHA_A, stale: false }))).toBe('▶ 실행 aaaaaaa');
    expect(strip(runningBuildSegment({ sha: SHA_A, stale: true, currentSha: SHA_B }))).toBe('▶ 실행 aaaaaaa ⟳ 재기동 필요 → bbbbbbb');
    expect(strip(runningBuildSegment({ sha: SHA_A, stale: true }))).toBe('▶ 실행 aaaaaaa ⟳ 재기동 필요');
    expect(strip(runningBuildSegment({ sha: SHA_A, stale: null }))).toBe('▶ 실행 aaaaaaa ?');
    expect(strip(runningBuildSegment({ sha: '', stale: null }))).toBe('▶ 실행 ?');
    expect(runningBuildSegment(undefined)).toBe('');
  });

  test('git pill keeps HEAD@ and only gains the 트리 label when asked', () => {
    expect(strip(gitSegment('/x', { detachedSha: 'c822f5d05' }))).toBe('⌥ HEAD@c822f5d');
    expect(strip(gitSegment('/x', { detachedSha: 'c822f5d05', label: '트리' }))).toBe('⌥ 트리 HEAD@c822f5d');
  });
});

describe('status line wiring', () => {
  const providerInfo = (): ActiveProviderInfo => ({ provider: 'openai', model: 'gpt-5.4-mini' } as ActiveProviderInfo);
  const buildLine = (runningBuild?: { sha: string; stale: boolean | null; currentSha?: string }) => createDashboardMouseWiring({
    termSize: () => ({ rows: 24, cols: 160 }),
    getRotation: () => [],
    setActiveModel: () => {},
    getRecentWds: () => [],
    setSessionWd: () => {},
    pushModalSurface: () => ({ dispose: () => {} }),
    redraw: () => {},
  }).buildStatusLine({
    swd: '/Users/test/project',
    gitState: { detachedSha: SHA_B },
    providerInfo: providerInfo(),
    ...(runningBuild ? { runningBuild } : {}),
  });

  test('running build sits right after the tree-labelled git pill; stale shows the relaunch marker', () => {
    expect(strip(buildLine({ sha: SHA_A, stale: true, currentSha: SHA_B }))).toBe(' 📁 test/project  │ ⌥ 트리 HEAD@bbbbbbb │ ▶ 실행 aaaaaaa ⟳ 재기동 필요 → bbbbbbb │ gpt-5.4-mini');
  });

  test('without a running build the line is unchanged', () => {
    expect(strip(buildLine())).toBe(' 📁 test/project  │ ⌥ HEAD@bbbbbbb │ gpt-5.4-mini');
  });
});
