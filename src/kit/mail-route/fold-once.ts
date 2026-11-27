// KIT mail-route · fold-once — a mail id is folded into a seat's turn ONCE, whichever path folds it first.
//
// S: 11-27 «다이제스트 경로 둘» — the TUI idle bundle (tui/seat-mail-digest) and the repl mid-turn path (chat/interjection)
//    bundled and acked on their own: the same mail reached OP twice in two digests.
// A: every digest path claims the ids it is about to list; an id already claimed for this seat is not listed again (one
//    «already in an earlier digest» line keeps the turn honest). The ledger is per seat, kept for one day, optionally
//    mirrored to `<state>/msg/diverted/digest-claims/<SEAT>.json` so a second process for the same seat sees the claims.
//    Nothing is dropped: claiming changes what is LISTED, never what is acked or stored.
//
// 세 얼굴: 관측 = claim() returns {fresh, repeat} (callers log `msg.fold-once`) · 판단 근거 = the claimed-id map ·
// 수복과 인계 = fail-open — a ledger that cannot read or write lists everything (a repeat beats a lost mail).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';

export const MAIL_FOLD_KEEP_MS = 24 * 60 * 60_000;
const MAX_IDS = 5_000;

export interface MailFoldClaim { readonly fresh: number[]; readonly repeat: number[] }

export interface MailFoldLedger {
  readonly seat: string;
  /** Claim ids for listing now: ids not seen before are `fresh` (and now claimed); the rest are `repeat`. */
  claim(ids: readonly number[]): MailFoldClaim;
  /** Has this id been folded already? */
  has(id: number): boolean;
}

export interface MailFoldLedgerOptions {
  readonly now?: () => number;
  /** Mirror file (absent = in-memory only). */
  readonly file?: string | null;
  readonly keepMs?: number;
}

export function mailFoldFile(seat: string, root: string = join(elanousStateRoot(), 'msg', 'diverted')): string {
  return join(root, 'digest-claims', `${seat.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_')}.json`);
}

export function createMailFoldLedger(seat: string, opts: MailFoldLedgerOptions = {}): MailFoldLedger {
  const now = opts.now ?? Date.now;
  const keepMs = opts.keepMs ?? MAIL_FOLD_KEEP_MS;
  const file = opts.file ?? null;
  const mem = new Map<number, number>();
  const load = (): void => {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) { const id = Number(k); if (Number.isSafeInteger(id) && typeof v === 'number') mem.set(id, Math.max(mem.get(id) ?? 0, v)); }
    } catch { /* absent or unreadable: in-memory claims only */ }
  };
  const prune = (at: number): void => {
    for (const [id, t] of mem) if (at - t >= keepMs) mem.delete(id);
    if (mem.size > MAX_IDS) for (const id of [...mem.keys()].sort((a, b) => mem.get(a)! - mem.get(b)!).slice(0, mem.size - MAX_IDS)) mem.delete(id);
  };
  const save = (): void => {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(mem)));
      renameSync(tmp, file);
    } catch { /* fail-open: the next claim in this process still sees memory */ }
  };
  return {
    seat: seat.trim().toUpperCase(),
    claim(ids) {
      const at = now();
      load();
      prune(at);
      const fresh: number[] = [];
      const repeat: number[] = [];
      for (const id of ids) {
        if (!Number.isSafeInteger(id)) continue;
        if (mem.has(id)) { if (!repeat.includes(id)) repeat.push(id); continue; }
        if (fresh.includes(id)) continue;
        fresh.push(id);
      }
      for (const id of fresh) mem.set(id, at);
      if (fresh.length) save();
      return { fresh, repeat };
    },
    has(id) { load(); prune(now()); return mem.has(id); },
  };
}

let active: MailFoldLedger | null = null;

/** The seat process turns fold-once on at boot (the TUI). Unset = every path lists everything (tests · member chat). */
export function activateMailFold(ledger: MailFoldLedger | null): void { active = ledger; }
export function activeMailFold(): MailFoldLedger | null { return active; }
