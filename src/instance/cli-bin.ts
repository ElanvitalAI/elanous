// The CLI a loop / graph node spawns — never a bare name. The trigger tick runs from cron with PATH=/usr/bin:/bin and its
// cwd in the installed package (crontab «elanous-loop=graph-trigger-tick»), so `spawnSync('eln')` there fails: release-traffic
// read every pregate slot as null and every write failed (ok=false) on 11-27 22:21 while a hand run worked (LOOP-EXCEPTION-WATCH).
// Same class as #40570 (a node relying on its cwd). Faces: observe = the caller's `why` names the argv it used · judge =
// the running code's own bin/elanous.mjs (same universe as the runner: installed → ops · tree → test) · heal = an install
// layout without bin/elanous.mjs falls back to the installed launcher, then to the bare name (an interactive shell).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The code root of the running elanous (the graph runner stamps ELANOUS_RUNTIME_ROOT on every cmd: child). */
export const runtimeRoot = (): string => process.env.ELANOUS_RUNTIME_ROOT?.trim() || resolve(import.meta.dir, '../..');

/** An installed launcher by absolute path (`~/.local/share/elanous/bin/<name>`) · the bare name when not installed. */
export function installedBin(name: string): string {
  const p = join(homedir(), '.local', 'share', 'elanous', 'bin', name);
  return existsSync(p) ? p : name;
}

/** argv prefix for «eln …» from inside a loop/graph node: [bun, <runtime>/bin/elanous.mjs] — absolute, cwd- and PATH-free. */
export function elanousCliArgv(): string[] {
  const cli = join(runtimeRoot(), 'bin', 'elanous.mjs');
  if (existsSync(cli)) return [process.execPath, cli];
  return [installedBin('eln')];
}
