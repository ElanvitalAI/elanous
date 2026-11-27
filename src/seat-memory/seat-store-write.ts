/**
 * SEAT-MEMORY-SYNC (CEO 11-26 18:3x · 내부 문서 `CLAUDE-OP-PROXY` §A3) — a CLI path into a named seat store.
 *
 * S: Claude OP shares context with eln OP by hand-writing files into `<memoryRoot>/seats/OP/` (MEMORY.md drifts).
 * C: `eln memory add` writes the store its cwd/ELANOUS_TRACK resolves to; a seat must not write another seat's store.
 * Q: how does a caller write a named seat store (and the proxy its daily session summary) through the store's own writer?
 * A: `--seat <SEAT>` targets `seatMemoryDir(SEAT)` through `saveSeatMemory` (MEMORY.md index upserted once). Allowed:
 *    the caller's own seat, and OP when the caller is CLAUDE-OP (the CEO's proxy). `sync-proxy` writes one entry
 *    `proxy-session-<YYYY-MM-DD>` (type project · `source: CLAUDE-OP`) — the same day replaces it.
 *    (CLAUDE-OP-PROXY-IDENTITY · PR 2 tightens the CLAUDE-OP case to the verified, process-bound proxy credential.)
 *
 * 세 얼굴: 관측 = saveSeatMemory's `memory.saved` log ⊕ the CLI line naming the store · 인지 = seatWriteAuthority (pure) ·
 *          수복과 인계 = a refusal names the allowed targets.
 */
import { normalizeSeat, saveSeatMemory, seatMemoryDir, type SeatMemorySaveResult } from './seat-memory.js';

/** The CEO's proxy seat, and the one other store it may write. */
export const PROXY_SEAT = 'CLAUDE-OP';
export const PROXY_TARGET_SEAT = 'OP';

export type SeatWriteAuthority =
  | { readonly ok: true; readonly seat: string; readonly via: 'own' | 'proxy' }
  | { readonly ok: false; readonly line: string };

/**
 * May `caller` write `target`'s store? `target` must be a plain seat id (no path parts). Own seat → yes. CLAUDE-OP → OP
 * as well. Anyone else → refused (another seat's store).
 */
export function seatWriteAuthority(input: { readonly target: string; readonly caller: string | null | undefined }): SeatWriteAuthority {
  const raw = input.target ?? '';
  const seat = normalizeSeat(raw);
  if (!seat || seat !== raw.toUpperCase() || seat.startsWith('_')) return { ok: false, line: `memory: invalid --seat ${JSON.stringify(raw)} (a seat id: A-Z first, then A-Z 0-9 _ -)` };
  const caller = normalizeSeat(input.caller ?? '');
  if (!caller) return { ok: false, line: `memory: --seat ${seat} needs a caller seat (ELANOUS_TRACK, --from, or a seats/<SEAT> directory)` };
  if (caller === seat) return { ok: true, seat, via: 'own' };
  if (caller === PROXY_SEAT && seat === PROXY_TARGET_SEAT) return { ok: true, seat, via: 'proxy' };
  return { ok: false, line: `memory: ${caller} may not write the ${seat} seat store (own seat only · ${PROXY_SEAT} may also write ${PROXY_TARGET_SEAT})` };
}

/** `proxy-session-YYYY-MM-DD` in the host's local calendar day. */
export function proxySessionName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `proxy-session-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** The one daily proxy session entry: same name each day → the second sync of a day updates the first. */
export function syncProxySession(input: { readonly body: string; readonly now?: Date; readonly dir?: string; readonly base?: string }): SeatMemorySaveResult {
  const now = input.now ?? new Date();
  const name = proxySessionName(now);
  const dir = input.dir ?? seatMemoryDir(PROXY_TARGET_SEAT, input.base);
  return saveSeatMemory({
    name,
    description: `Claude OP session summary ${name.slice('proxy-session-'.length)} — CEO requests → status (source CLAUDE-OP)`,
    type: 'project',
    body: input.body,
    source: PROXY_SEAT,
  }, dir, PROXY_TARGET_SEAT, { origin: 'memory-cli.sync-proxy' });
}
