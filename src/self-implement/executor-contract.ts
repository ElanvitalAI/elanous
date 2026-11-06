// ── executor 통일 계약 (G9 P3a · 2026-07-25) ──────────────────────────────────
//
// canonical = [[DESIGN-executor-pty-ref-contract-2026-07-25]] §3 (양 세션 §8 6항 합의 완료).
// 목적: PTY-spawn executor(backend = elanous-chat/codex/claude/gemini/grok/aside/openclaw/hermes 한 가족)가 pty 산출 순간
//   **식별자만 표면화**하면 K(run-identity join)·G5(제어루프 관측)가 **별도 bolt-on 없이** 그 seam 을 소비.
// 원칙: 전부 기존 값의 co-location — 신규 개념 없음. 이 모듈은 순수(타입+상수+순수 헬퍼).

import type { AgentBackend } from '../agent-mission/driver.js';

/**
 * PTY-spawn executor backend SSOT (계약 §8 Q5). `AgentBackend`(외부 에이전틱
 * CLI) superset 에 `elanous-chat`(elanous 자체 goal-loop 을 PTY 로 spawn)만 얹는다. `ExecutorPtyRef.backend`
 * 를 이 타입으로 못박아 문자열 drift 를 차단한다.
 */
export const EXECUTOR_BACKENDS = ['elanous-chat', 'codex', 'claude', 'gemini', 'grok', 'aside', 'openclaw', 'hermes'] as const;
export type ExecutorBackend = typeof EXECUTOR_BACKENDS[number];

// 컴파일 drift 가드(Q5·실 drift 방지의 SSOT) — `ExecutorBackend` 는 `EXECUTOR_BACKENDS` 배열에서 파생하므로
// backend 추가의 유일 경로는 그 배열 편집(임의 추가 불가). 이 가드는 그 배열이 **AgentBackend 의 모든 name 을
// 계속 포함**함을 타입 레벨로 강제 — AgentBackend 에 새 CLI(예: 'cursor')가 추가됐는데 배열에 안 넣으면
// `_AgentBackendsAreExecutorBackends` 가 never 로 붕괴해 컴파일 실패한다. (역방향은 배열=SSOT 라 불필요.)
type _AgentBackendsAreExecutorBackends = AgentBackend['name'] extends ExecutorBackend ? true : never;
const _driftGuard: _AgentBackendsAreExecutorBackends = true;
void _driftGuard;

/** surfaceId 브랜드 타입(Q1) — `exec:` 접두 강제. execSurfaceId() 만 생성할 수 있어 계약 위반을 컴파일 차단. */
export type ExecSurfaceId = `exec:${string}`;

/**
 * PTY-spawn executor 가 pty 산출 순간 표면화하는 식별자 묶음. K(join 스탬프)·G5(제어루프 부착)·관측
 * (frame 구독)이 이 하나의 seam 을 소비한다. in-process `runGoalLoop`(PTY 없음·fabric 코어)은 ptyId 가
 * 없으니 이 계약 대상 밖(runId-only join).
 */
export interface ExecutorPtyRef {
  /** = PtyHandle.id (pty-shell/registry.ts) — ★JOIN ANCHOR(K 스탬프·G5 부착의 키). */
  ptyId: string;
  /** = SelfReportFrame.surfaceId (= "frameSource") · Q1 규약 `exec:${ptyId}`. 템플릿 리터럴 타입으로
   *  불변식을 **타입 강제** — 직접 대입 시 execSurfaceId() 산출만 허용(임의 문자열 컴파일 거부). */
  surfaceId: ExecSurfaceId;
  /** 어떤 에이전틱 CLI 를 PTY 로 몰았나(런치 설정). */
  backend: ExecutorBackend;
  /** env(ELANOUS_RUN_ID) 존재 시 그 값·부재 시 최외곽만 mint(Q3). */
  runId: string;
  /** ELANOUS_HARNESS_SPACE_ID (harness-space.ts SSOT). */
  spaceId?: string;
  /** ELANOUS_SESSION_ID (이질적 생성기·부분 채움) — 부재 시 필드 생략(undefined). env 소스라 null 아님. */
  sessionId?: string;
  /** resolveInstanceName() — coarse fleet 키(per-run 아님). */
  instance?: string;
}

/**
 * surfaceId 규약 (계약 §8 Q1) — frame↔pty 를 룩업 없이 **순수 문자열 파생**으로 결정적 상관.
 * ptyId 가 이미 `<kind>_<hex>` 라 `exec:codex_a1b2c3d4` 는 backend kind 도 눈에 보인다.
 */
export function execSurfaceId(ptyId: string): ExecSurfaceId {
  return `exec:${ptyId}`;
}

/**
 * ExecutorPtyRef 생성 seam (production) — `surfaceId = exec:${ptyId}` 불변식을 보장하고 선택 필드를
 * 부재 시 생략(부분 채움 계약). executor(elanous-chat headless-driver·agent CLI driver)가 pty 산출 직후
 * 이걸로 ref 를 만들어 K(pty_manifest 스탬프)·G5(제어루프 부착)에 넘긴다. `runId` 는 호출측이 env
 * (ELANOUS_RUN_ID·K2 채널) 또는 최외곽 mint 로 결정해 전달한다(Q3·이중출처 방지). 순수(부작용 0).
 */
export function buildExecutorPtyRef(input: {
  ptyId: string;
  backend: ExecutorBackend;
  runId: string;
  spaceId?: string;
  sessionId?: string;
  instance?: string;
}): ExecutorPtyRef {
  return {
    ptyId: input.ptyId,
    surfaceId: execSurfaceId(input.ptyId),
    backend: input.backend,
    runId: input.runId,
    ...(input.spaceId !== undefined ? { spaceId: input.spaceId } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.instance !== undefined ? { instance: input.instance } : {}),
  };
}
