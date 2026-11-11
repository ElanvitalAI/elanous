// ── NotificationStore (NT1) ──
//
// 세션별 이벤트 history ring buffer. 기존 elanous 는 toast 나
// chatLines push 로 "즉시 알림" 만 있었고 되짚어 보는 수단이
// 없었다. 여기서 세션별로 events 를 모아두고 sidebar unread
// badge + bell modal (NT4) 에 공급한다.
//
// 소스 (NT2 에서 연결):
//  - AgentStatusStore 상태 전이 (US1)
//  - PreviewTerminal OSC 9/99/777 notify
//  - matrix 'exited' / 'killed' / 'attention'
//  - BlockStore commit (BL 단계 완료 후)
//  - HITL 외부 콜백 (future)
//
// unread 정책:
//  - push 시 event.read = false (명시 true 가 아니면)
//  - markRead(sessionId) — 해당 세션 전체 read 로 전이
//  - markAllRead() — 전체
//  - sidebar cursor 가 해당 row 에 있으면 dashboard 가 자동으로
//    markRead 호출 (NT3)

export type NotificationKind =
  | 'status'       // AgentStatus 전이 (working / awaiting / done / err / idle)
  | 'osc'          // OSC 9/99/777 notify
  | 'exit'         // PTY process exit
  | 'block'        // BlockStore commit
  | 'error'        // 파싱/런타임 에러
  | 'hitl'         // HITL 콜백 (approval, etc.)
  | 'agent-done'   // PFC-S1 P2: background Agent task finished (done/error/aborted)
  | 'escalation'   // PFC-S3.1: Andon Cord signal (LOW/MED/HIGH/CRITICAL)
  | 'briefing';    // Absorb briefing notification card

export interface NotificationEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: NotificationKind;
  readonly ts: number;
  readonly title: string;
  readonly body?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
  read: boolean;
}

export interface NotificationStoreOpts {
  capPerSession?: number;
  now?: () => number;
  /** NT-E2 — optional on-disk sidecar. When present, every push is
   *  appended; `replay()` seeds the in-memory ring buffer from it on
   *  startup. Pass `null` in tests to short-circuit I/O without
   *  branching push-path logic. */
  persistence?: import('./persistence.js').PersistenceAdapter | null;
}

export type NotificationSubscriber = (event: NotificationEvent) => void;

const DEFAULT_CAP = 50;

function envCap(): number | undefined {
  const raw = process.env['ELANOUS_NOTIFICATION_STORE_CAP'];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface NotificationPushInput {
  sessionId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  meta?: Record<string, unknown>;
  /** Some events (e.g. a re-broadcast) should not move unread to true.
   *  Default false — i.e. new events are unread. */
  read?: boolean;
}

export class NotificationStore {
  private readonly buffers = new Map<string, NotificationEvent[]>();
  private readonly subs = new Set<NotificationSubscriber>();
  private readonly cap: number;
  private readonly now: () => number;
  private readonly persistence: import('./persistence.js').PersistenceAdapter | null;
  private seq = 0;

  constructor(opts: NotificationStoreOpts = {}) {
    this.cap = opts.capPerSession ?? envCap() ?? DEFAULT_CAP;
    this.now = opts.now ?? (() => Date.now());
    this.persistence = opts.persistence ?? null;
  }

  push(input: NotificationPushInput): NotificationEvent {
    const event: NotificationEvent = {
      id: `evt:${++this.seq}`,
      sessionId: input.sessionId,
      kind: input.kind,
      ts: this.now(),
      title: input.title,
      read: input.read ?? false,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
    };
    let arr = this.buffers.get(input.sessionId);
    if (!arr) {
      arr = [];
      this.buffers.set(input.sessionId, arr);
    }
    arr.push(event);
    while (arr.length > this.cap) arr.shift();
    if (this.persistence) {
      try { this.persistence.append(event); } catch { /* never fail the push */ }
    }
    for (const cb of this.subs) cb(event);
    return event;
  }

  /** NT-E2 — seed the in-memory buffers from the persistence
   *  adapter. Replayed events are stamped `read: true` so the next
   *  launch doesn't pop unread badges for old history. Per-session
   *  cap is still respected (oldest replayed entries are dropped). */
  replay(): number {
    if (!this.persistence) return 0;
    const events = this.persistence.readAll();
    let injected = 0;
    // Track the max seq seen so subsequent push ids don't collide.
    let maxSeq = this.seq;
    for (const evt of events) {
      const m = /^evt:(\d+)$/.exec(evt.id);
      if (m) {
        const n = Number.parseInt(m[1]!, 10);
        if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
      }
      let arr = this.buffers.get(evt.sessionId);
      if (!arr) {
        arr = [];
        this.buffers.set(evt.sessionId, arr);
      }
      arr.push({ ...evt, read: true });
      while (arr.length > this.cap) arr.shift();
      injected++;
    }
    this.seq = maxSeq;
    return injected;
  }

  /** List events for a session (or all sessions when omitted), most
   *  recent last. `limit` (optional) caps to the last N. */
  list(sessionId?: string, limit?: number): NotificationEvent[] {
    if (sessionId !== undefined) {
      const arr = this.buffers.get(sessionId) ?? [];
      return limit === undefined || limit >= arr.length ? arr.slice() : arr.slice(arr.length - limit);
    }
    const all: NotificationEvent[] = [];
    for (const arr of this.buffers.values()) all.push(...arr);
    all.sort((a, b) => a.ts - b.ts);
    return limit === undefined ? all : all.slice(all.length - limit);
  }

  unreadCount(sessionId?: string): number {
    if (sessionId !== undefined) {
      const arr = this.buffers.get(sessionId) ?? [];
      let n = 0;
      for (const e of arr) if (!e.read) n++;
      return n;
    }
    let n = 0;
    for (const arr of this.buffers.values()) for (const e of arr) if (!e.read) n++;
    return n;
  }

  markRead(sessionId: string): number {
    const arr = this.buffers.get(sessionId);
    if (!arr) return 0;
    let flipped = 0;
    for (const e of arr) {
      if (!e.read) { e.read = true; flipped++; }
    }
    return flipped;
  }

  markAllRead(): number {
    let flipped = 0;
    for (const [sid] of this.buffers) flipped += this.markRead(sid);
    return flipped;
  }

  clear(sessionId: string): void {
    this.buffers.delete(sessionId);
    if (this.persistence) {
      try { this.persistence.dropSession(sessionId); } catch { /* swallow */ }
    }
  }

  clearAll(): void {
    if (this.persistence) {
      for (const sid of this.buffers.keys()) {
        try { this.persistence.dropSession(sid); } catch { /* swallow */ }
      }
    }
    this.buffers.clear();
  }

  subscribe(cb: NotificationSubscriber): () => void {
    this.subs.add(cb);
    return () => { this.subs.delete(cb); };
  }

  sessions(): string[] {
    return [...this.buffers.keys()];
  }
}
