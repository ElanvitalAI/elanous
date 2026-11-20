// NEXUS · worker registry 앞문 골격 — DRAFT, 정식 구현 아님 (OP #95243)
//
// REST + JSON-RPC 앞문(바인딩) 골격. 인가·감사·비밀 가림은 이 층 한곳에서:
//  - 인가: nexus 본부 control 문 신원(좌석 비밀 머리말) — drafts 는 인자만 규정.
//    r2 ④ 계약: 읽기 전면은 HQ control 신원만(hq-control). 쓰기 주체는
//    ⑧ heartbeat 는 '자기 호스트' 자리(name 결속)만, worker 등록·상태 변경은
//    그 worker 를 소유한 좌석(주입된 owner 신원)만 — 쓰기도 HQ control 신원 아래에서만.
//    [NEXUS-WORKER-REGISTRY-FU] 구현 경계: worker 등록·상태 변경 쓰기는 HQ control 신원
//    + 소유 좌석 신원(ownerIdentity === owner) 일치일 때만 허용(fail-closed).
//  - 감사: 모든 쓰기 앞문은 watch 사건으로 worker_watch 표에 남는다.
//  - 비밀 가림: 원장 행에는 비밀을 평문으로 넣지 않는다 — creds 는 참조만.
//
// SSE 골격: /v1/worker-watch — Last-Event-Id(seq) 재접속 replay + subscribe 배달.
// WS 는 후속 PR — 이 파일은 이중화 계약만 주석으로 명시.

import type { RegisterWorkerInput, UpsertHostInput, WorkerRegistryStore } from './store.js';
import type { WorkerState, WorkerWatchEvent } from './types.js';

/** 앞문 라우팅 규격 — nexus api 라우터에 얹을 때 쓰는 표. */
export interface WorkerRegistryRoutes {
  /** GET  /v1/workers — 목록(비밀 없음 — 원장에 평문 비밀 없음). */
  readonly listWorkers: '/v1/workers';
  /** POST /v1/workers — 등록(명세 한 꼴 body). */
  readonly registerWorker: '/v1/workers';
  /** GET  /v1/workers/:id */
  readonly getWorker: '/v1/workers/:id';
  /** POST /v1/workers/:id/desired-state — 원하는 상태. */
  readonly setDesiredState: '/v1/workers/:id/desired-state';
  /** GET  /v1/worker-hosts — 호스트 행 계약 표기. */
  readonly listHosts: '/v1/worker-hosts';
  /** POST /v1/worker-hosts — upsert(elsEndpoint tailnet/loopback 검증 포함). */
  readonly upsertHost: '/v1/worker-hosts';
  /** POST /v1/worker-hosts/:name/heartbeat */
  readonly heartbeatHost: '/v1/worker-hosts/:name/heartbeat';
  /** GET  /v1/worker-watch — SSE. Last-Event-Id = worker_watch.seq. */
  readonly watch: '/v1/worker-watch';
  /** r2 ③⑦ — GET /v1/worker-registry/snapshot — 완전 스냅샷 + revision 와이어. */
  readonly snapshot: '/v1/worker-registry/snapshot';
}

export const WORKER_REGISTRY_ROUTES: WorkerRegistryRoutes = {
  listWorkers: '/v1/workers',
  registerWorker: '/v1/workers',
  getWorker: '/v1/workers/:id',
  setDesiredState: '/v1/workers/:id/desired-state',
  listHosts: '/v1/worker-hosts',
  upsertHost: '/v1/worker-hosts',
  heartbeatHost: '/v1/worker-hosts/:name/heartbeat',
  watch: '/v1/worker-watch',
  snapshot: '/v1/worker-registry/snapshot',
};

/** JSON-RPC 앞문 — 같은 뒷면(store)을 RPC 로도 노출하는 메서드 이름. */
export const WORKER_REGISTRY_RPC_METHODS = [
  'nexus.workers.list',
  'nexus.workers.get',
  'nexus.workers.register',
  'nexus.workers.setDesiredState',
  'nexus.workerHosts.list',
  'nexus.workerHosts.upsert',
  'nexus.workerHosts.heartbeat',
  'nexus.workerRegistry.snapshot',
] as const;

// ----- r2 ④ — 읽기 인가 -----

/** 읽기 인가: nexus 본부 control 문 신원만. 좌석 신원 문자열 그대로 비교. */
export const HQ_CONTROL_READ_IDENTITIES = [
  'hq-control', // 본부 control 앞문 자체
] as const;

/** 읽기 인가 판정 — HQ control 신원만 true, 타 신원 전부 false(fail-closed). */
export function canReadWorkerRegistry(identity: string | null | undefined): boolean {
  return identity != null && (HQ_CONTROL_READ_IDENTITIES as readonly string[]).includes(identity);
}

/** 인가 실패 응답 껍데기 — 라우터가 그대로 되돌려 주는 값. */
export const WORKER_REGISTRY_FORBIDDEN = {
  status: 403,
  body: { error: 'forbidden', message: 'worker registry reads require an hq control identity' },
} as const;

/** [#39074 JUD ⓒ1] host 쓰기 인가 실패 응답 껍데기 — 인증된 host 신원/관리자가 아닐 때. */
export const WORKER_REGISTRY_HOST_FORBIDDEN = {
  status: 403,
  body: { error: 'forbidden', message: 'host writes require the authenticated host identity or an admin' },
} as const;

/** [NEXUS-WORKER-REGISTRY-FU] 쓰기 인가 실패 응답 껍데기 — 소유 좌석 신원이 없거나 어긋날 때. */
export const WORKER_REGISTRY_WRITE_FORBIDDEN = {
  status: 403,
  body: { error: 'forbidden', message: 'worker writes require the owning seat identity' },
} as const;

/** [NEXUS-WORKER-REGISTRY-FU] 쓰기 인가 판정 — HQ control 읽기 신원이고 주입된 소유 좌석
 *  신원(ownerIdentity)이 자원의 owner 와 정확히 일치할 때만 true. 어긋나면 전부 false(fail-closed). */
export function canWriteWorkerResource(
  identity: string | null | undefined,
  ownerIdentity: string | null | undefined,
  owner: string | null | undefined,
): boolean {
  return canReadWorkerRegistry(identity)
    && ownerIdentity != null
    && owner != null
    && ownerIdentity === owner;
}

// ----- r2 ⑦ — 스냅샷 핸들러·라우터 -----

/** 라우터가 되돌릴 수 있는 응답 껍데기(성공은 JSON 그대로). */
export interface WorkerRegistryResponse {
  readonly status: number;
  readonly body: unknown;
}

/** SSE 표면 응답 — 실제 스트림은 bindWorkerRegistryFront().sseFromLastEventId(Last-Event-Id) 가 만든다. */
export interface WorkerRegistrySseResponse extends WorkerRegistryResponse {
  readonly sse: true;
}

/** 라우팅 요청 — 방법·경로·앞문 신원(좌석 비밀 머리말에서 뽑은 값)·쓰기 본문. */
export interface WorkerRegistryRequest {
  readonly method: string;
  readonly path: string;
  readonly identity?: string | null;
  /** 쓰기 앞문의 소유 좌석 신원 — 좌석 비밀 머리말에서 주입. */
  readonly ownerIdentity?: string | null;
  /** [#39074 JUD ⓒ] 인증된 host 신원(name) — host 비밀 머리말에서 주입. 본문 값은 신뢰하지 않는다. */
  readonly hostIdentity?: string | null;
  /** [#39074 JUD ⓒ] 인증된 host principal — 인증 컨텍스트에서만 주입. 본문 principal 은 무시한다. */
  readonly hostPrincipal?: string | null;
  /** [#39074 JUD ⓒ] 관리자 인증 여부 — 인증 컨텍스트에서만 주입(본문 무시). */
  readonly admin?: boolean;
  /** 쓰기 앞문의 JSON 본문(정식 HTTP 서버가 파싱해 주입). */
  readonly body?: unknown;
}

/** snapshot 핸들러 — 인가(④) 통과 시에만 스냅샷 전체를 반환(비밀 없음). */
export function handleWorkerRegistrySnapshot(
  store: WorkerRegistryStore,
  identity: string | null | undefined,
): WorkerRegistryResponse {
  if (!canReadWorkerRegistry(identity)) return { ...WORKER_REGISTRY_FORBIDDEN };
  return { status: 200, body: store.snapshot() };
}

/** `:param` 자리를 채워 경로를 맞춘다 — 맞으면 자리 값, 아니면 null. */
function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const expected = patternParts[i]!;
    const actual = pathParts[i]!;
    if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return null;
  }
  return params;
}

/** r2 — store 수명 계약 오류를 앞문 상태로 옮긴다:
 *  상태 충돌(폐기·세대 재생·교차호스트 principal·미등록 호스트 주장) = 409,
 *  그 밖의 검증 오류(kind·role·binding·endpoint·TTL·state) = 400. */
const WORKER_REGISTRY_CONFLICT_PREFIXES = [
  'host revoked:',
  'stale host generation:',
  'host principal required:',
  'host principal mismatch:',
  'unknown host:',
] as const;

function storeErrorToResponse(error: unknown): WorkerRegistryResponse {
  const message = error instanceof Error ? error.message : String(error);
  const conflict = (WORKER_REGISTRY_CONFLICT_PREFIXES as readonly string[])
    .some((prefix) => message.startsWith(prefix));
  // 결속된 principal 원문이 응답에 새지 않게(셀프 리뷰 M2) — principal 불일치는 고정 문구만.
  if (message.startsWith('host principal mismatch:')) {
    return { status: 409, body: { error: 'conflict', message: 'host principal mismatch' } };
  }
  return conflict
    ? { status: 409, body: { error: 'conflict', message } }
    : { status: 400, body: { error: 'bad request', message } };
}

/** 쓰기 본문이 JSON 객체인지 확인 — 아니면 400 응답, 맞으면 객체로. */
function objectBody(body: unknown): Record<string, unknown> | null {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/** 최소 라우터 — 실제 HTTP 서버 배선은 정식 구현이 맡는다(CC-4 #38896 어댑터).
 *  r2 ④ 계약: 모든 앞문(읽기·쓰기)은 HQ control 신원 아래에서만 — 신원이 안 맞으면
 *  경로와 무관하게 403(fail-closed: 앞문 존재를 밝히지 않는다). 쓰기 중 store 수명
 *  계약 위반(폐기·재생·교차호스트)은 409, 검증 위반은 400, 없는 자원은 404. */
export function routeWorkerRegistry(
  store: WorkerRegistryStore,
  request: WorkerRegistryRequest,
): WorkerRegistryResponse | WorkerRegistrySseResponse {
  const { method, path } = request;
  if (!canReadWorkerRegistry(request.identity)) return { ...WORKER_REGISTRY_FORBIDDEN };

  if (method === 'GET' && path === WORKER_REGISTRY_ROUTES.listWorkers) {
    return { status: 200, body: store.listWorkers() };
  }
  if (method === 'GET' && path === WORKER_REGISTRY_ROUTES.listHosts) {
    return { status: 200, body: store.listHosts() };
  }
  if (method === 'GET' && path === WORKER_REGISTRY_ROUTES.snapshot) {
    return handleWorkerRegistrySnapshot(store, request.identity ?? null);
  }
  if (method === 'GET' && path === WORKER_REGISTRY_ROUTES.watch) {
    return { status: 200, body: null, sse: true };
  }
  const workerParams = matchRoute(WORKER_REGISTRY_ROUTES.getWorker, path);
  if (method === 'GET' && workerParams) {
    const worker = store.getWorker(workerParams.id!);
    return worker
      ? { status: 200, body: worker }
      : { status: 404, body: { error: 'not found', id: workerParams.id } };
  }
  if (method === 'POST' && path === WORKER_REGISTRY_ROUTES.registerWorker) {
    const body = objectBody(request.body);
    if (!body) return { status: 400, body: { error: 'bad request', message: 'JSON object body required' } };
    const owner = body['owner'];
    if (typeof owner !== 'string') {
      return { status: 400, body: { error: 'bad request', message: 'body.owner (seat identity) required' } };
    }
    // [NEXUS-WORKER-REGISTRY-FU] 등록 쓰기도 HQ control 신원 + 소유 좌석 신원 일치(fail-closed).
    if (!canWriteWorkerResource(request.identity, request.ownerIdentity, owner)) {
      return { ...WORKER_REGISTRY_WRITE_FORBIDDEN };
    }
    // [#39074 JUD ⓒ2] 기존 worker 의 owner ≠ 요청 owner 면 403 — 남의 worker 재등록(세대 오염) 차단.
    // 숫자·객체 id 가 SQLite TEXT 로 강제변환되어 owner 대조를 우회하던 구멍(셀프 리뷰 M1) — id 가 오면 문자열만.
    if (body['id'] !== undefined && typeof body['id'] !== 'string') {
      return { status: 400, body: { error: 'bad request', message: 'body.id must be a string' } };
    }
    const existingWorker = typeof body['id'] === 'string' ? store.getWorker(body['id']) : undefined;
    if (existingWorker && existingWorker.owner !== owner) {
      return { ...WORKER_REGISTRY_WRITE_FORBIDDEN };
    }
    try {
      return { status: 200, body: store.registerWorker(body as unknown as RegisterWorkerInput) };
    } catch (error) {
      return storeErrorToResponse(error);
    }
  }
  const desiredParams = matchRoute(WORKER_REGISTRY_ROUTES.setDesiredState, path);
  if (method === 'POST' && desiredParams) {
    const body = objectBody(request.body);
    const state = body?.['state'];
    if (typeof state !== 'string') {
      return { status: 400, body: { error: 'bad request', message: 'body.state (WorkerState) required' } };
    }
    // [NEXUS-WORKER-REGISTRY-FU] 상태 변경도 쓰기다 — HQ control 신원 + 소유 좌석 신원 일치만(fail-closed).
    const existing = store.getWorker(desiredParams.id!);
    if (!existing) {
      return { status: 404, body: { error: 'not found', id: desiredParams.id } };
    }
    if (!canWriteWorkerResource(request.identity, request.ownerIdentity, existing.owner)) {
      return { ...WORKER_REGISTRY_WRITE_FORBIDDEN };
    }
    try {
      const row = store.setDesiredState(desiredParams.id!, state as WorkerState);
      return row
        ? { status: 200, body: row }
        : { status: 404, body: { error: 'not found', id: desiredParams.id } };
    } catch (error) {
      return storeErrorToResponse(error);
    }
  }
  if (method === 'POST' && path === WORKER_REGISTRY_ROUTES.upsertHost) {
    const body = objectBody(request.body);
    if (!body) return { status: 400, body: { error: 'bad request', message: 'JSON object body required' } };
    // [#39074 JUD ⓒ1] host 쓰기 = 인증 host 신원(name 결속) 또는 관리자만. principal 은 본문이 아니라
    // 인증 컨텍스트에서만 받는다(관리자 제외). 폐기 해제·principal 회전은 관리자만.
    const name = body['name'];
    const isAdmin = request.admin === true;
    if (typeof name !== 'string') {
      return { status: 400, body: { error: 'bad request', message: 'body.name required' } };
    }
    if (!isAdmin && request.hostIdentity !== name) return { ...WORKER_REGISTRY_HOST_FORBIDDEN };
    const input: Record<string, unknown> = { ...body };
    if (!isAdmin) {
      const prev = store.getHost(name);
      if (prev) {
        if (prev.revokedAt) return { ...WORKER_REGISTRY_HOST_FORBIDDEN };
        if (prev.principal != null && request.hostPrincipal !== prev.principal) {
          return { ...WORKER_REGISTRY_HOST_FORBIDDEN };
        }
      }
      if (request.hostPrincipal != null) input['principal'] = request.hostPrincipal;
      else delete input['principal'];
    }
    try {
      return { status: 200, body: store.upsertHost(input as unknown as UpsertHostInput) };
    } catch (error) {
      return storeErrorToResponse(error);
    }
  }
  const heartbeatParams = matchRoute(WORKER_REGISTRY_ROUTES.heartbeatHost, path);
  if (method === 'POST' && heartbeatParams) {
    // [#39074 JUD ⓒ1] heartbeat 도 인증 host 신원(name 결속) 또는 관리자만, principal 은 인증 컨텍스트에서만.
    if (request.admin !== true && request.hostIdentity !== heartbeatParams.name) {
      return { ...WORKER_REGISTRY_HOST_FORBIDDEN };
    }
    const body = objectBody(request.body) ?? {};
    const principal = request.hostPrincipal;
    const expectedGeneration = body['expectedGeneration'];
    try {
      const row = store.heartbeatHost(heartbeatParams.name!, {
        principal: typeof principal === 'string' ? principal : undefined,
        expectedGeneration: typeof expectedGeneration === 'number' ? expectedGeneration : undefined,
      });
      return row
        ? { status: 200, body: row }
        : { status: 404, body: { error: 'not found', name: heartbeatParams.name } };
    } catch (error) {
      return storeErrorToResponse(error);
    }
  }
  return { status: 404, body: { error: 'not found', path } };
}

// ----- r2 ⑧ — heartbeat 생산자 -----
//  배선 지점: 호스트 자리(각 노드)가 기동 시 자기 name 으로 이 생산자를 돌린다.
//  미확정 원장 실배선·라이브 연결은 이 PR 범위 밖 — CC-4가 #38896 어댑터로 연결한다.

export interface HeartbeatProducerOptions {
  /** 이 호스트 자리의 name(worker_hosts 키). */
  readonly name: string;
  /** r2 — 이 호스트 자리의 인증 principal. 결속된 호스트는 박동마다 이 값을 내놓는다
   *  (host-bound heartbeat). 결속된 호스트에 principal 없이 박동하면 store 가 거절한다. */
  readonly principal?: string;
  /** r2 — (선택) 세대 고정 — 박동마다 기대 세대를 검사해 이전 세대의 재생(replay)을 거절한다. */
  readonly expectedGeneration?: number;
  /** 박동 간격(ms). 생산자는 TTL 을 검사하지 않는다 — TTL 검증은 upsert 계층. */
  readonly intervalMs: number;
  /** 틱마다 실제 시계(주입 가능). 기본 실시계. */
  readonly now?: () => Date;
  /** 정지 신호 — true 가 되면 생산자가 스스로 멈춘다. */
  readonly shouldStop?: () => boolean;
}

export interface HeartbeatProducer {
  /** 한 번 박동 — heartbeatHost 를 store 에 기록(name+principal+세대 결속).
   *  미등록 호스트면 undefined 를 되돌리고 계속하지 않는다.
   *  수명 계약 위반(폐기·교차 principal·재생 세대)은 그대로 throw — 호출자가 결속 상태를 인지한다. */
  tick(): ReturnType<WorkerRegistryStore['heartbeatHost']>;
  /** 주기 구동 — shouldStop() 이 true 면 정리하고 'stopped' 를 돌려준다. */
  start(): Promise<'stopped'>;
}

export function createHeartbeatProducer(
  store: WorkerRegistryStore,
  options: HeartbeatProducerOptions,
): HeartbeatProducer {
  const beat = (): ReturnType<WorkerRegistryStore['heartbeatHost']> =>
    store.heartbeatHost(options.name, {
      principal: options.principal,
      expectedGeneration: options.expectedGeneration,
    });
  return {
    tick: beat,
    start: async () => {
      for (;;) {
        if (options.shouldStop?.()) return 'stopped';
        beat();
        await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
      }
    },
  };
}

/** SSE 형식화 — 한 사건을 `event: …\ndata: {json}\nid: {seq}\n\n` 껍데기로. */
export function formatWorkerWatchSse(event: WorkerWatchEvent): string {
  return `event: worker-watch\ndata: ${JSON.stringify(event)}\nid: ${event.seq}\n\n`;
}

// Process/module-local limit only: deployment must additionally cap connections globally.
export const MAX_WORKER_WATCH_STREAMS = 64;
let activeWorkerWatchStreams = 0;

/** draft 골격 핸들러 — 라우터 배선은 정식 구현 PR에서. */
export function bindWorkerRegistryFront(store: WorkerRegistryStore): {
  list(): ReturnType<WorkerRegistryStore['listWorkers']>;
  get(id: string): ReturnType<WorkerRegistryStore['getWorker']>;
  sseFromLastEventId(lastEventId: string | null): ReadableStream<Uint8Array>;
} {
  return {
    list: () => store.listWorkers(),
    get: (id: string) => store.getWorker(id),
    sseFromLastEventId: (lastEventId: string | null) => {
      if (lastEventId !== null && !/^(0|[1-9]\d*)$/.test(lastEventId)) throw new Error('invalid watch cursor; resnapshot');
      let cursor = lastEventId === null ? 0 : Number(lastEventId);
      if (!Number.isSafeInteger(cursor)) throw new Error('invalid watch cursor; resnapshot');
      if (activeWorkerWatchStreams >= MAX_WORKER_WATCH_STREAMS) throw new Error('watch capacity exceeded; retry later');
      activeWorkerWatchStreams++;
      let released = false;
      const release = () => {
        if (!released) { released = true; activeWorkerWatchStreams--; }
      };
      const encoder = new TextEncoder();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wake: (() => void) | undefined;
      let cancelled = false;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            while (!cancelled) {
              const event = store.watchNext(cursor);
              if (event) {
                const frame = encoder.encode(formatWorkerWatchSse(event));
                if (frame.byteLength > 64 * 1024) throw new Error('watch frame too large; resnapshot');
                controller.enqueue(frame);
                cursor = event.seq;
                return;
              }
              await new Promise<void>((resolve) => { wake = resolve; timer = setTimeout(resolve, 100); });
              timer = undefined;
              wake = undefined;
            }
          } catch (error) { if (!cancelled) { release(); controller.error(error); } }
        },
        cancel() { cancelled = true; if (timer) clearTimeout(timer); wake?.(); release(); },
      }, { highWaterMark: 1 });

    },
  };
}
