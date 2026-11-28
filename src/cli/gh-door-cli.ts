// GH-PROXY-LAYER ① — `eln gh …` as called by the PATH gh shim (bin/gh-shim/gh sets ELN_GH_SHIM_ACTIVE=1). bin/elanous.mjs routes
// here before the command registry loads (a hand-shell `gh pr view` must stay as fast as the real gh): the transparent door —
// same argv · exit code · stdout bytes, no status line (kit/gh-proxy/door.ts). An explicit `eln gh …` without the shim marker
// keeps the gateway with its pipe-visible status line (src/index.ts `gh <args...>` → git-fs/gh-cli.ts runGhCli).
//   eln gh --eln-door-probe   → `eln-gh-door schema=1` (the shim installer checks the installed eln has this door first)
import '../ensure-bin-path.js';
import { runGhDoor } from '../kit/gh-proxy/door.js';

export const GH_DOOR_PROBE_LINE = 'eln-gh-door schema=1';

export async function runGhShimDoorCli(args: readonly string[]): Promise<number> {
  if (args[0] === '--eln-door-probe' && args.length === 1) { process.stdout.write(`${GH_DOOR_PROBE_LINE}\n`); return 0; }
  return runGhDoor(args);
}
