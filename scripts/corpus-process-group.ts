import { spawnSyncText } from '../src/util/spawn-sync-output.js';

function liveGroupMembers(pgid: number): number[] {
  const rows = spawnSyncText('ps', ['-axo', 'pid=,pgid=,stat='], {
    encoding: 'utf8', timeout: 3_000, maxBuffer: 4 * 1024 * 1024,
  });
  return rows.split('\n').flatMap((row) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(row);
    return match && Number(match[2]) === pgid && !match[3]!.startsWith('Z') ? [Number(match[1])] : [];
  });
}

/** Terminate a detached worker group, including descendants that inherited its PGID. */
export function killCorpusProcessGroup(
  pgid: number,
  signal: NodeJS.Signals = 'SIGKILL',
  deps: { kill?: (pid: number, signal: NodeJS.Signals) => void; listMembers?: (pgid: number) => number[]; now?: () => number; selfPid?: number } = {},
): 'group' | 'members' | 'absent' {
  const kill = deps.kill ?? process.kill;
  try {
    kill(-pgid, signal);
    return 'group';
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ESRCH') return 'absent';
    if (code !== 'EPERM') throw error;
  }

  // Kill nonleaders first, then the detached leader. Re-scan for descendants
  // created after the first snapshot; a dead leader cannot create more.
  const listMembers = deps.listMembers ?? liveGroupMembers;
  const now = deps.now ?? Date.now;
  const deadline = now() + 3_000;
  const callerIsLeader = pgid === (deps.selfPid ?? process.pid);
  do {
    const members = listMembers(pgid);
    if (!members.length) return 'members';
    const descendants = members.filter((pid) => pid !== pgid);
    // In the worker's orphan hook, finish descendants before signaling self:
    // this synchronous loop prevents the worker from spawning new children.
    const targets = callerIsLeader ? descendants : [...descendants, ...members.filter((pid) => pid === pgid)];
    for (const pid of targets) {
      try { kill(pid, signal); }
      catch (error: unknown) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
      }
    }
    if (callerIsLeader && !listMembers(pgid).some((pid) => pid !== pgid)) {
      kill(pgid, signal);
      return 'members';
    }
  } while (now() < deadline);
  if (listMembers(pgid).length) throw new Error(`corpus process group ${pgid} survived cleanup`);
  return 'members';
}
