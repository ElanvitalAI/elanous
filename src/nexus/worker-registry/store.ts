// NEXUS · worker registry store — DRAFT, 정식 구현 아님 (OP #95243 / TC #95249)
//
// 원장 = sqlite(WAL). 단일 쓰기 규칙(D8): nexus 프로세스만 쓴다.
// watch 사건 흐름: appendEvent 가 watch emitter 로 배달 + worker_watch 표에
// append(재접속 replay 용). SSE 골격은 api.ts, WS 는 후속 PR.

import { Database } from 'bun:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { isTailnetOrLoopback } from '../../els/hosts.js';
import { migrateWorkerRegistry } from './schema.js';
import {
  BINDING_KINDS, isWorkerKind, isWorkerRole, isWorkerState,
  type BindingKind, type HostRow, type WorkerKind, type WorkerRole, type WorkerRow,
  type WorkerRegistrySnapshot, type WorkerState, type WorkerWatchEvent,
} from './types.js';

/** r2 ② TTL 허용 범위 — 1초 이상 24시간 이하. */
export const HEARTBEAT_TTL_MIN_MS = 1_000;
export const HEARTBEAT_TTL_MAX_MS = 86_400_000;
/** r2 ③ 시계 어긋남 허용폭 — 이 안의 미래 aliveAt 은 alive 로 인정(fail-closed 기준). */
export const MAX_CLOCK_SKEW_MS = 300_000;
/** r2 ③ — 스냅샷 최대 신선도 계약값. 이후 소비자는 스냅샷을 신선하지 않다고 간주. */
export const MAX_SNAPSHOT_FRESHNESS_MS = 30_000;

export interface RegisterWorkerInput {
  readonly id: string;
  readonly kind: WorkerKind;
  readonly goal?: string;
  readonly command?: string;
  readonly host?: string;
  readonly parent?: string;
  readonly fanout?: string;
  readonly owner?: string;
  readonly budget?: string;
  readonly isolation?: string;
  readonly role?: WorkerRole;
  readonly siblings?: readonly string[];
  readonly children?: readonly string[];
  readonly costMs?: number;
  readonly latencyMs?: number;
  readonly risk?: string;
  readonly bindings?: readonly BindingKind[];
  readonly desiredState?: WorkerState;
  readonly paneId?: string;
  readonly eventId?: string;
}

export interface UpsertHostInput {
  readonly name: string;
  /** r2 — 인증 host principal. 달라진 principal 은 generation 회전(+1)을 일으킨다. */
  readonly principal?: string;
  readonly elsEndpoint?: string;
  readonly elsVersionSha?: string;
  readonly heartbeatTtlMs?: number;
}

type WatchListener = (event: WorkerWatchEvent) => void;

interface Emitter {
  subscribe(listener: WatchListener): () => void;
  emit(event: WorkerWatchEvent): void;
}

export function createWatchEmitter(): Emitter {
  const listeners = new Set<WatchListener>();
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    emit(event) { for (const listener of listeners) { try { listener(event); } catch { /* delivery is best effort after commit */ } } },
  };
}

function nowIso(now: () => Date = () => new Date()): string {
  return now().toISOString();
}

function validateBindings(bindings: readonly BindingKind[]): string | null {
  for (const binding of bindings) {
    if (!(BINDING_KINDS as readonly string[]).includes(binding)) return `bad binding: ${binding}`;
  }
  return null;
}

/** 엘라누스 규칙: elsEndpoint 는 tailnet/loopback origin 만. 공중망 URL 은 거절.
 *  r2 ① — userinfo(username·password)·query(search)·hash(fragment) 도 전부 거절: origin 만. */
export function validateElsEndpoint(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'not http(s)';
    if (url.username !== '' || url.password !== '') return 'no userinfo in endpoint';
    if (url.search !== '') return 'no query string in endpoint';
    if (url.hash !== '') return 'no fragment in endpoint';
    if (url.pathname !== '/' && url.pathname !== '') return 'must be an origin';
    if (!isTailnetOrLoopback(url.hostname)) return 'not a tailnet/loopback origin';
    return null;
  } catch {
    return 'not a URL';
  }
}

export class WorkerRegistryStore {
  readonly db: Database;
  private readonly emitter = createWatchEmitter();
  private pending: WorkerWatchEvent[] | null = null;
  private readonly delivery: WorkerWatchEvent[] = [];
  private delivering = false;

  private atomic<T>(fn: () => T): T {
    if (this.pending) throw new Error('reentrant mutation not allowed');
    if (this.db.inTransaction) throw new Error('outer transaction not allowed');
    const pending: WorkerWatchEvent[] = [];
    this.pending = pending;
    let result: T;
    try { result = this.db.transaction(fn).immediate(); }
    finally { this.pending = null; }
    this.delivery.push(...pending);
    if (!this.delivering) {
      this.delivering = true;
      try { while (this.delivery.length) this.emitter.emit(this.delivery.shift()!); }
      finally { this.delivering = false; }
    }
    return result;
  }
  private readonly dbPath: string;
  private readonly fileIdentity: string;

  constructor(dbPath: string, private readonly now: () => Date = () => new Date()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    migrateWorkerRegistry(this.db);
    this.fileIdentity = this.watchFileIdentity();
  }

  close(): void { this.db.close(); }

  private watchFileIdentity(): string {
    if (this.dbPath === ':memory:') return ':memory:';
    const st = statSync(this.dbPath);
    return `${st.dev}:${st.ino}`;
  }

  // Read committed log only; callers must resnapshot on any uncertainty.
  watchNext(seq: number): WorkerWatchEvent | undefined {
    if (this.watchFileIdentity() !== this.fileIdentity) throw new Error('watch database replaced; resnapshot');
    if (this.db.inTransaction) throw new Error('watch unavailable during transaction');
    return this.db.transaction(() => {
      if (seq && !this.db.query('SELECT 1 FROM worker_watch WHERE seq = ?').get(seq))
        throw new Error('watch cursor expired; resnapshot');
      const row = this.db.query('SELECT * FROM worker_watch WHERE seq > ? ORDER BY seq LIMIT 1').get(seq) as Record<string, unknown> | undefined;
      if (row && (!Number.isSafeInteger(Number(row.seq)) || Number(row.seq) !== seq + 1)) throw new Error('watch history gap; resnapshot');
      return row ? this.toWatchEvent(row) : undefined;
    })();
  }

  // ----- 등록 -----

  registerWorker(input: RegisterWorkerInput): WorkerRow {
    return this.atomic(() => this.registerWorkerInTransaction(input));
  }

  private registerWorkerInTransaction(input: RegisterWorkerInput): WorkerRow {
    if (!isWorkerKind(input.kind)) throw new Error(`bad kind: ${input.kind}`);
    if (input.role !== undefined && input.role !== null && !isWorkerRole(input.role)) {
      throw new Error(`bad role: ${input.role}`);
    }
    if (input.bindings) {
      const bad = validateBindings(input.bindings);
      if (bad) throw new Error(bad);
    }
    // r2 — 교차호스트·위조 등록 거부: host 를 주 장하는 worker 는 반드시
    // 살아 있는(폐기되지 않은) worker_hosts 행에 결속되어 있어야 한다.
    if (input.host) {
      const hostRow = this.getHost(input.host);
      if (!hostRow) throw new Error(`unknown host: ${input.host} — worker_hosts 에 먼저 등록하라`);
      if (hostRow.revokedAt) throw new Error(`host revoked: ${input.host} (revokedAt ${hostRow.revokedAt})`);
    }
    const at = nowIso(this.now);
    // r2 ⑤ — generation: 같은 id 의 'registered' watch 사건 수 + 1. 삭제 후 재등록도
    // watch 원장은 남으므로 항상 새(증가) 세대 번호를 받는다.
    const generation = this.nextGeneration(input.id);
    this.db
      .query(`INSERT INTO workers (id, kind, goal, command, host, parent, fanout, owner, budget, isolation,
              generation, role, siblings_json, children_json, cost_ms, latency_ms, risk,
              capabilities_json, desired_state, actual_state, pane_id, event_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET generation = excluded.generation,
                created_at = excluded.created_at, updated_at = excluded.updated_at`)
      .run(input.id, input.kind, input.goal ?? null, input.command ?? null, input.host ?? null,
        input.parent ?? null, input.fanout ?? null, input.owner ?? null, input.budget ?? null,
        input.isolation ?? null,
        generation,
        input.role ?? null,
        input.siblings ? JSON.stringify(input.siblings) : null,
        input.children ? JSON.stringify(input.children) : null,
        input.costMs ?? null, input.latencyMs ?? null, input.risk ?? null,
        input.bindings ? JSON.stringify({ bindings: input.bindings }) : null,
        input.desiredState ?? null, input.paneId ?? null, input.eventId ?? null, at, at);
    const row = this.getWorker(input.id)!;
    this.appendEventInTransaction({ workerId: input.id, type: 'registered', paneId: row.paneId, eventId: row.eventId });
    return row;
  }

  /** Legacy report: state and output must commit together; not an authentication boundary. */
  applyLegacyPaneState(paneId: string, eventId: string | null, state: string): string | null {
    return this.atomic(() => {
      const worker = this.listWorkers().find(row => row.paneId === paneId);
      if (!worker) return null;
      if (!isWorkerState(state)) throw new Error(`bad worker state from els: ${state}`);
      this.setActualStateInTransaction(worker.id, state);
      this.appendEventInTransaction({ workerId: worker.id, type: 'output', paneId, eventId });
      return worker.id;
    });
  }

  getWorker(id: string): WorkerRow | undefined {
    const row = this.db.query('SELECT * FROM workers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.toWorkerRow(row) : undefined;
  }

  listWorkers(): WorkerRow[] {
    return (this.db.query('SELECT * FROM workers ORDER BY id').all() as Record<string, unknown>[])
      .map((row) => this.toWorkerRow(row));
  }

  /** r2 ⑤ — 삭제 + 'stopped' watch 사건. 원장(watch)은 남으므로 재등록 generation 은 계속 증가.
   *  반환 = 해당 행이 있어 삭제되었으면 true. */
  deleteWorker(id: string): boolean {
    return this.atomic(() => this.deleteWorkerInTransaction(id));
  }

  private deleteWorkerInTransaction(id: string): boolean {
    const before = this.getWorker(id);
    if (!before) return false;
    if (this.db.query('DELETE FROM workers WHERE id = ?').run(id).changes !== 1) throw new Error('worker changed');
    this.appendEventInTransaction({ workerId: id, type: 'stopped',
      fromState: before.actualState, toState: null, paneId: before.paneId, eventId: before.eventId });
    return true;
  }

  /** r2 ⑤ — 같은 id 재등록 시 새 generation 번호. watch 원장 기준이라 삭제 후에도 단조 증가. */
  private nextGeneration(id: string): number {
    const row = this.db
      .query(`SELECT COUNT(*) AS c FROM worker_watch WHERE worker_id = ? AND type = 'registered'`)
      .get(id) as { c: number };
    return Number(row.c) + 1;
  }

  /** r2 ③ — 완전 스냅샷: 비페이징 전체 투영 + revision 와이어.
   *  원자성: 읽기 트랜잭션 하나로 revision·workers·hosts 를 한 시점에 읽는다
   *  (WAL 스냅샷 격리 — 트랜잭션 밖이면 세 읽기가 서로 다른 시점을 볼 수 있다).
   *  어느 읽기 하나라도 실패하면 스냅샷 전체가 실패(fail-closed) —
   *  부분 투영은 반환하지 않는다(계약 주석 types.ts 참조). */
  snapshot(): WorkerRegistrySnapshot {
    const readSnapshot = this.db.transaction((): WorkerRegistrySnapshot => ({
      revision: this.currentRevision(),
      at: nowIso(this.now),
      maxFreshnessMs: MAX_SNAPSHOT_FRESHNESS_MS,
      workers: this.listWorkers(),
      hosts: this.listHosts(),
    }));
    return readSnapshot();
  }

  /** 현재 revision = worker_watch 최대 seq(사건이 없으면 0). 쓰기마다 단조 증가. */
  currentRevision(): number {
    const row = this.db.query('SELECT MAX(seq) AS m FROM worker_watch').get() as { m: number | null };
    return row.m == null ? 0 : Number(row.m);
  }

  /** 실제 상태 갱신 — els 보고 경로가 부른다. */
  setActualState(id: string, state: WorkerState): WorkerRow | undefined {
    return this.atomic(() => this.setActualStateInTransaction(id, state));
  }

  private setActualStateInTransaction(id: string, state: WorkerState): WorkerRow | undefined {
    if (!isWorkerState(state)) throw new Error(`bad state: ${state}`);
    const before = this.getWorker(id);
    if (!before) return undefined;
    const at = nowIso(this.now);
    if (this.db.query('UPDATE workers SET actual_state = ?, updated_at = ? WHERE id = ?')
      .run(state, at, id).changes !== 1) throw new Error('worker changed');
    this.appendEventInTransaction({ workerId: id, type: 'state', fromState: before.actualState, toState: state,
      paneId: before.paneId, eventId: before.eventId });
    return this.getWorker(id);
  }

  /** 원하는 상태 설정(좌석/사람). */
  setDesiredState(id: string, state: WorkerState): WorkerRow | undefined {
    return this.atomic(() => this.setDesiredStateInTransaction(id, state));
  }

  private setDesiredStateInTransaction(id: string, state: WorkerState): WorkerRow | undefined {
    if (!isWorkerState(state)) throw new Error(`bad state: ${state}`);
    const before = this.getWorker(id);
    if (!before) return undefined;
    if (this.db.query('UPDATE workers SET desired_state = ?, updated_at = ? WHERE id = ?')
      .run(state, nowIso(this.now), id).changes !== 1) throw new Error('worker changed');
    this.appendEventInTransaction({ workerId: id, type: 'steer', fromState: before.desiredState,
      toState: state, paneId: before.paneId, eventId: before.eventId });
    return this.getWorker(id);
  }

  // ----- 호스트 행 계약 (CC-4 기다림: 필드·수명만) -----

  upsertHost(input: UpsertHostInput): HostRow {
    return this.atomic(() => this.upsertHostInTransaction(input));
  }

  private upsertHostInTransaction(input: UpsertHostInput): HostRow {
    if (input.elsEndpoint !== undefined && input.elsEndpoint !== null) {
      const bad = validateElsEndpoint(input.elsEndpoint);
      if (bad) throw new Error(`bad elsEndpoint (${bad}): ${input.elsEndpoint}`);
    }
    // r2 ② — heartbeatTtlMs 는 주어졌으면 양수 정수, 1_000 이상 86_400_000 이하. null 은 허용(등록만 하고 TTL 은 나중).
    if (input.heartbeatTtlMs !== undefined && input.heartbeatTtlMs !== null) {
      const ttl = input.heartbeatTtlMs;
      if (!Number.isInteger(ttl) || ttl < HEARTBEAT_TTL_MIN_MS || ttl > HEARTBEAT_TTL_MAX_MS) {
        throw new Error(`bad heartbeatTtlMs: ${ttl} (must be integer ${HEARTBEAT_TTL_MIN_MS}..${HEARTBEAT_TTL_MAX_MS})`);
      }
    }
    const at = nowIso(this.now);
    // r2 결속 — principal 회전 판정: 기존 행의 principal 과 달라지면 generation +1,
    // 회전 시에만 폐기(revoked_at)가 풀린다(재등록 = 새 principal 세대). 같은 principal 의
    // 재등록은 폐기를 풀지 않는다 — 폐기 해제는 반드시 세대 교체로만.
    const prev = this.db
      .query('SELECT principal, generation FROM worker_hosts WHERE name = ?')
      .get(input.name) as { principal: string | null; generation: number } | undefined;
    const newPrincipal = input.principal ?? null;
    const rotated = prev != null && newPrincipal !== null && (prev.principal ?? null) !== newPrincipal;
    const generation = prev == null ? 1 : rotated ? Number(prev.generation) + 1 : Number(prev.generation);
    this.db.query(`INSERT INTO worker_hosts (name, els_endpoint, els_version_sha, alive_at, heartbeat_ttl_ms,
                                       principal, generation, revoked_at, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(name) DO UPDATE SET
                     -- 새 세대는 새로 제공된 정보만 쓴다. 같은 세대의 생략값은 보존한다.
                     els_endpoint = CASE WHEN excluded.generation > worker_hosts.generation THEN excluded.els_endpoint
                                         ELSE COALESCE(excluded.els_endpoint, worker_hosts.els_endpoint) END,
                     els_version_sha = CASE WHEN excluded.generation > worker_hosts.generation THEN excluded.els_version_sha
                                            ELSE COALESCE(excluded.els_version_sha, worker_hosts.els_version_sha) END,
                     alive_at = excluded.alive_at,
                     heartbeat_ttl_ms = COALESCE(excluded.heartbeat_ttl_ms, worker_hosts.heartbeat_ttl_ms),
                     principal = COALESCE(excluded.principal, worker_hosts.principal),
                     generation = excluded.generation,
                     revoked_at = CASE WHEN excluded.generation > worker_hosts.generation THEN NULL
                                       ELSE worker_hosts.revoked_at END,
                     updated_at = excluded.updated_at`)
      .run(input.name, input.elsEndpoint ?? null, input.elsVersionSha ?? null, at,
        input.heartbeatTtlMs ?? null, newPrincipal, generation,
        prev == null ? null : rotated ? null : (this.getHost(input.name)?.revokedAt ?? null),
        at, at);
    const row = this.db.query('SELECT * FROM worker_hosts WHERE name = ?').get(input.name) as Record<string, unknown>;
    const host = this.toHostRow(row);
    // r2 ② — 모든 쓰기 앞문은 watch 사건: 호스트 upsert(생성·갱신·세대 회전 모두)도
    // 원장에 남고 revision(=MAX seq)을 단조 증가시킨다 — 호스트만 바뀌어도 스냅샷 캐시는 무효화.
    // workerId 규약: `host:<name>`(types.ts WorkerWatchEvent 주석 참조).
    this.appendEventInTransaction({ workerId: `host:${input.name}`, type: 'host-upserted' });
    return host;
  }

  listHosts(): HostRow[] {
    return (this.db.query('SELECT * FROM worker_hosts ORDER BY name').all() as Record<string, unknown>[])
      .map((row) => this.toHostRow(row));
  }

  /** r2 ④ — alive 행만(만료 행은 보존되지만 여기서는 걸러짐). */
  listAliveHosts(): HostRow[] {
    return this.listHosts().filter((host) => host.alive);
  }

  /** r2 — 이름 단일 호스트 행 읽기(alive 계산 포함). 없으면 undefined. */
  getHost(name: string): HostRow | undefined {
    const row = this.db.query('SELECT * FROM worker_hosts WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    return row ? this.toHostRow(row) : undefined;
  }

  /** r2 — 폐기(revocation): revoked_at 을 찍는다. 폐기 행은 alive=false · 등록/박동 거절.
   *  폐기 해제는 같은 이름의 새 principal 등록(세대 회전)으로만 일어난다. 반환 = 갱신된 행.
   *  폐기도 쓰기 앞문 — 실제로 폐기된 경우에만 host-revoked watch 사건을 남긴다
   *  (이미 폐기된 행의 재호출은 멱등: 사건을 중복으로 남기지 않는다). */
  revokeHost(name: string): HostRow | undefined {
    return this.atomic(() => this.revokeHostInTransaction(name));
  }

  private revokeHostInTransaction(name: string): HostRow | undefined {
    const at = nowIso(this.now);
    const result = this.db
      .query('UPDATE worker_hosts SET revoked_at = ?, updated_at = ? WHERE name = ? AND revoked_at IS NULL')
      .run(at, at, name);
    const row = this.getHost(name);
    if (result.changes > 0 && row) {
      this.appendEventInTransaction({ workerId: `host:${name}`, type: 'host-revoked' });
    }
    return row;
  }

  /** heartbeat — aliveAt 를 지금으로. TTL 만료 판정은 isHostAlive.
   *  r2 수명 계약:
   *   - 폐기된 호스트의 박동은 거절(throw) — 오프라인 TTL 만료와 달리 폐기는 영구(재등록 필요).
   *   - expectedGeneration 이 주어졌으면 현재 세대와 같아야 한다 — 이전 세대의 재생(replay) 거절.
   *   - host-bound(r2 ⑧): principal 이 결속된 호스트는 박동마다 "자기" principal 을 내놓아야 한다 —
   *     다른 호스트 자리가 대신 박동하는 교차호스트 쓰기를 거절한다(fail-closed: 결속된 호스트에
   *     principal 없는 박동도 거절). 결속 전(principal 없는 호스트)의 박동은 받되 결속하지 않는다
   *     — 결속은 upsertHost 의 세대 회전으로만 일어난다.
   *  박동은 liveness tick — watch 원장에 사건을 남기지 않고 행의 alive_at 이 원장 기록이 된다
   *  (revision 을 흔들지 않아 스냅샷 캐시가 박동마다 무효화되지 않는다; 신선도는 maxFreshnessMs). */
  heartbeatHost(name: string, opts?: { principal?: string; expectedGeneration?: number }): HostRow | undefined {
    return this.atomic(() => this.heartbeatHostInTransaction(name, opts));
  }

  private heartbeatHostInTransaction(name: string, opts?: { principal?: string; expectedGeneration?: number }): HostRow | undefined {
    const before = this.getHost(name);
    if (!before) return undefined;
    if (before.revokedAt) {
      throw new Error(`host revoked: ${name} (revokedAt ${before.revokedAt}) — 새 principal 로 재등록하라`);
    }
    if (opts?.expectedGeneration != null && opts.expectedGeneration !== before.generation) {
      throw new Error(
        `stale host generation: ${name} expected ${opts.expectedGeneration} actual ${before.generation} — 재생(replay) 거절`);
    }
    if (before.principal != null) {
      if (opts?.principal == null) {
        throw new Error(
          `host principal required: ${name} (bound ${before.principal}) — 결속된 호스트는 자기 principal 로 박동하라`);
      }
      if (opts.principal !== before.principal) {
        throw new Error(
          `host principal mismatch: ${name} bound ${before.principal} got ${opts.principal} — 교차호스트 거부`);
      }
    }
    this.db.query('UPDATE worker_hosts SET alive_at = ?, updated_at = ? WHERE name = ?')
      .run(nowIso(this.now), nowIso(this.now), name);
    return this.getHost(name);
  }

  /** r2 — 스냅샷 신선도 판정: at 로부터 maxFreshnessMs(기본 MAX_SNAPSHOT_FRESHNESS_MS) 안이면 신선.
   *  fail-closed: 파싱 실패·미래 시각(시계 어긋남 허용폭 초과)은 신선하지 않음. */
  isSnapshotFresh(snapshot: Pick<WorkerRegistrySnapshot, 'at' | 'maxFreshnessMs'>): boolean {
    const atMs = Date.parse(snapshot.at);
    if (!Number.isFinite(atMs)) return false;
    const nowMs = this.now().getTime();
    if (atMs > nowMs + MAX_CLOCK_SKEW_MS) return false;
    return nowMs - atMs < (snapshot.maxFreshnessMs ?? MAX_SNAPSHOT_FRESHNESS_MS);
  }

  isHostAlive(host: Pick<HostRow, 'aliveAt' | 'heartbeatTtlMs' | 'revokedAt'>): boolean {
    if (host.revokedAt) return false; // r2 — 폐기는 오프라인 TTL 과 달리 영구: 박동으로 되살지 않는다.
    if (!host.aliveAt || host.heartbeatTtlMs == null) return false;
    const aliveAt = Date.parse(host.aliveAt);
    if (!Number.isFinite(aliveAt)) return false;
    // r2 ② — alive 판정은 주입 시계(this.now)로. 시험 시계로 결정적 만료 검증 가능.
    const nowMs = this.now().getTime();
    // r2 ③ — fail-closed: 미래 aliveAt 은 무효. 단 MAX_CLOCK_SKEW_MS 이내의 미래는 시계 어긋남으로 alive 인정.
    if (aliveAt > nowMs + MAX_CLOCK_SKEW_MS) return false;
    return nowMs - aliveAt < host.heartbeatTtlMs;
  }

  // ----- watch 사건 -----

  appendEvent(input: {
    workerId: string; type: WorkerWatchEvent['type'];
    fromState?: WorkerState | null; toState?: WorkerState | null;
    paneId?: string | null; eventId?: string | null;
  }): WorkerWatchEvent {
    return this.atomic(() => this.appendEventInTransaction(input));
  }

  private appendEventInTransaction(input: {
    workerId: string; type: WorkerWatchEvent['type'];
    fromState?: WorkerState | null; toState?: WorkerState | null;
    paneId?: string | null; eventId?: string | null;
  }): WorkerWatchEvent {
    const at = nowIso(this.now);
    const result = this.db.query(`INSERT INTO worker_watch (worker_id, type, from_state, to_state, pane_id, event_id, at)
                                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(input.workerId, input.type, input.fromState ?? null, input.toState ?? null,
        input.paneId ?? null, input.eventId ?? null, at);
    const event: WorkerWatchEvent = {
      seq: Number(result.lastInsertRowid),
      workerId: input.workerId,
      type: input.type,
      fromState: input.fromState ?? null,
      toState: input.toState ?? null,
      paneId: input.paneId ?? null,
      eventId: input.eventId ?? null,
      at,
    };
    this.pending!.push(event);
    return event;
  }

  eventsSince(seq: number): WorkerWatchEvent[] {
    return (this.db.query('SELECT * FROM worker_watch WHERE seq > ? ORDER BY seq').all(seq) as Record<string, unknown>[])
      .map((row) => this.toWatchEvent(row));
  }

  subscribe(listener: WatchListener): () => void {
    return this.emitter.subscribe(listener);
  }

  // ----- 직렬화 -----

  private toWorkerRow(row: Record<string, unknown>): WorkerRow {
    return {
      id: row.id as string,
      kind: row.kind as WorkerKind,
      goal: (row.goal as string | null) ?? null,
      command: (row.command as string | null) ?? null,
      host: (row.host as string | null) ?? null,
      parent: (row.parent as string | null) ?? null,
      fanout: (row.fanout as string | null) ?? null,
      owner: (row.owner as string | null) ?? null,
      budget: (row.budget as string | null) ?? null,
      isolation: (row.isolation as string | null) ?? null,
      generation: row.generation == null ? 1 : Number(row.generation),
      role: (row.role as WorkerRole | null) ?? null,
      siblingsJson: (row.siblings_json as string | null) ?? null,
      childrenJson: (row.children_json as string | null) ?? null,
      costMs: row.cost_ms == null ? null : Number(row.cost_ms),
      latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
      risk: (row.risk as string | null) ?? null,
      capabilitiesJson: (row.capabilities_json as string | null) ?? null,
      desiredState: (row.desired_state as WorkerState | null) ?? null,
      actualState: row.actual_state as WorkerState,
      paneId: (row.pane_id as string | null) ?? null,
      eventId: (row.event_id as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private toHostRow(row: Record<string, unknown>): HostRow {
    const host: Omit<HostRow, 'alive'> = {
      name: row.name as string,
      principal: (row.principal as string | null) ?? null,
      generation: row.generation == null ? 1 : Number(row.generation),
      revokedAt: (row.revoked_at as string | null) ?? null,
      elsEndpoint: (row.els_endpoint as string | null) ?? null,
      // r2 — elsVersionSha 는 자기보고(self-reported)·보존 필드: artifact 증명 아님(TC-H-CC-4 판정 준용).
      elsVersionSha: (row.els_version_sha as string | null) ?? null,
      aliveAt: (row.alive_at as string | null) ?? null,
      heartbeatTtlMs: row.heartbeat_ttl_ms == null ? null : Number(row.heartbeat_ttl_ms),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
    // r2 ④ — alive 는 계산 필드: 저장 안 하고 읽기 시점에 판정.
    return { ...host, alive: this.isHostAlive(host) };
  }

  private toWatchEvent(row: Record<string, unknown>): WorkerWatchEvent {
    return {
      seq: Number(row.seq),
      workerId: row.worker_id as string,
      type: row.type as WorkerWatchEvent['type'],
      fromState: (row.from_state as WorkerState | null) ?? null,
      toState: (row.to_state as WorkerState | null) ?? null,
      paneId: (row.pane_id as string | null) ?? null,
      eventId: (row.event_id as string | null) ?? null,
      at: row.at as string,
    };
  }
}
