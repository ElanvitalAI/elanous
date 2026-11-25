// ── `eln announce status <announceId|latest> [--scope] [--json]` (ANNOUNCE-UPTAKE) ──
// 공지 하나가 자리마다 어디까지 들어갔나(L0..L5) — 계층(OP · coordinators · hands)별 수. 읽기 전용.
// 종료 코드: 0 = 정상 · 1 = 그 공지가 원장에 없음 · 2 = 인자/원장 오류.
import type { Command } from 'commander';
import { normalizeAnnounceScope } from '../msg/announce.js';
import { announceStatus, formatAnnounceStatus, resolveAnnounceId, type AnnounceTier } from '../msg/announce-status.js';
import { openMsgStore, type MsgStore } from '../msg/msg-store.js';
import { registeredSeats, type SeatEntry } from '../seat-address/seat-address.js';
import { seatRole } from '../seat/seat-role.js';

export interface AnnounceCliDeps {
  openStore?: () => MsgStore;
  seats?: () => readonly SeatEntry[];
  out?: Pick<Console, 'log' | 'error'>;
  setExitCode?: (code: number) => void;
}

/** Federation roles → tier: OP · the coordinator role · every other seat is a hand. */
export function announceTierOf(seat: string, seats: readonly SeatEntry[]): AnnounceTier {
  if (seat.trim().toUpperCase() === 'OP') return 'OP';
  return seatRole(seat, seats) === 'coordinator' ? 'coordinators' : 'hands';
}

export function registerAnnounceCommands(program: Command, deps: AnnounceCliDeps = {}): void {
  const out = deps.out ?? console;
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const announce = program.command('announce').description('Federation announces — how far each seat took one in (uptake levels)');
  announce.command('status <announceId>').description('Per-seat uptake level L0..L5 of one announce (or latest), grouped by tier')
    .option('--scope <scope>', 'federation | coordinators (default: the scope the announce was posted with)')
    .option('--json')
    .action((ref: string, opts: { scope?: string; json?: boolean }) => {
      let store: MsgStore | null = null;
      try {
        const scope = opts.scope === undefined ? undefined : normalizeAnnounceScope(opts.scope);
        const seats = (deps.seats ?? registeredSeats)();
        store = (deps.openStore ?? (() => openMsgStore()))();
        const id = resolveAnnounceId(store.db, ref.trim());
        const status = id === null ? null : announceStatus(store.db, id, {
          tierOf: seat => announceTierOf(seat, seats), allSeats: () => seats.map(seat => seat.id),
        }, scope === undefined ? {} : { scope });
        if (status === null) { out.error(`announce ${ref}: not found in the message ledger`); setExitCode(1); return; }
        if (opts.json) out.log(JSON.stringify(status, null, 2));
        else for (const line of formatAnnounceStatus(status)) out.log(line);
      } catch (error) {
        out.error(`announce status: ${error instanceof Error ? error.message : String(error)}`);
        setExitCode(2);
      } finally { try { store?.close(); } catch { /* read-only use */ } }
    });
}
