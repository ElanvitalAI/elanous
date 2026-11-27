/** Live seat surge observation. All I/O is injectable for isolated simulations. */
import { divertedSince } from './diverted-mail.js';
import { assessSeatSurge, SEAT_SURGE_WINDOW_MS, type SeatSurgeEvent, type SeatSurgeStatus } from './seat-surge-monitor.js';
import type { MsgStore } from './msg-store.js';

export function readSeatSurge(store: MsgStore, seat: string, now: number, root?: string): SeatSurgeStatus {
  const rows = store.db.query(`SELECT sender, recipient, created_at FROM msg_messages
    WHERE (sender = ? OR recipient = ?) AND created_at >= ? AND created_at <= ?
      AND NOT (kind = 'notice' AND body LIKE '[seat-surge] %') ORDER BY created_at, id`)
    .all(seat, seat, new Date(now - SEAT_SURGE_WINDOW_MS).toISOString(), new Date(now).toISOString()) as Array<{ sender: string; recipient: string; created_at: string }>;
  const events: SeatSurgeEvent[] = rows.map((r) => ({ type: 'mail', from: r.sender, to: r.recipient, at: Date.parse(r.created_at) }));
  for (const wake of divertedSince('self-wake', seat, 0, root).entries) events.push({ type: 'self-wake', seat, at: Date.parse(wake.at) });
  return assessSeatSurge(seat, events, now);
}

/** Per-TUI cooldown; failed actions are retried independently on the next tick. */
export function createSeatSurgeWatcher(deps: {
  seat: string; coordinator: () => string; now?: () => number;
  read: (now: number) => SeatSurgeStatus;
  selfCheck: (prompt: string) => boolean;
  notify: (to: string, body: string) => boolean;
  status?: (line: string) => void;
}) {
  let checkAt = -Infinity, noticeAt = -Infinity;
  return {
    tick(): SeatSurgeStatus {
      const now = deps.now?.() ?? Date.now();
      const status = deps.read(now);
      const detail = `30분 자가깨움 ${status.selfWakes} · 발신 ${status.sent} · 수신 ${status.received} · 왕복 ${status.pingPong.map((p) => `${p.peer}:${p.alternations}`).join(', ') || '-'} · 초과 ${status.triggers.join(', ') || '-'}`;
      deps.status?.(`자리 급증: ${detail}`);
      if (!status.triggers.length) return status;
      if (now - checkAt >= SEAT_SURGE_WINDOW_MS && deps.selfCheck(`[자리 급증 자가점검] ${detail}. 반복 깨움과 우편 왕복의 원인을 확인하고 중복을 멈춘 뒤 실질적 다음 행동을 진행하라.`)) checkAt = now;
      if (now - noticeAt >= SEAT_SURGE_WINDOW_MS) {
        const to = deps.coordinator();
        if (to && to !== deps.seat && deps.notify(to, `[seat-surge] ${deps.seat}: ${detail}. 자가점검을 시도합니다.`)) noticeAt = now;
      }
      return status;
    },
  };
}
