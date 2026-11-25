// SEAT-TURN-FOLLOWUPS Q10 — leaders below HQ (space leads ⊕ kingdom seats) get a leader card, not the hand coding profile.
//
// S: seatRole() knows only coordinator|hand (coord-tracks.json): OP gets the coordinator profile; space leads (TC/UX/MK) get
//    the hand «coding lifecycle» profile and kingdom seats (JUD/RES/REL) get no seat contract at all.
// C: a leader owns a space's outcomes — board, ✋, steward exception cards, rollup — which no hand prompt says.
// A: resolve the leadership from the federation declaration (federation.yaml `spaces.<X>.coordinator`), the kingdom seats,
//    and coord-tracks.json `role: lead` as fallback. HQ (the declared hq coordinator / role coordinator) is not a leader here.
import { registeredSeats, type SeatEntry } from '../seat-address/seat-address.js';

export type SeatLeadership =
  | { readonly kind: 'space'; readonly seat: string; readonly space: string }
  | { readonly kind: 'kingdom'; readonly seat: string; readonly kingdom: 'JUD' | 'RES' | 'REL' };

/** The kingdom seats (judiciary · resources · release) — the lead seat id of each kingdom. */
export const KINGDOM_LEAD_SEATS: Readonly<Record<string, 'JUD' | 'RES' | 'REL'>> = { JUD: 'JUD', RES: 'RES', REL: 'REL' };

export interface LeadershipSources {
  /** federation.yaml spaces (name → coordinator seat) and the declared HQ coordinator. */
  readonly spaces?: Readonly<Record<string, { readonly coordinator: string }>>;
  readonly hq?: string | null;
  /** coord-tracks.json rows (fallback · `role: "lead"`). */
  readonly seats?: readonly SeatEntry[];
}

/** Pure: the seat's leadership, or null (HQ · hand · unknown). */
export function seatLeadership(seat: string | null | undefined, src: LeadershipSources): SeatLeadership | null {
  const id = seat?.trim().toUpperCase();
  if (!id) return null;
  const hq = src.hq?.trim().toUpperCase() || 'OP';
  const row = (src.seats ?? []).find((entry) => entry.id.toUpperCase() === id);
  if (id === hq || row?.role === 'coordinator') return null;
  const kingdom = KINGDOM_LEAD_SEATS[id];
  if (kingdom) return { kind: 'kingdom', seat: id, kingdom };
  for (const [space, decl] of Object.entries(src.spaces ?? {})) {
    if (decl.coordinator.trim().toUpperCase() === id) return { kind: 'space', seat: id, space };
  }
  if (row?.role === 'lead') return { kind: 'space', seat: id, space: id };
  return null;
}

/** Live: federation.yaml (via the els workspace reader) ⊕ coord-tracks.json. Fail-open → null. */
export function liveSeatLeadership(seat: string | null | undefined, cwd: string = process.cwd()): SeatLeadership | null {
  let spaces: Record<string, { coordinator: string }> | undefined;
  let hq: string | undefined;
  try {
    const { readWorkspaceFile } = require('../els/workspace-config.js') as typeof import('../els/workspace-config.js');
    const { homedir } = require('node:os') as typeof import('node:os');
    const decl = readWorkspaceFile(cwd, homedir());
    if (decl.path && decl.config) { spaces = decl.config.spaces; hq = decl.config.hq?.coordinator; }
  } catch { /* an unreadable declaration declares nothing */ }
  let seats: readonly SeatEntry[] = [];
  try { seats = registeredSeats(); } catch { seats = []; }
  return seatLeadership(seat, { ...(spaces ? { spaces } : {}), ...(hq ? { hq } : {}), seats });
}
