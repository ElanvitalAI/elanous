import { lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { seatHandoffStateRoot } from '../memory.js';
import { buildOpHandoffRecall } from '../seat-memory/seat-handoff-recall.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import type { MsgStore } from '../msg/msg-store.js';
import { recordReceiptClock } from '../hq/msg-receipt-clock-sink.js';
import type { ReceiptInput, ReceiptRecordOutcome } from '../msg/msg-receipts.js';
import { type StructuredMessageFields } from '../msg/msg-context-header.js';
import type { NextTuiWakeup } from '../tui-client/next-wakeup.js';
import type { NextTuiSelfHealthSnapshot } from './chat/self-health-status.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../chat/internal-turn-contract.js';
import {
  type SeatPlanStatus,
  wireSeatMailToPlan,
  createSeatPlanFileStore,
  appendSeatPlan,
  type SeatPlanRuntime,
  type SeatPlanQueuePort,
  type SeatPlanLedger,
  type SeatMailPlanWireOptions,
  formatSeatMailPrompt,
} from './seat-mail-plan.js';
// ELN-PLAN-WIRE-SEAT plan wiring lives in seat-mail-plan.ts (size-contract: 600-line module limit); importers keep this path.
export * from './seat-mail-plan.js';
// size-contract: src/tui 는 dashboard 모듈을 import 하지 않는다(chat 계약 import 는 허용 —
// src/tui/input/internal-turn.ts 도 같은 정본을 쓴다). 게이트 인자·결과는 정본 타입을 그대로 쓴다.

export interface SeatMailSnapshot {
  seat: string;
  unread: number | null;
}

/** The OP first-turn handoff shares the seat boot's home and isolated state root. */
export function readSeatHandoffBootPrompt(seat: string, home: string, now: Date, env: NodeJS.ProcessEnv = process.env): string | null {
  if (seat !== 'OP') return null;
  const stateRoot = seatHandoffStateRoot(home, env);
  const trustedBase = stateRoot === join(home, 'elanous-hq', 'seat-state') ? home : dirname(stateRoot);
  return buildOpHandoffRecall(stateRoot, now, trustedBase);
}

const OP_ROLE_PACK_PATH = join(import.meta.dir, '..', '..', 'seats', 'OP-ELN', 'ROLE-PACK.md');
const OP_ROLE_PACK_MAX_BYTES = 32 * 1024;

/** Packaged OP instructions reach the same first-turn system message as the seat boot card. */
export function readOpRolePackBootPrompt(seat: string): string | null {
  if (seat !== 'OP') return null;
  try {
    const info = lstatSync(OP_ROLE_PACK_PATH);
    if (!info.isFile() || info.size > OP_ROLE_PACK_MAX_BYTES) return '⚠ OP-ELN ROLE-PACK 확인 실패: 팩 형식 또는 크기 오류. 권한 효과를 실행하지 말고 OP에 보고하라.';
    const body = readFileSync(OP_ROLE_PACK_PATH, 'utf8').trim();
    if (!body.startsWith('# OP-ELN ROLE-PACK')) return '⚠ OP-ELN ROLE-PACK 확인 실패: 팩 머리말 오류. 권한 효과를 실행하지 말고 OP에 보고하라.';
    return body;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return `⚠ OP-ELN ROLE-PACK 확인 실패: ${code === 'ENOENT' ? '설치본에 팩 없음' : '읽기 오류'}. 권한 효과를 실행하지 말고 OP에 보고하라.`;
  }
}

const SEAT_IN_PATH = /(?:^|\/)seats\/([A-Za-z][A-Za-z0-9_-]{0,63})(?=\/|$)/g;
const SEAT_ID = /^[A-Z][A-Z0-9_-]{0,63}$/;

/** cwd 의 `seats/<id>` 경로(없으면 COORD_ID)에서 자리 id 를 뽑는다 — 못 뽑으면 null. */
export function resolveSeatId(
  cwd: string,
  deps: { env?: NodeJS.ProcessEnv } = {},
): string | null {
  const env = deps.env ?? process.env;
  const seat = ([...cwd.matchAll(SEAT_IN_PATH)].at(-1)?.[1] ?? env.COORD_ID ?? '').trim().toUpperCase();
  return SEAT_ID.test(seat) ? seat : null;
}

/** A small, read-only snapshot for the next TUI's first frame. */
export function readSeatMailSnapshot(
  cwd: string,
  deps: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    msgPath?: string;
  } = {},
): SeatMailSnapshot | null {
  const env = deps.env ?? process.env;
  // A seat can run an isolated checkout whose path contains another seats/ segment.
  // The innermost segment names the current seat, not the parent workspace —
  // resolveSeatId 가 같은 판정(내측 segments 우선·COORD_ID 폴백)을 수행한다.
  const seat = resolveSeatId(cwd, { env });
  if (seat === null) return null;
  const seatDir = join(deps.home ?? homedir(), 'elanous-hq', 'seat-state', seat);
  try {
    if (!statSync(seatDir).isDirectory()) return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return { seat, unread: null };
  }
  const msgPath = deps.msgPath ?? join(elanousStateRoot(), 'msg', 'messages.db');
  try {
    statSync(msgPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { seat, unread: code === 'ENOENT' ? 0 : null };
  }
  // Loading MsgStore is only needed when there is an existing ledger to read.
  // A damaged or inaccessible ledger must not prevent the TUI from booting.
  try {
    const msg = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
    const store: MsgStore = new msg.MsgStore(msgPath, { readOnly: true });
    try {
      return { seat, unread: store.unreadCount(seat) };
    } finally {
      store.close();
    }
  } catch {
    return { seat, unread: null };
  }
}

export function seatMailLine(snapshot: SeatMailSnapshot | null): string | null {
  return snapshot ? `${snapshot.seat} · mail ${snapshot.unread ?? 'unknown'}${snapshot.unread !== null && snapshot.unread > 100 ? ' ⚠ over 100' : ''}` : null;
}

// ── ELN-SEAT-INBOX-TURN-BOUNDARY — 턴 경계 우편 자동 수신 ───────────────────────────
// 턴이 settle 하는 순간에만 잰다(진행 턴 비중단 = 구조적 보장). 주입은 오직 H2 문
// startTurnIfIdle 경로(대표 비침투: 입력칸 버퍼·injectKey·pty 0). 본문은 전문 주입한다(잘림 0 —
// mustFix ①). ack 는 «처리 뒤» — 주입 턴이 아니라 그 턴이 끝난 다음 경계의 check() 에서
// pendingAck 집합을 ackMessage+advanceCursor 한다. 거부(NotIdle 등)면 ack 안 하고 다음 경계에 재시도.

export interface SeatMailItem extends StructuredMessageFields { id: number; from: string; body: string; kind?: string; }

export interface SeatMailInboxStore {
  getCursor(recipient: string): number;
  listByRecipient(recipient: string, after?: number, limit?: number): SeatMailItem[];
  advanceCursor(recipient: string, cursor: number): number;
  ackMessage(recipient: string, messageId: number, status?: 'acked' | 'done'): boolean;
  /**
   * SEAT-INBOX B1-C — 클래식 대시보드엔 입력 큐가 없다. 그래서 delivered = 주입 턴이 열림 · seen = 그 턴이
   * 끝난 경계(기존 «처리 뒤 ack» 시점). 없으면(옛 가짜 원장) 영수증 없이 지금 동작 그대로.
   */
  recordReceipt?(input: ReceiptInput): ReceiptRecordOutcome;
  db?: MsgStore['db'];
  close(): void;
}

export interface SeatMailInboxDeps {
  seat: string;
  msgPath: string;
  startTurnIfIdle: (input: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
  openStore?: (path: string) => SeatMailInboxStore;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  defer?: (fn: () => void, ms: number) => void;
  /** §2b 박동(선택) — 주입한 경우에만 alive beat를 30초마다 쓴다. 주입 없으면 파일 시스템에 아무 것도 쓰지 않는다(기존 시험 오염 방지). */
  /** §2b inbox heartbeat — alivePath/host · 세션 id 공급(OP #93799): sessionId 정적 값 또는 getSessionId 지연 공급원. */
  heartbeat?: { alivePath?: string; host?: string; intervalMs?: number; sessionId?: string; getSessionId?: () => (string | null) };
}

export interface SeatMailInboxController {
  noteTurnEnded(): void;
  check(): { delivered: boolean; count: number; rejected?: string };
  stop(): void;
}

/** Receipt writes never change delivery — a failure is a log line (fail-soft). */
function tryReceipt(store: SeatMailInboxStore, input: ReceiptInput, log: (category: string, event: string, data: Record<string, unknown>) => void): void {
  if (!store.recordReceipt) return;
  try { store.recordReceipt(input); } catch (e) {
    log('msg.receipt-writer', 'record-failed', { msgId: input.messageId, recipient: input.recipient, state: input.state, message: String(e) });
  }
}

export function createSeatMailInbox(deps: SeatMailInboxDeps): SeatMailInboxController {
  const log = deps.log ?? (() => {});
  const defer = deps.defer ?? ((fn) => { const t = setTimeout(fn, 0); (t as { unref?: () => void }).unref?.(); });
  // MsgStore 는 import type 으로만 들여왔으므로 값 생성은 require 로 — readSeatMailSnapshot(64줄)과 동일 패턴.
  const openStore = deps.openStore ?? ((path: string) => {
    const mod = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
    return new mod.MsgStore(path) as unknown as SeatMailInboxStore;
  });
  let armed = false;
  const pendingAck = new Set<number>();
  // §2b 박동(선택) — 주입 없으면 파일 시스템에 아무 것도 쓰지 않는다. 실패는 fail-soft(인박스 부재로 부팅이 막히지 않게).
  const hb = (() => {
    if (!deps.heartbeat) return null;
    try {
      const { startInboxHeartbeat } = require('../loops/inbox-liveness.js') as typeof import('../loops/inbox-liveness.js');
      const path = deps.heartbeat.alivePath;
      if (!path) return null;
      return startInboxHeartbeat(path, { pid: process.pid, host: deps.heartbeat.host ?? 'unknown', sessionId: deps.heartbeat.sessionId ?? '' }, {
        ...(deps.heartbeat.intervalMs !== undefined ? { intervalMs: deps.heartbeat.intervalMs } : {}),
        ...(deps.heartbeat.getSessionId ? { getSessionId: deps.heartbeat.getSessionId } : {}),
        ...(deps.log ? { log: (event, data) => log('tui.seat-mail-inbox', event, data ?? {}) } : {}),
      });
    } catch { return null; }
  })();

  const check: SeatMailInboxController['check'] = () => {
    if (!armed) return { delivered: false, count: 0 };
    armed = false;
    let store: SeatMailInboxStore;
    try { store = openStore(deps.msgPath); } catch (e) { log('tui.seat-mail-inbox', 'store-error', { seat: deps.seat, message: String(e) }); return { delivered: false, count: 0 }; }
    try {
      // ── 1단계: 이전 턴에 주입했던 우편을 «처리 뒤» 여기서 ack(mustFix ①).
      // 주입 턴이 끝나 이 경계에 도달했으므로 모델이 본문을 받아 처리할 기회는 지났다.
      if (pendingAck.size > 0) {
        let ackMax = 0;
        for (const id of pendingAck) {
          // B1-C — seen 영수증(호환 ack 도 같이 쓴다) 뒤에 기존 ack. 영수증이 없거나 실패해도 ack 는 그대로.
          tryReceipt(store, { messageId: id, recipient: deps.seat, state: 'seen', source: 'dashboard-inbox' }, log);
          try { store.ackMessage(deps.seat, id, 'acked'); } catch { /* 자기 ALL 방송 등 — 커서로 덮음 */ }
          if (id > ackMax) ackMax = id;
        }
        try { store.advanceCursor(deps.seat, ackMax); } catch { /* 단조 위반 아님 — 무시 */ }
        log('tui.seat-mail-inbox', 'acked-after-turn', { seat: deps.seat, count: pendingAck.size, maxId: ackMax });
        pendingAck.clear();
      }
      // ── 2단계: 커서 이후 새 우편을 전문 주입. 커서는 옮기지 않는다(다음 경계 ack).
      const cursor = store.getCursor(deps.seat);
      const batch = store.listByRecipient(deps.seat, cursor).sort((a, b) => a.id - b.id);
      if (batch.length === 0) return { delivered: false, count: 0 };
      const maxId = batch[batch.length - 1]!.id;
      const result = deps.startTurnIfIdle(formatSeatMailPrompt(deps.seat, batch), {
        origin: 'msg-wake', reason: `seat-mail-inbox: 우편 ${batch.length}통`,
      });
      if (!result.opened) {
        log('tui.seat-mail-inbox', 'rejected', { seat: deps.seat, count: batch.length, reason: result.reason });
        return { delivered: false, count: batch.length, rejected: result.reason };
      }
      for (const m of batch) {
        pendingAck.add(m.id);
        tryReceipt(store, { messageId: m.id, recipient: deps.seat, state: 'delivered', source: 'dashboard-inbox' }, log);
        if (store.db) recordReceiptClock(store.db, { messageId: m.id, recipient: deps.seat, event: 'started', eventId: result.turnId });
      }
      log('tui.seat-mail-inbox', 'delivered', { seat: deps.seat, count: batch.length, maxId, turnId: result.turnId });
      return { delivered: true, count: batch.length };
    } finally { try { store.close(); } catch { /* fail-soft */ } }
  };

  return {
    noteTurnEnded() { armed = true; defer(() => { try { check(); } catch { /* fail-soft */ } }, 0); },
    check,
    stop() { try { hb?.stop(); } catch { /* fail-soft */ } /* 원격 구독 경로 제거(mustFix ②) */ },
  };
}

export type SeatMailWatchStatus = 'stopped' | 'starting' | 'running' | 'read-error' | 'start-error';

/** Register the seat branch once at boot; project current watcher health on each render. */
export function createSeatMailHeaderHook(
  cwd: string,
  deps: Parameters<typeof readSeatMailSnapshot>[1] = {},
  plan?: { status(): SeatPlanStatus | null } | null,
  watcher?: { getStatus(): SeatMailWatchStatus } | null,
): (health: NextTuiSelfHealthSnapshot | null, wakeup: Pick<NextTuiWakeup, 'headline'> | null) => string | null {
  const snapshot = readSeatMailSnapshot(cwd, deps);
  const mail = seatMailLine(snapshot) ?? (resolveSeatId(cwd, { env: deps.env })
    ? '⚠ mail watch not bound: no seat-state for this folder' : null);
  return (health, wakeup) => {
    let watchLine: string | null = null;
    if (mail && watcher) {
      let status: SeatMailWatchStatus;
      try { status = watcher.getStatus(); } catch { status = 'read-error'; }
      if (status === 'read-error' || status === 'start-error') watchLine = `⚠ mail watch error: ${status}`;
      else if (status === 'starting' || status === 'stopped') watchLine = `mail watch ${status}`;
    }
    const mailWithWatch = watchLine ? `${mail} · ${watchLine}` : mail;
    const line = mailWithWatch && wakeup ? `${mailWithWatch} · ${wakeup.headline(health)}` : mailWithWatch;
    return plan ? appendSeatPlan(line, plan.status()) : line;
  };
}


/**
 * TUI boot wiring: the real mail ledger (opened per call and closed again — mail that arrives after boot is absorbed on the next
 * call), the real prompt queue, a per-seat plan file. A cwd that is not a seat builds nothing.
 */
export function createSeatMailPlanRuntime(
  options: Readonly<{
    cwd: string;
    deps?: Parameters<typeof readSeatMailSnapshot>[1];
    queue: SeatPlanQueuePort;
    /** Plan file directory (default: the state root's `seat-plans`). */
    planDir?: string;
    /** The seat's one mail owner — the same instance the notice watcher gets (entry.ts). */
    mailAdapter?: SeatMailPlanWireOptions['mailAdapter'];
  }>,
): { header: ReturnType<typeof createSeatMailHeaderHook>; runtime: SeatPlanRuntime | null } {
  const snapshot = readSeatMailSnapshot(options.cwd, options.deps ?? {});
  if (!snapshot || snapshot.unread === null) return { header: createSeatMailHeaderHook(options.cwd, options.deps ?? {}), runtime: null };
  let runtime: SeatPlanRuntime | null = null;
  try {
    const msg = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
    const withLedger = <T>(fn: (store: MsgStore) => T, fallback: T): T => {
      let store: MsgStore | undefined;
      try {
        store = new msg.MsgStore(resolveMsgPath(options.deps), { readOnly: true });
        return fn(store);
      } catch { return fallback; } finally { store?.close(); }
    };
    const ledger: SeatPlanLedger = {
      list: (recipient, after, limit) => withLedger(store => store.list(recipient, after, limit), []),
      getCursor: recipient => withLedger(store => store.getCursor(recipient), 0),
      getMessage: id => withLedger(store => store.getMessage(id), null),
    };
    const planFile = join(options.planDir ?? join(elanousStateRoot(), 'seat-plans'), `${snapshot.seat}.json`);
    const recordReceipts = (inputs: readonly ReceiptInput[]): void => {
      // One writable open per batch (the read path stays read-only); each receipt fails on its own, loudly.
      const store = new msg.MsgStore(resolveMsgPath(options.deps));
      try {
        for (const input of inputs) {
          try { store.recordReceipt(input); }
          catch (error) {
            // Same fields as the batch-level warn (seat · source · msgIds · state) — one shape to search for (#38376 Terra ①).
            try { debug.log('msg.receipt-writer', 'record-failed', { seat: snapshot.seat, source: input.source, msgIds: [input.messageId], state: input.state, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
            catch { /* observability is fail-open */ }
          }
        }
      } finally { store.close(); }
    };
    runtime = wireSeatMailToPlan(options.queue, { seat: snapshot.seat, ledger, store: createSeatPlanFileStore(planFile), recordReceipts,
      ...(options.mailAdapter ? { mailAdapter: options.mailAdapter } : {}) });
    runtime.absorb();
  } catch {
    runtime = null; // boot continues without a plan (ledger missing or damaged)
  }
  return { header: createSeatMailHeaderHook(options.cwd, options.deps ?? {}, runtime), runtime };
}

/** Ledger path — the same rule as readSeatMailSnapshot (an explicit msgPath first, else the state root). */
function resolveMsgPath(deps: Parameters<typeof readSeatMailSnapshot>[1] | undefined): string {
  return deps?.msgPath ?? join(elanousStateRoot(), 'msg', 'messages.db');
}
