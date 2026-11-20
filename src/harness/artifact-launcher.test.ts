import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { launchGoalArtifact, type ArtifactLaunchDeps } from './artifact-launcher.js';

/** 테스트용 자식 — 실제 프로세스를 띄우지 않고 수명주기 «사건»만 재현한다. */
class FakeChild extends EventEmitter {
  public killed: NodeJS.Signals[] = [];
  constructor(public pid: number | undefined = 4242) { super(); }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push((signal ?? 'SIGTERM') as NodeJS.Signals);
    return true;
  }
}

const asChild = (fake: FakeChild): ChildProcess => fake as unknown as ChildProcess;

const GOAL_WITH_PORT = '# goal\n\n## 산출물을 어떻게 켜나\nEntrypoint: test:deterministic\nPort: 39001\n';
const GOAL_NO_DECLARATION = '# goal\n\n본문만 있다.\n';
const GOAL_NO_PORT = '# goal\n\n## 산출물을 어떻게 켜나\nEntrypoint: test:deterministic\n';

/** stop 이 끝나야 하는 실시간 상한 — 유예(killGraceMs)+확인(killWaitMs) 위에 넉넉히 얹은 값. */
const STOP_BOUND_MS = 2_000;

/** 시간을 손으로 돌린다 — 상한·유예를 실시간 없이 재기 위해. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    advance: (ms: number) => { t += ms; },
  };
}

function baseDeps(overrides: Partial<ArtifactLaunchDeps> = {}): ArtifactLaunchDeps {
  const clock = fakeClock();
  return {
    repositoryRoot: '/repo',
    resolveCommand: async () => ({ command: 'bun run start' }),
    readGoal: async () => GOAL_WITH_PORT,
    now: clock.now,
    sleep: clock.sleep,
    killGroup: () => true,
    groupAlive: () => false,
    pollIntervalMs: 10,
    killGraceMs: 100,
    readyTimeoutMs: 1_000,
    ...overrides,
  };
}

describe('launchGoalArtifact — 선언을 못 읽는 갈래', () => {
  it('기동 선언이 없으면 no-launch-declaration 이고 자식을 띄우지 않는다', async () => {
    let spawned = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      readGoal: async () => GOAL_NO_DECLARATION,
      spawn: () => { spawned += 1; return asChild(new FakeChild()); },
    }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('no-launch-declaration');
    expect(spawned).toBe(0);
  });

  it('Port 선언이 없으면 no-port-declaration 이고 no-launch-declaration 과 다른 값이다', async () => {
    let spawned = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      readGoal: async () => GOAL_NO_PORT,
      spawn: () => { spawned += 1; return asChild(new FakeChild()); },
    }));
    expect(result.ok === false && result.reason).toBe('no-port-declaration');
    expect(spawned).toBe(0);
  });
});

describe('launchGoalArtifact — 귀속(④)', () => {
  it('띄우기 전에 포트가 이미 열려 있으면 port-already-in-use 이고 자식을 띄우지 않는다', async () => {
    let spawned = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      probePort: async () => true,
      spawn: () => { spawned += 1; return asChild(new FakeChild()); },
    }));
    expect(result.ok === false && result.reason).toBe('port-already-in-use');
    expect(spawned).toBe(0);
  });

  it('자식이 먼저 죽으면 포트가 열려도 early-exit 이다 — 남의 응답을 우리 것으로 세지 않는다', async () => {
    const child = new FakeChild();
    let probes = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => { queueMicrotask(() => child.emit('exit', 1, null)); return asChild(child); },
      // 첫 프로브는 「띄우기 전 검사」(닫힘)이고, 그 뒤로는 «열린» 포트를 흉내낸다.
      probePort: async () => { probes += 1; return probes > 1; },
    }));
    expect(result.ok === false && result.reason).toBe('early-exit');
  });
});

describe('launchGoalArtifact — 프로브 «도중» 종료(④의 핵심)', () => {
  it('프로브가 await 중에 자식이 죽고 그 프로브가 true 를 내면 early-exit 이다', async () => {
    const child = new FakeChild();
    let probes = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => {
        probes += 1;
        if (probes === 1) return false;                  // 띄우기 «전» 검사 — 비어 있다
        child.emit('exit', 1, null);                     // ⭐ 프로브 «도중»에 죽는다
        return true;                                     // 그런데 포트는 응답한다(남의 것일 수 있다)
      },
    }));
    expect(result.ok === false && result.reason).toBe('early-exit');
    expect(result.ok === false && result.detail).toContain('while the port was being probed');
  });
});

describe('launchGoalArtifact — spawn 실패(③)', () => {
  it('동기 throw 를 spawn-failed 값으로 바꾼다', async () => {
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => { throw new Error('boom'); },
      probePort: async () => false,
    }));
    expect(result.ok === false && result.reason).toBe('spawn-failed');
    expect(result.ok === false && result.detail).toContain('boom');
  });

  it('비동기 error 이벤트도 spawn-failed 값으로 바꾸고 «실제로» 자식을 정리한다', async () => {
    const child = new FakeChild();
    const groupSignals: NodeJS.Signals[] = [];
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => { queueMicrotask(() => child.emit('error', new Error('enoent'))); return asChild(child); },
      probePort: async () => false,
      killGroup: (_pid, signal) => { groupSignals.push(signal); return true; },
    }));
    expect(result.ok === false && result.reason).toBe('spawn-failed');
    expect(result.ok === false && result.detail).toContain('enoent');
    // ⛔ 제목만 「정리한다」라고 하고 검증을 안 하면 await stop() 을 지워도 통과한다(리뷰 must-fix).
    expect(groupSignals.length + child.killed.length).toBeGreaterThan(0);
  });
});

describe('launchGoalArtifact — 상한과 정리(⑤)', () => {
  it('포트가 끝내 안 열리면 port-timeout 이고 자식이 종료된다', async () => {
    const child = new FakeChild();
    const groupSignals: NodeJS.Signals[] = [];
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => false,
      groupAlive: () => true,                          // KILL-TREE-ONE: SIGKILL 승격은 «그룹이 남았을 때» — 그룹 probe 가 권위
      killGroup: (_pid, signal) => { groupSignals.push(signal); return true; },
    }));
    expect(result.ok === false && result.reason).toBe('port-timeout');
    expect(groupSignals).toContain('SIGTERM');
    expect(groupSignals).toContain('SIGKILL');
  });

  it('그룹 신호가 안 통하면(②) 자식 자신에게 폴백한다', async () => {
    const child = new FakeChild();
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => false,
      groupAlive: () => true,                          // 그룹이 남아 있다 → 유예 뒤 SIGKILL (그룹 신호는 계속 실패 → 자식 폴백)
      killGroup: () => false,
    }));
    expect(result.ok).toBe(false);
    expect(child.killed).toContain('SIGTERM');
    expect(child.killed).toContain('SIGKILL');
  });

  it('리더가 죽고 «그룹이 비었음이 확인»되면 SIGKILL 을 보내지 않는다', async () => {
    const child = new FakeChild();
    let exited = false;
    const groupSignals: NodeJS.Signals[] = [];
    await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => false,
      groupAlive: () => false,                         // ⭐ 그룹이 «비었다»고 확인된다
      killGroup: (_pid, signal) => {
        groupSignals.push(signal);
        if (signal === 'SIGTERM') queueMicrotask(() => { exited = true; child.emit('exit', 0, null); });
        return true;
      },
    }));
    expect(groupSignals).toEqual(['SIGTERM']);
    expect(child.killed).toHaveLength(0);
    expect(exited).toBe(true);
  });

  it('⭐ 리더는 죽었는데 «그룹이 살아 있으면» SIGKILL 을 보낸다 — 손자 누수를 막는다', async () => {
    const child = new FakeChild();
    const groupSignals: NodeJS.Signals[] = [];
    await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => false,
      groupAlive: () => true,                          // 셸은 죽었지만 손자가 남았다
      killGroup: (_pid, signal) => {
        groupSignals.push(signal);
        if (signal === 'SIGTERM') queueMicrotask(() => child.emit('exit', 0, null));
        return true;
      },
    }));
    expect(groupSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('그룹 생존을 «못 쟀으면» 비었다고 가정하지 않고 SIGKILL 을 보낸다', async () => {
    const child = new FakeChild();
    const groupSignals: NodeJS.Signals[] = [];
    await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => false,
      groupAlive: () => undefined,                     // ⛔ 못 쟀다
      killGroup: (_pid, signal) => {
        groupSignals.push(signal);
        if (signal === 'SIGTERM') queueMicrotask(() => child.emit('exit', 0, null));
        return true;
      },
    }));
    expect(groupSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('killGroup 이 throw 해도 자식 폴백과 강제 종료가 «둘 다» 난다', async () => {
    const child = new FakeChild();
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => false,
      groupAlive: () => true,
      killGroup: () => { throw new Error('EPERM'); },
    }));
    expect(result.ok).toBe(false);
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('준비 대기 중 프로브가 throw 해도 자식을 끈다 — 예외로 고아를 만들지 않는다', async () => {
    const child = new FakeChild();
    const groupSignals: NodeJS.Signals[] = [];
    let probes = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => { probes += 1; if (probes > 1) throw new Error('probe exploded'); return false; },
      killGroup: (_pid, signal) => {
        groupSignals.push(signal);
        if (signal === 'SIGTERM') queueMicrotask(() => child.emit('exit', 0, null));
        return true;
      },
    }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toContain('probe exploded');
    expect(groupSignals).toContain('SIGTERM');
  });
});

describe('launchGoalArtifact — KILL-TREE-ONE: 정리는 공용 terminateTree', () => {
  it('리더가 안 죽어도 «그룹이 비면» 유예 안에 끝나고 SIGKILL 을 보내지 않는다', async () => {
    const child = new FakeChild();
    const groupSignals: NodeJS.Signals[] = [];
    let probes = 0;
    await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => false,
      killGroup: (_pid, signal) => { groupSignals.push(signal); return true; },
      groupAlive: () => { probes += 1; return probes < 3 ? true : false; },   // 두 번 살아 있다가 비었다
    }));
    expect(groupSignals).toEqual(['SIGTERM']);
    expect(child.killed).toHaveLength(0);
  });

  it('SIGKILL 뒤에도 그룹이 남으면 stop 은 끝나되(무한 대기 없음) 확인 실패를 관측으로 남긴다', async () => {
    const child = new FakeChild();
    const groupSignals: NodeJS.Signals[] = [];
    const t0 = Date.now();
    await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => false,
      groupAlive: () => true,
      killGroup: (_pid, signal) => { groupSignals.push(signal); return true; },
    }));
    expect(groupSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(Date.now() - t0).toBeLessThan(STOP_BOUND_MS);   // 유예 100ms + 확인 100ms — 상한이 있다
  });
});

describe('launchGoalArtifact — 해석 실패 갈래', () => {
  it('명령 후보가 없으면 no-command-source 이고 자식을 띄우지 않는다', async () => {
    let spawned = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      resolveCommand: async () => ({ reason: 'no-command-source' }),
      spawn: () => { spawned += 1; return asChild(new FakeChild()); },
    }));
    expect(result.ok === false && result.reason).toBe('no-command-source');
    expect(spawned).toBe(0);
  });

  it('명령 후보가 여럿이면 ambiguous-command-source 이고 후보를 이름으로 낸다', async () => {
    const result = await launchGoalArtifact('goal.md', baseDeps({
      resolveCommand: async () => ({ reason: 'ambiguous-command-source', candidates: ['package.json:scripts.dev', 'package.json:scripts.start'] }),
    }));
    expect(result.ok === false && result.reason).toBe('ambiguous-command-source');
    expect(result.ok === false && result.candidates).toEqual(['package.json:scripts.dev', 'package.json:scripts.start']);
  });

  it('선언이 잘못되면 invalid-launch-declaration 이고 no-launch-declaration 과 다른 값이다', async () => {
    const result = await launchGoalArtifact('goal.md', baseDeps({
      readGoal: async () => '# goal\n\n## 산출물을 어떻게 켜나\nEnvironment: TOKEN=abc\nPort: 39001\n',
    }));
    expect(result.ok === false && result.reason).toBe('invalid-launch-declaration');
  });
});

describe('launchGoalArtifact — 「못 쟀다」를 「없다」로 접지 않는다', () => {
  it('해석기가 사유를 «안 주면» unknown-command-resolution 이다 — no-command-source 로 단정하지 않는다', async () => {
    let spawned = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      resolveCommand: async () => ({}),                 // command 도 reason 도 없다
      spawn: () => { spawned += 1; return asChild(new FakeChild()); },
    }));
    expect(result.ok === false && result.reason).toBe('unknown-command-resolution');
    expect(spawned).toBe(0);
  });

  it('사유가 «빈 문자열»이어도 no-command-source 로 단정하지 않는다', async () => {
    const result = await launchGoalArtifact('goal.md', baseDeps({ resolveCommand: async () => ({ reason: '' }) }));
    expect(result.ok === false && result.reason).toBe('unknown-command-resolution');
  });

  it('사유가 «모르는 값»이어도 no-command-source 로 단정하지 않는다', async () => {
    const result = await launchGoalArtifact('goal.md', baseDeps({ resolveCommand: async () => ({ reason: 'weather-was-bad' }) }));
    expect(result.ok === false && result.reason).toBe('unknown-command-resolution');
    expect(result.ok === false && result.detail).toContain('weather-was-bad');
  });

  it('사유가 «아는 값»이면 그대로 no-command-source 다', async () => {
    const result = await launchGoalArtifact('goal.md', baseDeps({ resolveCommand: async () => ({ reason: 'no-command-source' }) }));
    expect(result.ok === false && result.reason).toBe('no-command-source');
  });

  it('해석기가 throw 하면 unknown-command-resolution 이고 자식을 띄우지 않는다', async () => {
    let spawned = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      resolveCommand: async () => { throw new Error('resolver exploded'); },
      spawn: () => { spawned += 1; return asChild(new FakeChild()); },
    }));
    expect(result.ok === false && result.reason).toBe('unknown-command-resolution');
    expect(result.ok === false && result.detail).toContain('resolver exploded');
    expect(spawned).toBe(0);
  });

  it('선검사 프로브가 throw 하면 켜지 않는다 — 귀속을 확인 못 했으므로 비었다고 가정하지 않는다', async () => {
    let spawned = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      probePort: async () => { throw new Error('probe refused'); },
      spawn: () => { spawned += 1; return asChild(new FakeChild()); },
    }));
    expect(result.ok).toBe(false);
    expect(spawned).toBe(0);
  });
});

describe('launchGoalArtifact — 실행 맥락(경로는 인자로만)', () => {
  it('상대 골 경로를 repositoryRoot 기준으로 해석해 읽는다 — process.cwd() 를 쓰지 않는다', async () => {
    const seen: string[] = [];
    await launchGoalArtifact('docs/goals/x.md', baseDeps({
      repositoryRoot: '/repo',
      readGoal: async (path: string) => { seen.push(path); return GOAL_NO_DECLARATION; },
    }));
    expect(seen).toEqual(['/repo/docs/goals/x.md']);
  });

  it('절대 경로는 그대로 쓴다', async () => {
    const seen: string[] = [];
    await launchGoalArtifact('/elsewhere/goal.md', baseDeps({
      repositoryRoot: '/repo',
      readGoal: async (path: string) => { seen.push(path); return GOAL_NO_DECLARATION; },
    }));
    expect(seen).toEqual(['/elsewhere/goal.md']);
  });
});

describe('launchGoalArtifact — 포트 «귀속»(7차)', () => {
  const readyDeps = (extra: Partial<Parameters<typeof launchGoalArtifact>[1]>) => {
    const child = new FakeChild();
    let probes = 0;
    return baseDeps({
      spawn: () => asChild(child),
      probePort: async () => { probes += 1; return probes > 1; },
      ...extra,
    });
  };

  it('소유 PID 를 «물을 수 없으면» unverified 로 남긴다 — 확인됨으로 접지 않는다', async () => {
    const result = await launchGoalArtifact('goal.md', readyDeps({}));
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.handle.attribution).toBe('unverified');
  });

  it('소유 PID 가 우리 자식이면 confirmed 다', async () => {
    const child = new FakeChild(7777);
    let probes = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => { probes += 1; return probes > 1; },
      portOwnerPid: () => 7777,
    }));
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.handle.attribution).toBe('confirmed');
  });

  it('⭐ 소유 PID 가 «남의 것»이면 성공으로 내지 않고 자식을 끈다 — TOCTOU 경쟁', async () => {
    const child = new FakeChild(7777);
    let probes = 0;
    const groupSignals: NodeJS.Signals[] = [];
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => { probes += 1; return probes > 1; },
      portOwnerPid: () => 9999,                       // ⛔ preflight 뒤 제3자가 잡았다
      groupAlive: () => false,
      killGroup: (_pid, signal) => { groupSignals.push(signal); return true; },
    }));
    expect(result.ok === false && result.reason).toBe('port-not-owned');
    expect(result.ok === false && result.detail).toContain('9999');
    expect(groupSignals).toContain('SIGTERM');        // 자식이 «남지 않았다»
  });

  it('⭐ 소유 PID 가 다르지만 우리 그룹이 «살아 있으면» unverified 다 — 손자를 남의 것으로 단정하지 않는다', async () => {
    const child = new FakeChild(7777);
    let probes = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => { probes += 1; return probes > 1; },
      portOwnerPid: () => 8888,                       // 셸이 띄운 «손자»가 포트를 쥘 수 있다
      groupAlive: () => true,
    }));
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.handle.attribution).toBe('unverified');
  });

  it('소유 PID 가 다르고 그룹 생존을 «못 쟀으면» unverified 다', async () => {
    const child = new FakeChild(7777);
    let probes = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => { probes += 1; return probes > 1; },
      portOwnerPid: () => 8888,
      groupAlive: () => undefined,
    }));
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.handle.attribution).toBe('unverified');
  });

  it('귀속 확인 중 groupAlive 가 throw 해도 예외가 밖으로 안 나오고 unverified 로 남는다', async () => {
    const child = new FakeChild(7777);
    let probes = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => { probes += 1; return probes > 1; },
      portOwnerPid: () => 8888,
      groupAlive: () => { throw new Error('kill refused'); },
    }));
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.handle.attribution).toBe('unverified');
  });

  it('소유 PID 조회가 throw 하면 unverified 다 — 남의 것으로도 우리 것으로도 단정하지 않는다', async () => {
    const child = new FakeChild(7777);
    let probes = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => { probes += 1; return probes > 1; },
      portOwnerPid: () => { throw new Error('lsof missing'); },
    }));
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.handle.attribution).toBe('unverified');
  });
});

describe('launchGoalArtifact — 「못 쟀다」를 사실로 단정하지 않는다(6차)', () => {
  it('골 문서를 못 읽으면 goal-read-failed 다 — no-launch-declaration 과 다른 값', async () => {
    const result = await launchGoalArtifact('goal.md', baseDeps({
      readGoal: async () => { throw new Error('EACCES'); },
    }));
    expect(result.ok === false && result.reason).toBe('goal-read-failed');
  });

  it('선검사 프로브가 throw 하면 port-state-unknown 이다 — 점유로 단정하지 않는다', async () => {
    const result = await launchGoalArtifact('goal.md', baseDeps({
      probePort: async () => { throw new Error('probe refused'); },
    }));
    expect(result.ok === false && result.reason).toBe('port-state-unknown');
  });

  it('포트가 실제로 응답하면 port-already-in-use 다 — 확인된 사실만 그 값으로', async () => {
    const result = await launchGoalArtifact('goal.md', baseDeps({ probePort: async () => true }));
    expect(result.ok === false && result.reason).toBe('port-already-in-use');
  });
});

describe('launchGoalArtifact — 성공과 멱등 stop(①⑤)', () => {
  it('동시에 stop 을 두 번 불러도 «둘 다» 종료 완료 뒤에 끝난다', async () => {
    const child = new FakeChild();
    let probes = 0;
    let killDone = false;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => { probes += 1; return probes > 1; },
      groupAlive: () => false,
      killGroup: (_pid, signal) => {
        if (signal === 'SIGTERM') queueMicrotask(() => { killDone = true; child.emit('exit', 0, null); });
        return true;
      },
    }));
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    const [a, b] = [result.handle.stop(), result.handle.stop()];   // ⭐ 동시 호출
    await Promise.all([a, b]);
    expect(killDone).toBe(true);   // ⛔ 둘째가 종료 «전»에 resolve 되면 이 값이 false 일 수 있다
  });

  it('포트가 열리면 주소를 내주고 stop 이 그룹을 끈다', async () => {
    const child = new FakeChild();
    let probes = 0;
    const groupSignals: NodeJS.Signals[] = [];
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => { probes += 1; return probes > 2; },
      killGroup: (_pid, signal) => {
        groupSignals.push(signal);
        if (signal === 'SIGTERM') queueMicrotask(() => child.emit('exit', 0, null));
        return true;
      },
    }));
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.handle.url).toBe('http://127.0.0.1:39001');
    expect(groupSignals).toHaveLength(0);
    await result.handle.stop();
    expect(groupSignals).toContain('SIGTERM');
  });

  it('stop 은 멱등이다 — 두 번째 호출은 아무 신호도 더 보내지 않는다', async () => {
    const child = new FakeChild();
    let probes = 0;
    const groupSignals: NodeJS.Signals[] = [];
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => { probes += 1; return probes > 1; },
      killGroup: (_pid, signal) => {
        groupSignals.push(signal);
        if (signal === 'SIGTERM') queueMicrotask(() => child.emit('exit', 0, null));
        return true;
      },
    }));
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    await result.handle.stop();
    const afterFirst = groupSignals.length;
    await result.handle.stop();
    await result.handle.stop();
    expect(groupSignals).toHaveLength(afterFirst);
  });

  it('pid 가 없어도 자식 폴백으로 «반드시» 끈다 — 그룹만 건너뛴다', async () => {
    const child = new FakeChild();
    child.pid = undefined;   // ⛔ 생성자 기본값이 undefined 를 «삼키므로» 뒤에서 지운다
    let probes = 0;
    let groupCalls = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => { probes += 1; return probes > 1; },
      killGroup: () => { groupCalls += 1; return true; },
    }));
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    await result.handle.stop();
    expect(groupCalls).toBe(0);                        // 그룹에는 못 보낸다(pid 를 모른다)
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL']); // ⛔ 그러나 «아무것도 안 함»은 고아 경로다
  });

  it('stop 은 주입된 sleep 에 의존하지 않는다 — sleep 이 throw 해도 강제 종료까지 간다', async () => {
    const child = new FakeChild();
    let probes = 0;
    const groupSignals: NodeJS.Signals[] = [];
    const clock = fakeClock();
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => { probes += 1; return probes > 1; },
      now: clock.now,
      sleep: async (ms: number) => { if (probes > 1) throw new Error('sleep exploded'); await clock.sleep(ms); },
      groupAlive: () => true,
      killGroup: (_pid, signal) => { groupSignals.push(signal); return true; },
    }));
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    await result.handle.stop();                        // ⛔ throw 가 «밖으로» 나오면 안 된다
    expect(groupSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('준비 대기의 now() 가 throw 해도 자식을 끈다 — deadline 계산도 보호된다', async () => {
    const child = new FakeChild();
    const groupSignals: NodeJS.Signals[] = [];
    let nowCalls = 0;
    const result = await launchGoalArtifact('goal.md', baseDeps({
      spawn: () => asChild(child),
      probePort: async () => false,
      now: () => { nowCalls += 1; if (nowCalls === 1) throw new Error('clock exploded'); return 0; },
      killGroup: (_pid, signal) => {
        groupSignals.push(signal);
        if (signal === 'SIGTERM') queueMicrotask(() => child.emit('exit', 0, null));
        return true;
      },
    }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toContain('clock exploded');
    expect(groupSignals.length + child.killed.length).toBeGreaterThan(0);  // 자식이 «남지 않았다»
  });
});
