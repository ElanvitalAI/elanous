import { describe, expect, test } from 'bun:test';
import type {
  MessageEnvelope,
  WorkerCapability,
  WorkerControl,
  WorkerEvent,
  WorkerSpawnSpec,
} from './contract';
import {
  BINDING_KINDS,
  ENVELOPE_KINDS,
  ENVELOPE_PRIORITIES,
  WORKER_CONTRACT_VERSION,
  WORKER_ISOLATIONS,
  WORKER_KINDS,
  WORKER_STATES,
  WORKER_TERMINAL_STATES,
  isWorkerState,
} from './contract';

// --- 타입 시험(컴파일 단계) — 출처: terra-38916 mustFix[2]·[3] ---
// 아래 단언들은 tsc 게이트(ci-typecheck-changed · pregate changed-tsc)에서만 빨강/초록이 판정된다:
// bun test 는 타입을 지우므로 런타임 시험과 분리된 이유. 공개 타입 4종(WorkerEvent·WorkerControl·
// MessageEnvelope·WorkerCapability)을 여기서 소비·검증해 미사용 export 를 없앤다(mustFix[3]).
type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// §5 — goal ⊕ command 배타 합집합 · budget 필수(mustFix[0]).
type SpecGoal = Extract<WorkerSpawnSpec, { readonly goal: string }>;
type SpecCommand = Extract<WorkerSpawnSpec, { readonly command: string }>;
type _SpecGoalHasNoCommand = Assert<Equals<SpecGoal['command'], undefined>>;
type _SpecCommandHasNoGoal = Assert<Equals<SpecCommand['goal'], undefined>>;
type _SpecBudgetRequired = Assert<Equals<SpecGoal['budget'] extends { readonly turns?: number } ? true : never, true>>;

// §3 — 계승 종류(turn·meta·notice·child·release)가 WorkerEvent 로 표현된다(mustFix[1]).
type _InheritsTurn = Assert<Extract<WorkerEvent, { readonly kind: 'turn' }> extends { readonly phase: 'start' | 'end' } ? true : false>;
type _InheritsRelease = Assert<Extract<WorkerEvent, { readonly kind: 'release' }> extends { readonly kind: 'release' } ? true : false>;

// §4 조작 프레임 — 네 op 가 그대로 열려 있다(mustFix[3] 소비).
type _ControlOps = Assert<Equals<WorkerControl['op'], 'spawn' | 'steer' | 'collect' | 'stop'>>;

// §7 봉투 — 필수 필드가 온전하다(mustFix[3] 소비).
type _EnvelopeShape = Assert<MessageEnvelope extends { readonly id: string; readonly from: string; readonly to: string; readonly kind: MessageEnvelope['kind']; readonly priority: MessageEnvelope['priority']; readonly body: string } ? true : false>;

// §8 능력 선언(mustFix[3] 소비).
type _CapabilityShape = Assert<WorkerCapability extends { readonly receives: readonly WorkerCapability['receives'][number][] } ? true : false>;

// 규약 문서(내부 문서 `WORKER-CONTRACT`)와 타입 상수가 어긋나면 빨강 — 시험 리터럴.
// 출처: WORKER-MIGRATION-PHASE1-1119 — 지시서 공통 요건(«시험 리터럴»).

describe('WORKER-CONTRACT v1 리터럴', () => {
  test('§2 상태 여섯 — 문서 표 그대로', () => {
    expect([...WORKER_STATES]).toEqual(['working', 'idle', 'needs-approval', 'done', 'failed', 'stalled']);
    expect([...WORKER_TERMINAL_STATES]).toEqual(['done', 'failed']);
    expect(isWorkerState('stalled')).toBe(true);
    // 에이전트 사건 v1 의 상태 이름은 이 규약에 없다(blocked 는 셋으로 세분화 · exited 는 관찰 계기 — §2).
    expect(isWorkerState('blocked')).toBe(false);
    expect(isWorkerState('exited')).toBe(false);
  });

  test('§5 kind 다섯 · isolation 셋', () => {
    expect([...WORKER_KINDS]).toEqual(['shell', 'inline-agent', 'pane-agent', 'cli', 'auto']);
    expect([...WORKER_ISOLATIONS]).toEqual(['inline-isolated', 'isolated-session', 'session']);
  });

  test('§7 봉투 kind 다섯 · 우선순위 셋(사람 입력 > urgent > high > normal)', () => {
    expect([...ENVELOPE_KINDS]).toEqual(['request', 'reply', 'notice', 'event', 'control']);
    expect([...ENVELOPE_PRIORITIES]).toEqual(['urgent', 'high', 'normal']);
  });

  test('§8 바인딩 일곱 — 같은 봉투를 실어 나름', () => {
    expect([...BINDING_KINDS]).toEqual(['msg-store', 'els-control-door', 'acp', 'mcp', 'cli', 'http', 'pty']);
  });

  test('규약 버전 v1', () => {
    expect(WORKER_CONTRACT_VERSION).toBe(1); // 출처: WORKER-MIGRATION-PHASE1-1119 — 규약 v1
  });
});
