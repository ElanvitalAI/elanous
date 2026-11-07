import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 갈림 ① ㉢ — 자식이 「살아 있다」를 자기 일과 무관하게 정해진 파일 하나에 덮어쓴다.
 *
 * ㉠ 화면 짧은 표시는 부모가 이미 화면을 읽으니 부모를 거의 안 고치지만, 그 표시가
 *    사람이 보는 화면·기록·완료 마커/stall 분류에 섞여 이 결함(무출력=죽음)을 고치는
 *    대가로 관측을 오염시킨다.
 * ㉡ 관측 저장소만 남기면 화면은 깨끗하지만, 이 저장소의 그 조회는 한 번에 약 0.7초이고
 *    tick 간격은 그보다 짧다 — 매 tick 폴링이 루프를 잡아먹으므로 불변식이 금지한다.
 * ㉢ 작업공간의 정해진 파일은 writeHarnessHeartbeat 와 같은 값싼 동기 덮어쓰기 선례가
 *    이미 있고, 파일이 없으면 ENOENT 한 번이라 말을 안 내는 옛 자식은 지금과 같은 경로다.
 *
 * 이 헬퍼는 관측 저장소를 열지 않고 화면에도 쓰지 않는다. 스케줄은 unref 라 자식의
 * 모델/도구 await 를 막거나 프로세스 종료를 붙잡지 않는다.
 *
 * 갈림 ② ㉠ — 화면 delta 와 같은 등급으로 합친다. 더 최근인 쪽이 lastActivityI 가 된다.
 * ㉠ vs ㉡: 현재 컷은 「둘 다 오래됐을 때만」이다. lastActivity = max(screen, heartbeat) 가
 * 오래됨 ⇔ 화면이 오래되고 heartbeat 도 오래됨. 같은 유예·같은 컷이면 두 갈래는 같은 동작을 낳는다.
 * 축을 둘로 쪼개면 유예가 갈릴 때만 달라지는데, 이 착지는 유예 기본값을 안 바꾸므로 ㉠ 으로
 * 기존 silentFor 경로를 재사용한다. 파일이 없거나 at 이 안 전진하면 갱신하지 않는다 — 말을
 * 안 내는 자식·쓰기를 멈춘 파일은 옛 타임아웃 tick 그대로다.
 */
export const CHILD_LIVENESS_HEARTBEAT_ENV = 'ELANOUS_CHILD_LIVENESS_HEARTBEAT';
export const CHILD_LIVENESS_HEARTBEAT_FILE = '.elanous-child-liveness.hb';
export const DEFAULT_CHILD_LIVENESS_HEARTBEAT_MS = 5_000;

export function resolveChildLivenessHeartbeatPath(cwd: string): string {
  return join(cwd, CHILD_LIVENESS_HEARTBEAT_FILE);
}

/** Cheap workspace-file read. Missing/unreadable/non-numeric `at` = no heartbeat (legacy path). */
export function readChildLivenessHeartbeatAt(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown };
    return typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Same-grade merge freshness: only a strictly newer `at` counts as activity.
 * Equal/older/missing values leave lastSeenAt unchanged so a stopped file cannot
 * keep extending the parent the way a live periodic writer does.
 */
export function mergeChildLivenessHeartbeat(
  lastSeenAt: number | undefined,
  heartbeatAt: number | undefined,
): { lastSeenAt: number; refresh: true } | { lastSeenAt: number | undefined; refresh: false } {
  if (heartbeatAt === undefined) return { lastSeenAt, refresh: false };
  if (lastSeenAt === undefined || heartbeatAt > lastSeenAt) {
    return { lastSeenAt: heartbeatAt, refresh: true };
  }
  return { lastSeenAt, refresh: false };
}

export function startChildLivenessHeartbeat(opts: {
  path?: string;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  nowMs?: () => number;
  setIntervalImpl?: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  clearIntervalImpl?: (timer: NodeJS.Timeout) => void;
} = {}): () => void {
  const path = (opts.path ?? opts.env?.[CHILD_LIVENESS_HEARTBEAT_ENV] ?? process.env[CHILD_LIVENESS_HEARTBEAT_ENV])?.trim();
  if (!path) return () => {};
  const intervalMs = opts.intervalMs ?? DEFAULT_CHILD_LIVENESS_HEARTBEAT_MS;
  const nowMs = opts.nowMs ?? Date.now;
  let stopped = false;
  const write = (): void => {
    if (stopped) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ at: nowMs() }), 'utf8');
    } catch { /* fail-soft — liveness must not slow or break the child's work */ }
  };
  write();
  const timer = (opts.setIntervalImpl ?? setInterval)(write, intervalMs) as NodeJS.Timeout;
  timer.unref();
  return () => {
    stopped = true;
    (opts.clearIntervalImpl ?? clearInterval)(timer);
  };
}
