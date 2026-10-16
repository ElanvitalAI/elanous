// src/acp/grok-leader-manager.test.ts
//
// GrokLeaderManager 의 lifecycle + spawn args contract 검증. 실제 grok
// binary 를 spawn 하지 않음 — resolveGrokBin 의 PATH fallback + state
// snapshot + spawnClient args shape 만 검증. 실 leader process 의 round-
// trip 은 별 integration test (사용자 환경에서 manual smoke).

import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTestHome } from '../../test/helpers/with-test-home.js';
import { withFakeBins } from '../ux-sim/fake-bin.js';
import {
  GrokLeaderManager,
  getGrokLeaderManager,
  _resetGrokLeaderManager,
} from './grok-leader-manager.js';

describe('GrokLeaderManager · initial state', () => {
  beforeEach(() => {
    _resetGrokLeaderManager();
  });

  test('fresh instance has null state', () => {
    const mgr = new GrokLeaderManager();
    const state = mgr.state();
    expect(state.pid).toBeNull();
    expect(state.startedAt).toBeNull();
    expect(state.exitCode).toBeNull();
    expect(mgr._leaderProcess()).toBeNull();
  });

  test('shutdownLeader is no-op when nothing running', async () => {
    const mgr = new GrokLeaderManager();
    await mgr.shutdownLeader();
    expect(mgr.state().pid).toBeNull();
  });
});

describe('GrokLeaderManager · spawnClient args', () => {
  test('default args include `--leader` flag', () => {
    const mgr = new GrokLeaderManager();
    const { command, args } = mgr.spawnClient();
    expect(args).toEqual(['agent', 'stdio', '--leader']);
    expect(command).toMatch(/grok$/); // '~/grok' or 'grok'
  });

  test('extra args appended after `--leader`', () => {
    const mgr = new GrokLeaderManager();
    const { args } = mgr.spawnClient(['--model', 'grok-3']);
    expect(args).toEqual(['agent', 'stdio', '--leader', '--model', 'grok-3']);
  });
});

describe('GrokLeaderManager · singleton', () => {
  beforeEach(() => {
    _resetGrokLeaderManager();
  });

  test('getGrokLeaderManager returns same instance across calls', () => {
    const m1 = getGrokLeaderManager();
    const m2 = getGrokLeaderManager();
    expect(m1).toBe(m2);
  });

  test('_resetGrokLeaderManager creates fresh instance', () => {
    const m1 = getGrokLeaderManager();
    _resetGrokLeaderManager();
    const m2 = getGrokLeaderManager();
    expect(m1).not.toBe(m2);
  });
});

describe('GrokLeaderManager · ensureLeader idempotency contract', () => {
  // 실 grok 을 띄우지 않는다: 게이트 Pod 엔 grok 이 없고(`Executable not found in $PATH: "grok"`),
  // 개발 기계엔 ~/.grok/bin/grok 이 있어 진짜 leader 가 떴다. 빈 HOME(~/.grok 없음) ⊕ PATH 앞
  // 가짜 grok(src/ux-sim/fake-bin)으로 «PATH fallback → spawn → 상태 반환» 경로만 잰다.

  test('ensureLeader returns state object (does not throw)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-leader-home-'));
    try {
      await withTestHome(home, () => withFakeBins({ grok: { sleepSeconds: 30 } }, async (fakeBins) => {
        const mgr = new GrokLeaderManager();
        try {
          const state = mgr.ensureLeader();
          expect(state).toBeDefined();
          expect(typeof state.pid).toBe('number');
          expect(mgr._leaderProcess()).not.toBeNull();
          // 살아 있으면 두 번째 호출은 새로 띄우지 않는다.
          expect(mgr.ensureLeader().pid).toBe(state.pid);
          expect(await fakeBins.waitForCalls(1)).toEqual([{ name: 'grok', argv: ['agent', 'leader'] }]);
        } finally {
          // 단언이 실패해도 가짜 leader(30초 sleep)를 남기지 않는다.
          const proc = mgr._leaderProcess();
          if (proc && proc.exitCode === null) {
            const exited = new Promise((resolve) => proc.once('exit', resolve));
            proc.kill('SIGKILL');
            await exited;
          }
        }
      }));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
