import { spawnSync } from 'node:child_process';
import { SPAWN_SYNC_MAX_BUFFER } from '../util/spawn-sync-output.js';

export type CloudVmHost = 'aws1' | 'aws2' | 'aws3' | 'gcp2';
export type CloudVmState = 'running' | 'stopped' | 'transitioning' | 'unknown';

export interface CloudVmStatus {
  host: CloudVmHost;
  state: CloudVmState;
  detail?: string;
}

/** Product boundary for the one scheduled rehearsal VM. It has no terminate/delete operation. */
export interface CloudVmAdapter {
  start(host: CloudVmHost): Promise<void>;
  stop(host: CloudVmHost): Promise<void>;
  status(host: CloudVmHost): Promise<CloudVmStatus>;
}

export interface CloudVmCommandResult { status: number | null; stdout: string; stderr: string; error?: string }
export type CloudVmCommandRunner = (command: string, args: string[], timeoutMs: number) => CloudVmCommandResult;

const defaultRunner: CloudVmCommandRunner = (command, args, timeoutMs) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error.message } : {}) };
};

/**
 * Calls the configured cloud-vm executable with argv, never through a shell. The command owns
 * provider-specific metering, stop guards and confirmation; this adapter cannot terminate VMs.
 */
export function createCommandCloudVmAdapter(command: string, runner: CloudVmCommandRunner = defaultRunner,
  context: { readonly reason: string; readonly source: string } = { reason: 'scheduled release rehearsal lifecycle', source: 'release.rehearsal' }): CloudVmAdapter {
  if (!command.trim()) throw new Error('release.rehearsal.cloudVmCommand must name an executable');
  const validateHost = (host: CloudVmHost): void => {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(host) || (host as string) === 'all') throw new Error(`cloud-vm host alias is invalid: ${host}`);
  };
  const invoke = async (action: 'start' | 'stop' | 'status', host: CloudVmHost): Promise<CloudVmCommandResult> => {
    validateHost(host);
    const timeoutMs = action === 'status' ? 45_000 : action === 'start' ? 11 * 60_000 : 16 * 60_000;
    const result = runner(command, [action, host, '--reason', context.reason, '--source', context.source], timeoutMs);
    if (result.status !== 0 || result.error) {
      const detail = [result.error, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(' · ') || `exit ${result.status}`;
      throw new Error(`cloud-vm ${action} ${host} failed: ${detail}`);
    }
    return result;
  };
  return {
    async start(host) { await invoke('start', host); },
    async stop(host) { await invoke('stop', host); },
    async status(host) {
      const result = await invoke('status', host);
      const rows = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('['));
      const matching = rows.filter(line => line.split(/\s+/)[0] === host);
      if (matching.length !== 1) return { host, state: 'unknown', detail: `expected one ${host} status row, found ${matching.length}` };
      const fields = matching[0]!.split(/\s+/);
      const state = fields[5]?.toLowerCase();
      if (state === 'running') return { host, state: 'running' };
      if (state === 'stopped' || state === 'terminated' || state === 'deallocated') return { host, state: 'stopped' };
      if (state === 'pending' || state === 'stopping' || state === 'starting') return { host, state: 'transitioning', detail: state };
      return { host, state: 'unknown', detail: `unrecognized cloud-vm status row: ${matching[0]}` };
    },
  };
}
