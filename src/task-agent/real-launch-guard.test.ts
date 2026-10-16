import { describe, expect, test } from 'bun:test';
import { defaultTaskLauncher, type DetachedSpawn } from '../cli/tasks-cli.js';
import type { ParentHostConfig } from './parent-host.js';
import { ALLOW_REAL_LAUNCH_UNDER_TEST_ENV, RealLaunchRefusedUnderTestError, refuseRealLaunchUnderTest } from './real-launch-guard.js';

// R7(2026-10-16): seam 이 빠진 시험이 실 ssh 원격 부모·실 harness say 를 띄워 prod 런 25 · draft PR 11 을 만들었다.
// 이 가드가 «bun test 안 · 명시 허용 없음 · 주입 없음» 의 실물 발사를 거부한다.
// ⚠️ 가드가 깨지면 이 파일이 실 ssh 를 쏘지 않게 대상 호스트는 해석 불가 이름(.invalid)이다.
const UNREACHABLE: ParentHostConfig = { host: 'r7-guard-probe.invalid', cwd: '/nonexistent-r7' };
const context = { runId: 'run-r7guard-0001', launchId: 'tl-r7', env: { ELANOUS_RUN_ID: 'run-r7guard-0001' } };

describe('refuseRealLaunchUnderTest', () => {
  test('시험 러너 안이면 거부 · 명시 허용이면 통과 · 시험 밖이면 아무것도 안 한다', () => {
    expect(() => refuseRealLaunchUnderTest('remote-parent-ssh', 'node-b', { NODE_ENV: 'test' })).toThrow(RealLaunchRefusedUnderTestError);
    expect(() => refuseRealLaunchUnderTest('local-harness-spawn', '', { BUN_TEST: '1' })).toThrow('local-harness-spawn');
    expect(() => refuseRealLaunchUnderTest('remote-parent-ssh', 'node-b', { NODE_ENV: 'test', [ALLOW_REAL_LAUNCH_UNDER_TEST_ENV]: '1' })).not.toThrow();
    expect(() => refuseRealLaunchUnderTest('remote-parent-ssh', 'node-b', {})).not.toThrow();
    expect(() => refuseRealLaunchUnderTest('local-harness-spawn', '', { NODE_ENV: 'production' })).not.toThrow();
  });

  test('이 프로세스(bun test)에서 실제로 무는가 — 러너 판정이 거짓이면 가드는 장식이다', () => {
    expect(process.env[ALLOW_REAL_LAUNCH_UNDER_TEST_ENV]).toBeUndefined();
    expect(() => refuseRealLaunchUnderTest('remote-parent-ssh')).toThrow(RealLaunchRefusedUnderTestError);
  });
});

describe('defaultTaskLauncher — 시험 안 실물 발사 거부', () => {
  test('원격 대상이 있는데 ssh 주입이 없으면 ssh 전에 거부한다(로컬로도 안 간다)', async () => {
    let localSpawned = 0;
    const spawn: DetachedSpawn = () => { localSpawned++; throw new Error('로컬로 가면 안 된다'); };
    await expect(defaultTaskLauncher(['harness', 'say', 'g'], undefined, context, { parentHost: [UNREACHABLE], launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn, notice: () => {} }))
      .rejects.toThrow(RealLaunchRefusedUnderTestError);
    expect(localSpawned).toBe(0);
  });

  test('hold(발사 동결) 경로에서도 가드가 먼저 막는다 — preflight 가 hold 와 무관하게 실 ssh 를 부르므로(r3b 반론 고정)', async () => {
    let holdRead = 0;
    let localSpawned = 0;
    const spawn: DetachedSpawn = () => { localSpawned++; throw new Error('로컬로 가면 안 된다'); };
    // 단일 대상(목록 아님) ⊕ hold 참 — 가드가 hold 판정 «뒤»로 내려가면 holdRead 가 1 이 되고 그 다음 preflight 가 실 ssh 를 쏜다.
    await expect(defaultTaskLauncher(['harness', 'say', 'g'], undefined, context, { parentHost: UNREACHABLE, launchHoldActive: () => { holdRead++; return true; }, localVersion: '0.2.20-dev.0', spawn, notice: () => {} }))
      .rejects.toThrow(RealLaunchRefusedUnderTestError);
    expect(holdRead).toBe(0);
    expect(localSpawned).toBe(0);
  });

  test('spawn 주입이 없으면 실물을 띄우지 않고 거부한다', async () => {
    // ⚠️ 인자는 «무해한» `--version` 이다 — 가드가 회귀해도 이 시험이 실 harness say 를 띄우지 않게(리뷰 must-fix).
    //   가드는 인자와 무관하게 «주입 없는 실 spawn» 자체를 거부하므로 이것으로 충분히 문다.
    await expect(defaultTaskLauncher(['--version'], undefined, context, { parentHost: null, earlyExitWindowMs: 0 }))
      .rejects.toThrow('local-harness-spawn');
    await expect(defaultTaskLauncher(['--version'])).rejects.toThrow(RealLaunchRefusedUnderTestError);
  });
});
