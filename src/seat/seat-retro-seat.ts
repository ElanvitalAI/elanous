// Which seat (if any) may run a retro in this TUI. Kept apart from the scheduler so the scheduler stays light.
import { resolveInstance } from '../instance/resolve.js';
import { detectSeatTui } from './seat-boot-preamble.js';

/** The seat whose retro this TUI may run, or null. Only an unattended seat TUI qualifies: its `seat-state/<SEAT>` directory
 *  must exist (a bare COORD_ID does not make a human TUI a seat, and the state write must never create that directory), and
 *  a test-universe run never touches the production HQ state. Any lookup failure means no retro. */
export function resolveSeatRetroSeat(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: { home?: string; instanceKind?: () => 'prod' | 'test'; stat?: (path: string) => { isDirectory(): boolean } } = {},
): string | null {
  try {
    const kind = (deps.instanceKind ?? (() => resolveInstance({ ...(env.ELANOUS_STATE_DIR ? { stampedStateDir: env.ELANOUS_STATE_DIR } : {}) }).kind))();
    if (kind !== 'prod') return null;
    return detectSeatTui(cwd, { env, ...(deps.home ? { home: deps.home } : {}), ...(deps.stat ? { stat: deps.stat } : {}) })?.seat ?? null;
  } catch { return null; }
}
