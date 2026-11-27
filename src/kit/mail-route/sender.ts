// KIT mail-route · sender identity — a child `eln msg post` speaks as the seat that runs it, never as a hardcoded seat.
// `cli/pr-cli.ts` and `cli/pr-land-drift-radar.ts` posted `--from OPC` from whatever process ran `pr land` (the same
// shape as #87535 JUD impersonation · rule «--from 은 내 자리만»). The caller's seat is the one msg-cli itself trusts:
// ELANOUS_TRACK → ELANOUS_SEAT → the seats/<SEAT> folder of the cwd. A process with no seat speaks as its own machine
// address (`fallback`), which is honest about where the mail came from.
import { seatFromCwd } from '../../msg/msg-hook.js';

/** The seat running this process (null = none). Pure over its inputs. */
export function callerSeat(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | null {
  const raw = env.ELANOUS_TRACK?.trim() || env.ELANOUS_SEAT?.trim() || seatFromCwd(cwd) || '';
  const seat = raw.toUpperCase();
  return /^[A-Z][A-Z0-9_-]{0,63}$/u.test(seat) ? seat : null;
}

export interface PostAsCallerInput {
  readonly to: string;
  readonly body: string;
  readonly kind?: string;
  /** Machine address used when no seat runs this process (e.g. LAND-GRAPH for the land line). */
  readonly fallback: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

/** The argv for `eln msg post` with `--from` = the caller's seat (or the machine fallback). Pure. */
export function msgPostArgsAsCaller(input: PostAsCallerInput): string[] {
  const from = callerSeat(input.env ?? process.env, input.cwd ?? process.cwd()) ?? input.fallback;
  return ['msg', 'post', '--from', from, '--to', input.to, '--kind', input.kind ?? 'report', '--body', input.body];
}
