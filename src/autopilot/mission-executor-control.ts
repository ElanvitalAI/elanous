// ── 미션 프로세스 제어 (대표 2026-07-16 — cancel이 executor를 안 죽인 사고 수복) ──
//
// 사고1(2026-07-16): autopilot cancel 이 태스크·크론·미션행은 정리했으나 run-mission executor OS
// 프로세스는 안 죽여, 취소된 미션이 계속 빌드하며 PR 을 만드는 좀비 빌드 발생. stopBuild(se-build-tool)이
// 이미 갖던 pgrep→그룹 SIGTERM 로직을 여기로 추출해 cancelMission·stopBuild 가 공유한다.
// 사고2(2026-07-18): 미션 트리거 직후 /cancel 하면 미션행은 정리됐으나 진행 중 se-mission-prepare(분해)
// 프로세스가 계속 돎(좀비 분해). run-mission 패턴만 잡던 걸 se-mission-prepare 도 포함하게 확장. 두 프로세스
// 모두 커맨드라인에 missionId 를 담으므로 registry 없이 pgrep 로 잡힌다.

import { spawnSync } from 'node:child_process';
import { terminateTree } from '../shell-primitive/terminate-tree.js';

/** pgrep -f 패턴(순수·테스트 가능) — run-mission(빌드)·se-mission-prepare(분해) 둘 다 매칭.
 *  두 프로세스 모두 cmdline 에 missionId 를 담으므로 registry 없이 잡힌다. */
export function executorProcessPattern(missionId: string): string {
  return `(run-mission|se-mission-prepare).*${missionId}`;
}

/** 미션 프로세스 검색 seam(테스트 주입). run-mission(빌드) + se-mission-prepare(분해) 둘 다. */
export function defaultFindExecutorPids(missionId: string): number[] {
  try {
    const r = spawnSync('pgrep', ['-f', executorProcessPattern(missionId)], { encoding: 'utf-8', timeout: 5000 });
    return (r.stdout ?? '').split('\n').map((l) => Number(l.trim())).filter((p) => Number.isInteger(p) && p > 1);
  } catch { return []; }
}

/** 프로세스 그룹 SIGTERM seam(테스트 주입). run-mission·se-mission-prepare 둘 다 detached 그룹리더라
 *  -pid 로 자식(sol/terra LLM 호출 등)까지 종료. */
function defaultKillGroup(pid: number): void {
  void terminateTree({ pid }, { group: true, pidFallback: true });
}

/**
 * 미션의 진행 중 프로세스(run-mission 빌드 + se-mission-prepare 분해)를 종료한다. 반환=종료한 pid 목록.
 * fail-soft. 자기 자신(process.pid)은 건너뛴다(자기 종료 방지). seam 주입으로 테스트 가능.
 */
export function stopMissionExecutor(
  missionId: string,
  deps: { findPids?: (id: string) => number[]; killGroup?: (pid: number) => void } = {},
): number[] {
  const findPids = deps.findPids ?? defaultFindExecutorPids;
  const killGroup = deps.killGroup ?? defaultKillGroup;
  const killed: number[] = [];
  for (const pid of findPids(missionId)) {
    if (pid === process.pid) continue;
    killGroup(pid);
    killed.push(pid);
  }
  return killed;
}
