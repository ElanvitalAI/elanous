// WORKER-UNIFY (0.3.35) — 한 레지스트리: eln · shell · pod · mission 작업자를
// 한 목록(els 탭)으로 조회하고, 한 문으로 중지하고, 완료 사건을 한 형식으로 수신한다.
// 완료 경계 코드 = 내부 문서 `WORKER-UNIFY` §4-2(계약)·§4-7(탭)·§4-8(place).
//
// 최소 확장: 상태 어휘는 기존 통합 레지스트리(src/nexus/worker-registry/types.ts)와
// 같은 여섯 개를 그대로 쓴다 — 새 계층을 얹지 않는다. 각 장치(els 원장 · ShellRegistry ·
// Pod Job · agent-mission)는 이 앞면 뒤에서 자기 등록부를 그대로 지키며,
// 이 모듈은 조회(list)·중지(stop)·완료 수신(onCompletion)의 앞면 하나만 추가한다.

/** 장치 4종 — WORKER-UNIFY §1 지도의 이 호스트 작업자 곁가지. */
export const WORKER_SOURCE_KINDS = ['eln', 'shell', 'pod', 'mission'] as const;
export type WorkerSourceKind = (typeof WORKER_SOURCE_KINDS)[number];

/** §4-2 상태 여섯 — nexus worker-registry 어휘와 동일. */
export const WORKER_STATES = ['working', 'idle', 'needs-approval', 'done', 'failed', 'stalled'] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

/** 완료 사건 결과 — done(자연 완료) · failed(실패) · stopped(한 문 중지). */
export const WORKER_COMPLETION_OUTCOMES = ['done', 'failed', 'stopped'] as const;
export type WorkerCompletionOutcome = (typeof WORKER_COMPLETION_OUTCOMES)[number];

/** §4-8 물리 위치 — 논리 트리(워크스페이스/탭)와 섞지 않는다. */
export interface WorkerPlace {
  readonly runtime: 'process' | 'pod';
  readonly host?: string;
}

/** 등록 계약 — 장치별 어댑터(els 원장 · ShellRegistry · Pod Job · agent-mission)가 구현한다. */
export interface UnifiedWorker {
  readonly id: string;
  readonly kind: WorkerSourceKind;
  readonly title: string;
  readonly host: string | null;
  readonly place?: Readonly<WorkerPlace>;
  readonly state: WorkerState;
  /** 장치별 죽이기 앞면(els close · ShellKill · Job 주인 stop · terminateMissionProcessTree). */
  stop(reason?: string): void;
  /** 장치 완료 신호(§2-2 완료 경로 3) — 결과와 사유. */
  onCompletion(cb: (outcome: WorkerCompletionOutcome, reason: string | null) => void): { dispose(): void };
}

/** 완료 이벤트 한 형식 — 4종이 모두 이 꼴로 흘러나간다. */
export interface WorkerCompletionEvent {
  readonly workerId: string;
  readonly kind: WorkerSourceKind;
  readonly outcome: WorkerCompletionOutcome;
  readonly reason: string | null;
  readonly at: string;
}

/** 한 목록의 행 — els 탭이 그리는 대상. */
export interface WorkerListRow {
  readonly id: string;
  readonly kind: WorkerSourceKind;
  readonly title: string;
  readonly host: string | null;
  readonly place: Readonly<WorkerPlace> | null;
  readonly state: WorkerState;
}

export interface UnifiedWorkerRegistry {
  register(worker: UnifiedWorker): void;
  list(): readonly WorkerListRow[];
  /** 한 문 — 4종 모두 이 문 하나로 중지. 모르는 id 는 false(사건 없음). */
  stop(id: string, reason?: string): boolean;
  onCompletion(cb: (event: WorkerCompletionEvent) => void): { dispose(): void };
  size(): number;
  dispose(): void;
}

export interface UnifiedWorkerRegistryOpts {
  /** 주입 시계 — 시험 결정성. */
  now?: () => Date;
}

export function isWorkerSourceKind(value: string): value is WorkerSourceKind {
  return (WORKER_SOURCE_KINDS as readonly string[]).includes(value);
}

export function createUnifiedWorkerRegistry(opts: UnifiedWorkerRegistryOpts = {}): UnifiedWorkerRegistry {
  const now = opts.now ?? (() => new Date());
  const workers = new Map<string, UnifiedWorker>();
  const subs = new Set<(event: WorkerCompletionEvent) => void>();
  const emit = (worker: UnifiedWorker, outcome: WorkerCompletionOutcome, reason: string | null): void => {
    const event: WorkerCompletionEvent = { workerId: worker.id, kind: worker.kind, outcome, reason, at: now().toISOString() };
    for (const cb of subs) {
      try { cb(event); } catch { /* 한 구독자가 사건 흐름을 끊지 않는다 */ }
    }
  };
  return {
    register(worker) {
      if (!worker || typeof worker.id !== 'string' || !worker.id) throw new Error('worker id is required');
      if (!isWorkerSourceKind(worker.kind)) throw new Error(`worker kind must be one of ${WORKER_SOURCE_KINDS.join('|')}`);
      if (workers.has(worker.id)) throw new Error(`worker ${worker.id} is already registered`);
      workers.set(worker.id, worker);
      // 장치의 완료 신호를 한 형식으로 정규화해 붙인다(§6-5 COMPLETION-EVENT-ONE).
      worker.onCompletion((outcome, reason) => emit(worker, outcome, reason));
    },
    list() {
      const rows: WorkerListRow[] = [];
      for (const worker of workers.values()) {
        rows.push({ id: worker.id, kind: worker.kind, title: worker.title, host: worker.host, place: worker.place ?? null, state: worker.state });
      }
      return rows;
    },
    stop(id, reason) {
      const worker = workers.get(id);
      if (!worker) return false;
      worker.stop(reason);
      emit(worker, 'stopped', reason ?? null);
      return true;
    },
    onCompletion(cb) {
      subs.add(cb);
      return { dispose: () => { subs.delete(cb); } };
    },
    size() { return workers.size; },
    dispose() { workers.clear(); subs.clear(); },
  };
}
