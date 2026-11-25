/**
 * Seat-mail arrival wiring, pulled out of entry.ts so the busy/idle door is a seam.
 * A notice that lands while a turn is running stays queued. The idle door (injectKey)
 * opens only when nothing is running. This path never offers the running turn a steer.
 *
 * OP #106762 ⓐ — a mail that lands during a busy turn carries its real notice text
 * (본문 원문 · msgId · 보낸 자리) into the mid-turn event box; the moment the box accepts it,
 * the queued notice is removed from the original queue, so the same msgId surfaces
 * exactly once per session and nothing re-opens a later turn (N03-SEED7 — 접수 시점 즉시 제거).
 */

import { emitTurnLife } from '../debug/turn-life.js';
import type { SeatMailArrivalInfo } from './seat-mail-arrival.js';
import { SEAT_MAIL_COALESCE_MS } from './seat-mail-digest.js';
import type { FloodMeter } from './seat-mail-flood.js';

export interface SeatMailOnArrivedDeps {
  busy: () => boolean;
  injectKey: (key: unknown) => boolean | void;
  queueWake: unknown;
  /**
   * SEAT-TURN-MIDTURN-MAIL 어댑터 — 턴 중 도착은 이벤트함에 한 건(id = ledger msgId).
   * 접수 성립(true) 즉시 이 모듈이 원본 큐 노티스 제거를 호출한다(N03-SEED7 — 이중 배달 창 폐쇄).
   */
  enqueueMidTurn?: (event: { kind: string; id: string; text: string; from?: string; intent?: string | null; crownDirective?: string | null; originKind?: string | null; viaLedger?: boolean }, onDrained?: () => void) => boolean;
  /** OP #106762 ⓐ — 이벤트함이 접수한 건의 대기 큐 노티스를 접수 시점에 지운다(fail-open · 지운 건수를 돌려준다). */
  removeQueuedNotice?: (match: { source: string; msgId?: number; text?: string }) => number;
  /**
   * SEAT-MAIL-COALESCE-NOTICE — the idle-door debounce. Given, an idle arrival knocks once after
   * {@link SEAT_MAIL_COALESCE_MS}; every arrival inside that window rides the same knock (one bundle · one turn).
   * Absent = knock at once (unit seams).
   */
  schedule?: (fn: () => void, ms: number) => unknown;
  /**
   * SEAT-MAIL-FLOOD (Q9) — a seat's flood meter. In flood only crown · human · ✋ · alert · P0 open a turn or ride the
   * running one; every other mail stays queued for the next turn's digest (never dropped). Absent = no flood rule.
   */
  flood?: FloodMeter;
  now?: () => number;
}

export function seatMailOnArrived(deps: SeatMailOnArrivedDeps): (arrivals?: readonly SeatMailArrivalInfo[]) => void {
  let knockPending = false;
  const knock = (): void => {
    if (!deps.schedule) { deps.injectKey(deps.queueWake); return; }
    if (knockPending) return;
    knockPending = true;
    deps.schedule(() => { knockPending = false; deps.injectKey(deps.queueWake); }, SEAT_MAIL_COALESCE_MS);
  };
  return (rawArrivals) => {
    // SEAT-MAIL-FLOOD — count the turn-opening arrivals; in flood, ordinary mail is folded to the digest (marked passive here).
    const at = (deps.now ?? Date.now)();
    const arrivals = rawArrivals === undefined || !deps.flood ? rawArrivals : rawArrivals.map((arrival) => {
      if (arrival.passive === true || arrival.msgId === undefined) return arrival;
      const verdict = deps.flood!.note(arrival, at);
      return verdict.open ? arrival : { ...arrival, passive: true };
    });
    if (deps.busy()) {
      // OBSERVE-TURN-EVENT-LIFECYCLE — 바쁜 턴: 원문은 이벤트함에, 큐 노티스는 접수 시점에 지운다(이 모듈은 관측만).
      const msgIds = (arrivals ?? []).flatMap((arrival) => (arrival.msgId === undefined ? [] : [arrival.msgId]));
      try {
        emitTurnLife('turn-life:event-while-busy', { source: 'seat-mail', action: 'wait', ...(msgIds.length === 0 ? {} : { msgIds }) });
      } catch { /* observability is fail-open */ }
      for (const arrival of arrivals ?? []) {
        // 수 모드 노티스엔 msgId 가 없다 — 세션 1회 계약을 못 세우니 턴 끝 노크에 맡긴다.
        if (arrival.msgId === undefined) continue;
        // SEAT-MAIL-COALESCE-NOTICE — info mail is not carried into the running turn: it waits for the next digest.
        if (arrival.passive === true) continue;
        // JUD security HOLD: no sender (OP · 대표) preempts — `--from` is not authenticated. Every mail, decisions
        // included, rides the same mid-turn event box in arrival (msgId) order.
        const accepted =
          deps.enqueueMidTurn?.(
            { kind: 'seat-mail', id: String(arrival.msgId), text: arrival.text,
              ...(arrival.sender === undefined ? {} : { from: arrival.sender }), ...(arrival.intent === undefined ? {} : { intent: arrival.intent }),
              ...(arrival.crownDirective ? { crownDirective: arrival.crownDirective } : {}), ...(arrival.origin?.kind ? { originKind: arrival.origin.kind } : {}),
              // FED-MAIL-WORK-ORDER — every arrival with a msgId was read from the local ledger by the watcher.
              viaLedger: true },
          ) ?? false;
        // N03-SEED7 (OP #140613) — 이벤트함이 접수한 건은 «접수 시점»에 원본 큐 노티스를 내놓는다: 배수 때까지
        // 큐에 남아 있으면 busy→idle 전환 뒤 큐 노크가 같은 msgId 로 턴을 하나 더 열어, 같은 우편이 두 모델
        // 요청에 실린다(node-b c4 seed7 실측 «urgent mail missed its short turn» · urgent turns 2 · 2회 재현).
        // 세션 1회 계약(머리 주석)을 enqueue 시점에 강제한다. 이벤트함 거부(false)만 원본 큐 폴백으로 남는다.
        if (accepted && deps.removeQueuedNotice !== undefined) {
          deps.removeQueuedNotice({ source: 'seat-mail', msgId: arrival.msgId });
        }
      }
      return;
    }
    // SEAT-MAIL-COALESCE-NOTICE — info mail alone opens no turn (it rides the next digest or the passive wake window).
    if (arrivals !== undefined && arrivals.length > 0 && arrivals.every((arrival) => arrival.passive === true)) return;
    knock();
  };
}
