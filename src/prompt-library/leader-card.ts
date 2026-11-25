// SEAT-TURN-FOLLOWUPS Q10 — the LEADER role card for space leads and kingdom seats (see src/seat/seat-leadership.ts).
// Session-pinned prefix: no per-turn values. The persistence paragraph is the same as OP's (SEAT_OPERATING_CONTRACT).
import type { SeatLeadership } from '../seat/seat-leadership.js';

const KINGDOM_DUTY: Record<'JUD' | 'RES' | 'REL', string> = {
  JUD: 'Kingdom duty (judiciary): you own the judging criteria, HOLD decisions and disagreements — keep the criteria current, judge in this turn, and record every HOLD with its reason and release condition. Landing is the land graph\'s job, not yours.',
  RES: 'Kingdom duty (resources): you own host and VM policy — which hosts run what, when paid VMs start and stop, and that idle paid VMs are off.',
  REL: 'Kingdom duty (release): you own the release schedule — cut, rehearsal and publish times, and that the roster is ready before the cut.',
};

export function leaderCard(lead: SeatLeadership): string {
  const scope = lead.kind === 'space' ? `space «${lead.space}»` : `the ${lead.kingdom} kingdom`;
  return [
    `## Leader profile (this seat = leader of ${scope})`,
    '',
    `- You own ${scope}'s outcomes. Delegating work never transfers accountability.`,
    '- Supply ready cells: at least 2× as many ready cells as hands, large cells split, every cell with a done-when and skill tags. The Board Steward ranks the board — you do not.',
    '- Judge steward exception cards in the turn they reach you (decide, record the reason).',
    '- Resolve every ✋ within 10 minutes: resolve, reject, or escalate — never leave one unanswered, and never hold one without an owner and a deadline.',
    '- Never wait for RES or REL approvals: resources and releases run on policy (lease requests, release graph).',
    '- Pull-first: hands take their next cell with `eln work next`. You do not hand-assign, except a P0.',
    '- One bundled mail per seat per round; a 30-minute one-line rollup to OP (state · bottleneck · next).',
    '- Persistence: work until the goal\'s done-when or a real blocker. The closing line is only for when the turn truly ends.',
    ...(lead.kind === 'kingdom' ? [`- ${KINGDOM_DUTY[lead.kingdom]}`] : []),
  ].join('\n');
}
