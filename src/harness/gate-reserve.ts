import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { releaseLedgerRoot } from '../instance/resolve.js';
import type { QueueSeat } from './harness-queue.js';

/** Shadow calculation only: reserve one of the configured per-seat gate slots while the release gate runs. */
export function gateReserve({ releaseGateActive, seat, configuredGateCap }: {
  releaseGateActive: boolean; seat: QueueSeat; configuredGateCap: number;
}): { active: boolean; wouldCap: number } {
  void seat;
  return { active: releaseGateActive, wouldCap: releaseGateActive ? Math.max(0, configuredGateCap - 1) : configuredGateCap };
}

const execFileAsync = promisify(execFile);
const MAX_LEDGER_READS = 32;
const MAX_PROBE_MS = 1_500;

/** Read-only, bounded process and graph-run probe; unavailable or incomplete observation is inactive. */
export async function detectReleaseGateActive(deps: {
  processes?: () => string | Promise<string>;
  runsRoot?: string;
  read?: (path: string) => string | Promise<string>;
  list?: (path: string) => string[] | Promise<string[]>;
  modifiedAt?: (path: string) => number | Promise<number>;
  /** Test seam for the shared probe deadline; production defaults to 1.5 seconds. */
  timeoutMs?: number;
} = {}): Promise<boolean> {
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? MAX_PROBE_MS;
  const deadline = Date.now() + timeoutMs;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error('release gate observation timed out'));
    }, timeoutMs);
  });
  const bounded = <T>(operation: T | Promise<T>): Promise<T> => Promise.race([Promise.resolve(operation), timeout]);
  try {
    const argv = await bounded((deps.processes ?? (async () => {
      const result = await execFileAsync('ps', ['-eo', 'pid=,args='],
        { encoding: 'utf8', timeout: 1_000, maxBuffer: 4 * 1024 * 1024, signal: controller.signal });
      return result.stdout;
    }))());
    if (Date.now() >= deadline) return false;
    const pids = new Set(argv.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      // Same release run/resume argv fingerprint as RAIL-SAFE, bound here to the graph-run owner's PID.
      return match && /(?:^|\s)(?:\S*\/)?elanous\.mjs\s+(?:(?:--test(?:=\S+)?|--config-dir\s+\S+)\s+)*release\s+(?:run|resume)(?=\s|$)/.test(match[2]!)
        ? [Number(match[1])] : [];
    }));
    if (!pids.size) return false;
    const dir = join(deps.runsRoot ?? releaseLedgerRoot(), 'graph-runs', 'release-loop');
    let files: string[];
    try { files = await bounded(deps.list ? deps.list(dir) : fs.readdir(dir)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    // Inspect metadata for every ledger before choosing the newest: directory order is not recency.
    // A slow or huge directory expires the common deadline, then fails open without scanning further.
    const candidates = files.filter((file) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(file));
    const modifiedAt = deps.modifiedAt ?? (async (path: string) => (await fs.stat(path)).mtimeMs);
    const recent: { file: string; at: number }[] = [];
    for (let offset = 0; offset < candidates.length && Date.now() < deadline; offset += 32) {
      const batch = candidates.slice(offset, offset + 32);
      const times = await bounded(Promise.all(batch.map(async (file) => {
        try { return await modifiedAt(join(dir, file)); } catch { return -1; }
      })));
      for (let i = 0; i < batch.length; i++) if (times[i]! >= 0) recent.push({ file: batch[i]!, at: times[i]! });
    }
    recent.sort((a, b) => b.at - a.at);
    for (const { file } of recent.slice(0, MAX_LEDGER_READS)) {
      if (Date.now() >= deadline) return false;
      let run: {
        pid?: number; status?: string; currentNode?: { nodeId: string }; path?: string[]; nodes?: { nodeId: string; ok: boolean }[];
      };
      try { run = JSON.parse(await bounded((deps.read ?? ((path: string) => fs.readFile(path,
        { encoding: 'utf8', signal: controller.signal })))(join(dir, file)))) as typeof run; }
      catch { continue; }
      if (run?.status === 'running' && run.pid && pids.has(run.pid)
        && run.currentNode?.nodeId === 'gate' && run.path?.at(-1) === 'gate'
        && Array.isArray(run.nodes) && run.path.length === run.nodes.length + 1) return true;
    }
    return false;
  } catch { return false; }
  finally { clearTimeout(timeoutId); controller.abort(); }
}
