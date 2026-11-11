import { dispatchNextTermSlash, type NextTuiTermSlashContext } from '../../slash/term-next.js';

/** The registry resolves /term and /terminal here; both aliases share one handler. */
export async function runNextTuiTermBranchRoute(input: string, host: NextTuiTermSlashContext): Promise<void> {
  const args = input.trim().replace(/^\/(?:term|terminal)(?:\s+|$)/u, '').trim().split(/\s+/u).filter(Boolean);
  await dispatchNextTermSlash(args, host);
}
