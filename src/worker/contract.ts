// WORKER-CONTRACT v1 — 작업자 생명주기 규약의 타입 정의. 문서 내부 문서 `WORKER-CONTRACT` 와 한 쌍:
// 문서의 모든 리터럴(상태 · kind · 바인딩 · 우선순위)은 이 파일의 상수와 같아야 한다(contract.test.ts 가 검사).
// Neutral module: els · eln-core 를 import 하지 않는다(#38499 src/agent-events/protocol.ts 와 같은 규칙) — 양쪽 다 import 할 수 있다.
// 이 단계는 문서 · 타입 · 상수만 — 동작 배선 0 · 옵션 0(OP 지시 WORKER-MIGRATION-PHASE1-1119 · 1단계 WORKER-CONTRACT-SPEC 칸).

export const WORKER_CONTRACT_VERSION = 1 as const; // 출처: WORKER-MIGRATION-PHASE1-1119 — 규약 v1, 에이전트 사건 프로토콜 v1(#38499) 위 확장

// --- §2 생명주기 상태 여섯 ---
export type WorkerState = 'working' | 'idle' | 'needs-approval' | 'done' | 'failed' | 'stalled';
export const WORKER_STATES: readonly WorkerState[] = ['working', 'idle', 'needs-approval', 'done', 'failed', 'stalled'];
/** 종결 상태 — 여기서 나가는 전이는 없다(§2 표). */
export const WORKER_TERMINAL_STATES: readonly WorkerState[] = ['done', 'failed'];
export const isWorkerState = (value: unknown): value is WorkerState =>
  typeof value === 'string' && (WORKER_STATES as readonly string[]).includes(value);

// --- §5 단위 kind · 격리 — 명세 한 꼴 ---
export type WorkerKind = 'shell' | 'inline-agent' | 'pane-agent' | 'cli' | 'auto';
export const WORKER_KINDS: readonly WorkerKind[] = ['shell', 'inline-agent', 'pane-agent', 'cli', 'auto'];
export type WorkerIsolation = 'inline-isolated' | 'isolated-session' | 'session';
export const WORKER_ISOLATIONS: readonly WorkerIsolation[] = ['inline-isolated', 'isolated-session', 'session'];

// --- §1 정체성 — pane id = eventId 사슬 ---
export interface WorkerIdentity {
  /** els pane id — 탭 하나가 작업자 하나. */
  readonly paneId: string;
  /** 사슬의 뿌리 = spawn 사건. */
  readonly rootEventId: string;
  /** 바로 앞 사건(같은 사슬 잇기 · #38845). */
  readonly parentEventId?: string;
}

// --- §5 예산 · 임대 ---
export interface WorkerBudget {
  /** 턴 상한 — 소진 시 failed(사유: 예산). */
  readonly turns?: number;
  /** 벽시계 상한(ms). */
  readonly wallClockMs?: number;
  /** 크레딧 상한. */
  readonly credit?: number;
}
export interface WorkerCredsLease {
  /** 임대(lease) 이름 — 평문 비밀 금지(§8 감사 줄 가림). */
  readonly lease: string;
}

// --- §5 명세 한 꼴 — kind 만 바꾸면 같은 일이 다른 단위로 돈다 ---
// goal ⊕ command 는 정확히 하나(배타 합집합), budget 은 필수(§5) — 출처: terra-38916 mustFix[0].
interface WorkerSpawnCommon {
  readonly kind: WorkerKind;
  /** 어느 기계. */
  readonly host?: string;
  readonly budget: WorkerBudget;
  readonly creds?: WorkerCredsLease;
  readonly isolation: WorkerIsolation;
  /** 지켜보는 경로(변경 보고). */
  readonly watch?: readonly string[];
  /** 부모 작업자(§6 중첩 — 탭 트리 = 부모/자식). */
  readonly parent?: WorkerIdentity;
}
export type WorkerSpawnSpec =
  | (WorkerSpawnCommon & { readonly goal: string; readonly command?: undefined })
  | (WorkerSpawnCommon & { readonly command: string; readonly goal?: undefined });

// --- §3 사건 — 계승(turn·meta·notice·child·release = src/agent-events/protocol.ts AgentEvent) + 넷 추가 ---
// 계승 종류는 AgentEvent 에서 kind 로 걸러 그대로 포함한다(state 는 §2 여섯 상태로 다시 정의 — 계승 제외) — 출처: terra-38916 mustFix[1].
import type { AgentEvent } from '../agent-events/protocol';
type InheritedWorkerEvent = Extract<AgentEvent, { readonly kind: 'turn' | 'meta' | 'notice' | 'child' | 'release' }>;
export type OutputStreamName = 'stdout' | 'stderr';
export type ToolPhase = 'start' | 'end';
export interface WorkerArtifact {
  readonly path: string;
  readonly sha256: string;
}
export type WorkerOwnEvent =
  | { readonly kind: 'state'; readonly state: WorkerState; readonly message?: string }
  | { readonly kind: 'output'; readonly stream: OutputStreamName; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string; readonly phase: ToolPhase; readonly ok?: boolean; readonly summary?: string }
  | { readonly kind: 'result'; readonly ok: boolean; readonly summary?: string; readonly artifacts?: readonly WorkerArtifact[] };
export type WorkerEvent = InheritedWorkerEvent | WorkerOwnEvent;

// --- §4 조작 프레임 — 같은 소켓 · 프레임 한 줄 · 응답 한 줄(#38499 와이어 규칙) ---
interface WorkerControlBase {
  readonly v: typeof WORKER_CONTRACT_VERSION;
  /** 요청 id — 응답 한 줄이 이 id 로 답한다. */
  readonly id: string;
  readonly at: number;
}
export type WorkerControl =
  | (WorkerControlBase & { readonly op: 'spawn'; readonly spec: WorkerSpawnSpec })
  | (WorkerControlBase & { readonly op: 'steer'; readonly to: string; readonly input: string })
  | (WorkerControlBase & { readonly op: 'collect'; readonly to: string; readonly sinceSeq?: number })
  | (WorkerControlBase & { readonly op: 'stop'; readonly to: string; readonly reason: string });

// --- §7 메시지 봉투 — 봉투 하나 · 의미 하나 · 전송은 바인딩(§8) ---
export type EnvelopeKind = 'request' | 'reply' | 'notice' | 'event' | 'control';
export const ENVELOPE_KINDS: readonly EnvelopeKind[] = ['request', 'reply', 'notice', 'event', 'control'];
export type EnvelopePriority = 'urgent' | 'high' | 'normal';
export const ENVELOPE_PRIORITIES: readonly EnvelopePriority[] = ['urgent', 'high', 'normal'];
export interface EnvelopeAttachment {
  readonly path: string;
  readonly sha256: string;
}
export interface MessageEnvelope {
  readonly id: string;
  /** 인증된 주체 — 바인딩마다 같은 인가(§8). */
  readonly from: string;
  /** 작업자 | 무리 | 자리(방송 = 무리). */
  readonly to: string;
  readonly kind: EnvelopeKind;
  readonly priority: EnvelopePriority;
  /** 요청-답 잇기. */
  readonly correlationId?: string;
  readonly ttlMs?: number;
  readonly expiresAt?: number;
  /** 반복 억제(#16). */
  readonly dedupeKey?: string;
  readonly body: string;
  readonly attachments?: readonly EnvelopeAttachment[];
}

// --- §8 바인딩 — 같은 봉투를 실어 나름 ---
export type BindingKind = 'msg-store' | 'els-control-door' | 'acp' | 'mcp' | 'cli' | 'http' | 'pty';
export const BINDING_KINDS: readonly BindingKind[] = ['msg-store', 'els-control-door', 'acp', 'mcp', 'cli', 'http', 'pty'];
/** 작업자 능력 선언 — 받는 바인딩 목록. 보내는 쪽이 이 보고를 보고 바인딩을 자동 선택한다(§8). */
export interface WorkerCapability {
  readonly receives: readonly BindingKind[];
}
