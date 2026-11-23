// Resolve a seat only within the canonical seats directory and use the ordinary ELS socket door.
import { lstatSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readWorkspaceFile, type SeatConfig } from './workspace-config.js';
import { readSeatRegistry, readSeatRegistryV2, seatRegistryPath, seatRegistryEntry, seatRegistryV2Entry } from '../loops/seat-registry.js';
import type { ElsResult } from './core.js';
import type { ElsRequest } from './server.js';

/** ELS-SEAT-MODEL-DECLARE: an eln seat starts on its declared provider/model, so restarts and fresh
 *  opens never fall back to the installed default. Other runtimes keep their bare launch command. */
export function seatLaunchCommand(command: string, declared?: Pick<SeatConfig, 'provider' | 'model'>): { command: string[] } | { error: string } {
  if (!declared || (!declared.provider && !declared.model)) return { command: [command] };
  if (command !== 'eln') return { error: `provider/model is declared but runtime ${command} cannot take it` };
  if (!declared.provider) return { error: 'model is declared without provider; eln needs both' };
  return { command: [command, '--provider', declared.provider, ...(declared.model ? ['--model', declared.model] : [])] };
}

export async function openSeat(seatArg: string, stateRoot: string, request: (r: ElsRequest) => Promise<ElsResult>, options?: { ws?: string; expectedRuntime?: string; expectedCwd?: string }): Promise<ElsResult> {
  const seat = seatArg.toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(seat)) return { exitCode: 2, message: 'els seat: invalid seat name' };
  const seats = join(dirname(stateRoot), 'seats');
  const cwd = join(seats, seat);
  try {
    if (!lstatSync(cwd).isDirectory() || realpathSync(cwd) !== join(realpathSync(seats), seat)) throw new Error('invalid directory');
  } catch { return { exitCode: 1, message: `els seat: seat directory not found or unsafe: ${seat}` }; }
  const path = seatRegistryPath(stateRoot);
  const registry = readSeatRegistry(path);
  let runtime: string = 'eln';
  if (registry.status === 'ready') runtime = seatRegistryEntry(registry.registry, seat)?.runtime ?? 'eln';
  else if (registry.status === 'invalid') {
    const v2 = readSeatRegistryV2(path);
    if (v2.status !== 'ready') return { exitCode: 1, message: 'els seat: invalid seat registry' };
    const declared = seatRegistryV2Entry(v2.registry, seat)?.runtime;
    if (declared && declared !== 'eln') return { exitCode: 1, message: `els seat: runtime ${declared} does not specify a launch command` };
  }
  const command = runtime === 'claude-code' ? 'claude' : runtime;
  if (options?.expectedRuntime && options.expectedRuntime !== command) return { exitCode: 1, message: `els seat: registry runtime for ${seat} is ${command}, not ${options.expectedRuntime}` };
  if (options?.expectedCwd && options.expectedCwd !== cwd) return { exitCode: 1, message: `els seat: declared cwd for ${seat} differs from canonical seat directory` };
  const listed = await request({ op: 'ls' });
  if (listed.exitCode !== 0) return listed;
  let panes: { seat?: string | null; state?: string; pane?: string; ptyId?: string; address?: string }[];
  let workspaces: { name?: string }[];
  try { const list = JSON.parse(listed.message); panes = list.panes; workspaces = list.workspaces ?? []; if (!Array.isArray(panes) || !Array.isArray(workspaces)) throw new Error(); }
  catch { return { exitCode: 1, message: 'els seat: invalid server list' }; }
  const existing = panes.filter(p => p.seat === seat && p.state !== 'exited' && !!p.ptyId && !!p.pane);
  if (existing.length > 1) return { exitCode: 1, message: `els seat: multiple live tabs for ${seat}; choose one explicitly` };
  if (existing.length === 1) return { exitCode: 0, message: JSON.stringify({ pane: existing[0]!.pane, address: existing[0]!.address, existing: true }) };
  let ws = options?.ws;
  let declared: SeatConfig | undefined;
  try {
    const declaration = readWorkspaceFile(dirname(stateRoot), homedir());
    const invalid = declaration.errors.length > 0 || !declaration.config;
    // els up already validated its declaration and names the workspace; only a bare `els seat` needs it.
    if (invalid && !ws) return { exitCode: 1, message: declaration.errors.join('\n') || 'els seat: invalid workspace declaration' };
    if (!invalid) {
      declared = Object.values(declaration.config!.seats).find(entry => entry.id.toUpperCase() === seat);
      ws ??= Object.entries(declaration.config!.spaces).find(([, spec]) => spec.seats.some(id => id.toUpperCase() === seat))?.[0]
        ?? (workspaces.some(space => space.name === seat) ? seat : 'HQ');
    }
  } catch (error) { if (!ws) return { exitCode: 1, message: `els seat: cannot read workspace declaration: ${error instanceof Error ? error.message : String(error)}` }; }
  const launch = seatLaunchCommand(command, declared);
  if ('error' in launch) return { exitCode: 1, message: `els seat: ${seat}: ${launch.error}` };
  const created = await request({ op: 'new', ws: ws ?? 'HQ', cwd, title: seat, command: launch.command, uniqueSeat: seat });
  if (created.exitCode !== 0) return created;
  try {
    const result = JSON.parse(created.message);
    if (typeof result.pane !== 'string' || !result.pane) throw new Error();
    return { exitCode: 0, message: JSON.stringify({ ...result, existing: result.existing === true }) };
  } catch { return { exitCode: 1, message: 'els seat: creation outcome unknown; inspect tabs before retrying' }; }
}
