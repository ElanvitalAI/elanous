// TUI sidetab → els rows: what `/side send` and `/side read` do when the selected row is an els pane (this host's, a
// registered host's, or herdr's). The old sidetab input path is bound to the PTY manifest (ptyId · ownerPid · takeover);
// an els row has none of that — its identity is the address `host:ws/tab/pane`, and its input door is `els do` (marked
// «⇢ from · text», queued while the pane's turn runs, refused for a busy herdr pane). Nothing here writes a PTY itself.
import type { ElsResult } from '../../els/core.js';
import type { SidetabRow } from '../../sidetab-core/model.js';

const ELS_ROW_PREFIX = 'els:';

/** The els address of a selected row, or undefined for any other row (an `els-host:` «down» line has no address). */
export function elsAddressOfRow(row: Pick<SidetabRow, 'id' | 'kind'> | undefined): string | undefined {
  if (!row || row.kind !== 'els' || !row.id.startsWith(ELS_ROW_PREFIX)) return undefined;
  const address = row.id.slice(ELS_ROW_PREFIX.length);
  return address.length > 0 ? address : undefined;
}

export interface ElsRowActionDeps {
  readonly do: (address: string, text: string, from: string) => Promise<ElsResult>;
  readonly read: (address: string) => Promise<ElsResult>;
  /** Who is typing, shown in front of the line on the receiving pane. */
  readonly from: string;
}

export type ElsSendOutcome = 'delivered' | 'queued' | 'refused' | 'unknown';

/**
 * `/side send <text>` on an els row: one `els do`, three honest answers about the line:
 *   delivered — the owner answered that it typed the line · queued — the owner answered that the line waits in the pane's queue ·
 *   unknown   — no answer in time (the local request is bounded at 2 s): the owner may or may not have the line, so it is NEVER
 *               shown as sent or queued; the person checks the pane before sending again.
 * `refused` is a definite no (no server, busy herdr, unknown pane). Only the owner's own answer confirms delivery or queueing.
 */
export async function sendToElsRow(deps: ElsRowActionDeps, address: string, text: string): Promise<{ ok: boolean; outcome: ElsSendOutcome; message: string }> {
  try {
    const answer = await deps.do(address, text, deps.from);
    if (answer.exitCode === 0) return { ok: true, outcome: /\bqueued\b/.test(answer.message) ? 'queued' : 'delivered', message: answer.message };
    if (/did not answer within/.test(answer.message)) {
      return { ok: false, outcome: 'unknown', message: 'no answer in time — the line may or may not have reached the pane; check its screen before sending again' };
    }
    return { ok: false, outcome: 'refused', message: answer.message };
  } catch (error) {
    return { ok: false, outcome: 'refused', message: `els do: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** `/side read` on an els row: the pane's visible screen (the same text `els read` prints). */
export async function readElsRow(deps: ElsRowActionDeps, address: string): Promise<string | undefined> {
  try {
    const answer = await deps.read(address);
    return answer.exitCode === 0 ? answer.message : undefined;
  } catch { return undefined; }
}
