// OP-HANDLES-L2b — the seat tool `SeatAssign(seat, cellId, why?, from?)`: one call from «idle hand × open cell» to an
// owned cell, an assignment mail (+30 m due · writer table · pre-approved resources) and an idle wake.
// CLI twin: `eln seat assign <seat> <cell-id> [--why "<line>"]`.
import type { LLMToolSpec } from '../../llm/tool-spec.js';
import type { SeatAssignDeps, SeatAssignResult } from '../../seat/seat-assign.js';

export const SEAT_ASSIGN_TOOL_NAME = 'SeatAssign';

export function buildSeatAssignTool(): LLMToolSpec {
  return {
    name: SEAT_ASSIGN_TOOL_NAME,
    description: 'Assign a release checklist cell to a hand seat in one step: sets the cell owner, posts a structured assignment mail '
      + '(done-when · due +30m · open PRs/recent commits on the cell paths · pre-approved test hosts) and wakes the seat if its pane is idle. '
      + 'The writer check is built in — it refuses only when another seat\'s live PR holds the cell\'s paths, and names it. '
      + 'Coordinators only (HQ / space coordinator). CLI twin: eln seat assign <seat> <cell-id> [--why "<line>"].',
    parameters: {
      type: 'object',
      properties: {
        seat: { type: 'string', description: 'The hand seat that will own the cell (a registered federation seat), or POOL to borrow the longest-idle hand of the federation hand pool.' },
        cellId: { type: 'string', description: 'Release checklist cell id.' },
        why: { type: 'string', description: 'One line: why this seat, why now.' },
        from: { type: 'string', description: 'Assigning coordinator seat (default: this session\'s seat).' },
        version: { type: 'string', description: 'Checklist version (default: the dev version).' },
      },
      required: ['seat', 'cellId'],
      additionalProperties: false,
    },
  };
}

export type SeatAssignToolResult = Record<string, unknown> & { readonly output: string; readonly result: SeatAssignResult };

export async function dispatchSeatAssign(args: Record<string, unknown>, deps: { readonly assignDeps?: SeatAssignDeps; readonly actor?: string } = {}): Promise<SeatAssignToolResult> {
  const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const seat = text(args.seat);
  const cellId = text(args.cellId);
  if (!seat || !cellId) throw new Error('SeatAssign needs seat and cellId');
  const actor = deps.actor ?? text(args.from) ?? text(process.env.ELANOUS_TRACK) ?? text(process.env.ELANOUS_SEAT) ?? '';
  const { seatAssign } = require('../../seat/seat-assign.js') as typeof import('../../seat/seat-assign.js');
  const assignDeps = deps.assignDeps ?? (require('../../seat/seat-assign-live.js') as typeof import('../../seat/seat-assign-live.js')).liveSeatAssignDeps();
  const why = text(args.why);
  const version = text(args.version);
  const result = await seatAssign({ seat, cellId, actor, ...(why ? { why } : {}), ...(version ? { version } : {}) }, assignDeps);
  return { output: result.ok ? result.lines.join('\n') : result.reason, result };
}
