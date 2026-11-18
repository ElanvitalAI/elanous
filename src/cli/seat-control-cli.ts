import type { Command } from 'commander';
import { detectSeatTui } from '../seat/seat-boot-preamble.js';
import { authorizeSeatControl, type SeatControlMode } from '../seat/seat-control.js';
import { listPtyManifestRows } from '../pty-shell/pty-manifest.js';
import { requestRemotePtyControl, type PtyControlResult } from '../pty-shell/pty-control-ipc.js';

type Candidate = { id: string; kind: string; seat?: string; alive: boolean };
interface SeatControlDeps {
  sender(): string | null;
  rows(): readonly Candidate[];
  send(id: string, action: 'seat-stop', payload: { mode: SeatControlMode; sender: string }): Promise<PtyControlResult>;
}

/** Same uid is a cooperative policy boundary, not proof of a seat identity. */
export async function runSeatControl(target: string, rawMode: string, deps: SeatControlDeps): Promise<PtyControlResult> {
  if (rawMode !== 'quit' && rawMode !== 'migrate' && rawMode !== 'force') return { status: 'denied', reason: 'invalid-mode' };
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(target)) return { status: 'denied', reason: 'invalid-seat' };
  const sender = deps.sender();
  if (!sender) return { status: 'denied', reason: 'sender-unavailable' };
  if (!authorizeSeatControl({ sender, target, sameHost: true })) return { status: 'denied', reason: 'seat-control-not-authorized' };
  const matches = deps.rows().filter(row => row.kind === 'tui' && row.alive && row.seat === target);
  if (matches.length === 0) return { status: 'unknown-pty', reason: 'seat-not-running' };
  if (matches.length !== 1) return { status: 'denied', reason: 'ambiguous-seat' };
  return deps.send(matches[0]!.id, 'seat-stop', { mode: rawMode, sender });
}

export function registerSeatControlCommand(command: Command): void {
  command.command('control <seat> <mode>').description('Request local seat migrate, quit, or force')
    .action(async (seat: string, mode: string) => {
      try {
        const result = await runSeatControl(seat.toUpperCase(), mode, {
          sender: () => detectSeatTui(process.cwd())?.seat ?? null,
          rows: listPtyManifestRows,
          send: (id, action, payload) => requestRemotePtyControl(id, action, payload),
        });
        if (result.status !== 'success') process.exitCode = 1;
        console.log(JSON.stringify(result));
      } catch (error) {
        process.exitCode = 1;
        console.error(`seat control failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}
