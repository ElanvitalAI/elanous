import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import type { MsgStore } from '../msg/msg-store.js';

export interface SeatMailSnapshot {
  seat: string;
  unread: number | null;
}

const SEAT_IN_PATH = /(?:^|\/)seats\/([A-Za-z][A-Za-z0-9_-]{0,63})(?:\/|$)/;
const SEAT_ID = /^[A-Z][A-Z0-9_-]{0,63}$/;

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
  const seat = (SEAT_IN_PATH.exec(cwd)?.[1] ?? env.COORD_ID ?? '').trim().toUpperCase();
  if (!SEAT_ID.test(seat)) return null;
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
  return snapshot ? `${snapshot.seat} · 우편 ${snapshot.unread ?? '확인 불가'}` : null;
}
