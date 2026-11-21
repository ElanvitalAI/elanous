import type { Command } from 'commander';
import { detectSeatTui } from '../seat/seat-boot-preamble.js';
import { authorizeSeatControl, type SeatControlMode } from '../seat/seat-control.js';
import { listPtyManifestRows } from '../pty-shell/pty-manifest.js';
import { requestRemotePtyControl, type PtyControlResult } from '../pty-shell/pty-control-ipc.js';
import { spawnSync } from 'node:child_process';

/** A live process's working folder (macOS/Linux lsof), or null. */
function processCwd(pid: number): string | null {
  const run = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 3_000 });
  const line = (run.stdout ?? '').split('\n').find(row => row.startsWith('n'));
  return line ? line.slice(1) : null;
}

type Candidate = { id: string; kind: string; seat?: string; alive: boolean; ownerPid?: number; sessionId?: string; workdir?: string };
export type SeatControlExpected = { id: string; ownerPid: number; sessionId: string; workdir: string };
interface SeatControlDeps {
  sender(): string | null;
  rows(): readonly Candidate[];
  send(id: string, action: 'seat-stop', payload: { mode: SeatControlMode; sender: string; expected?: SeatControlExpected }): Promise<PtyControlResult>;
  /** SEAT-CONTROL-REGISTRY-MISMATCH: the seat a live process runs in (from its working folder), or undefined. */
  seatOfPid?(pid: number): string | undefined;
}

/** Same uid is a cooperative policy boundary, not proof of a seat identity. */
export async function runSeatControl(target: string, rawMode: string, deps: SeatControlDeps, expected?: SeatControlExpected): Promise<PtyControlResult> {
  if (rawMode !== 'quit' && rawMode !== 'migrate' && rawMode !== 'force') return { status: 'denied', reason: 'invalid-mode' };
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(target)) return { status: 'denied', reason: 'invalid-seat' };
  const sender = deps.sender();
  if (!sender) return { status: 'denied', reason: 'sender-unavailable' };
  if (!authorizeSeatControl({ sender, target, sameHost: true })) return { status: 'denied', reason: 'seat-control-not-authorized' };
  const matches = deps.rows().filter(row => row.kind === 'tui' && row.alive && row.seat === target);
  if (matches.length === 0) {
    // A live TUI with no seat on its row was started by a build older than seat control (#38714): it never registered a
    // seat and cannot act on seat-stop. Say so — «not running» sent OP looking for a process that was there (RES #100614).
    const old = deps.seatOfPid ? deps.rows().find(row => row.kind === 'tui' && row.alive && !row.seat && row.ownerPid !== undefined
      && deps.seatOfPid!(row.ownerPid) === target) : undefined;
    if (old) return { status: 'unknown-pty', reason: 'seat-build-predates-control', policy: `restart ${target}: its TUI (${old.id}, pid ${old.ownerPid}) runs a build from before seat control and cannot take ${rawMode}` };
    return { status: 'unknown-pty', reason: 'seat-not-running' };
  }
  if (matches.length !== 1) return { status: 'denied', reason: 'ambiguous-seat' };
  if (expected && (matches[0]!.id !== expected.id || matches[0]!.ownerPid !== expected.ownerPid
    || matches[0]!.sessionId !== expected.sessionId || matches[0]!.workdir !== expected.workdir))
    return { status: 'denied', reason: 'target-changed' };
  return deps.send(matches[0]!.id, 'seat-stop', { mode: rawMode, sender, ...(expected ? { expected } : {}) });
}

export function registerSeatControlCommand(command: Command): void {
  command.command('control <seat> <mode>').description('Request local seat migrate, quit, or force')
    .action(async (seat: string, mode: string) => {
      try {
        const result = await runSeatControl(seat.toUpperCase(), mode, {
          sender: () => detectSeatTui(process.cwd())?.seat ?? null,
          rows: listPtyManifestRows,
          send: (id, action, payload) => requestRemotePtyControl(id, action, payload),
          seatOfPid: (pid) => { const cwd = processCwd(pid); return cwd ? detectSeatTui(cwd)?.seat : undefined; },
        });
        if (result.status !== 'success') process.exitCode = 1;
        console.log(JSON.stringify(result));
      } catch (error) {
        process.exitCode = 1;
        console.error(`seat control failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}
