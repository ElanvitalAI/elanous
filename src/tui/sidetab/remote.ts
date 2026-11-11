import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getUserConfig } from '../../user-config/reader.js';
import { debug } from '../../debug/log.js';
import { parsePodPool } from '../../task-orchestrator/surfaces/pod-pool.js';
import type { SidetabRow } from '../../sidetab-core/model.js';

const execFileAsync = promisify(execFile);

export interface RemoteRegisteredSidetabRow {
  readonly ptyId: string;
  readonly kind: 'tui';
  readonly name: string;
  readonly alive: true;
  readonly registered: true;
  readonly lastActivityAt?: number;
  readonly status?: string;
  readonly host: string;
}

export interface RemoteSidetabHostResult {
  readonly host: string;
  readonly rows: readonly SidetabRow[];
  readonly error?: string;
}

export function configuredRemoteSidetabHosts(): string[] {
  const config = getUserConfig() as { harness?: { podPool?: string } };
  const spec = config.harness?.podPool?.trim();
  if (!spec) return [];
  return [...new Set(parsePodPool(spec).map((member) => member.sshHost ?? member.context))];
}

export async function fetchRegisteredRemoteSidetabRows(
  hosts: readonly string[],
  run: (host: string, command: string) => Promise<string> = async (host, command) =>
    (await execFileAsync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'ControlPath=none', '--', host, command], { timeout: 7_000, maxBuffer: 1024 * 1024 })).stdout,
): Promise<RemoteSidetabHostResult[]> {
  return Promise.all(hosts.map(async (host): Promise<RemoteSidetabHostResult> => {
    try {
      const parsed: unknown = JSON.parse(await run(host, 'eln pty sidetab list --json'));
      if (!Array.isArray(parsed)) throw new Error('expected JSON array');
      const rows = parsed.map((value): SidetabRow => {
        if (!value || typeof value !== 'object') throw new Error('malformed registered row');
        const entry = value as Partial<RemoteRegisteredSidetabRow>;
        if (typeof entry.ptyId !== 'string' || !entry.ptyId || entry.kind !== 'tui'
          || entry.registered !== true || entry.alive !== true || typeof entry.name !== 'string') {
          throw new Error('malformed or ineligible registered row');
        }
        const badge = entry.status === 'busy' ? 'busy' : entry.status === 'idle' ? 'idle' : entry.status === 'stale' ? 'stale' : 'unknown';
        return {
          id: `remote:${host}:${entry.ptyId}`,
          ptyId: entry.ptyId,
          remoteHost: host,
          host,
          label: `${host}:${entry.name} · ${entry.status ?? 'unknown'} · ${entry.lastActivityAt ? new Date(entry.lastActivityAt).toISOString() : '활동 시각 미상'}`,
          kind: 'tui',
          badge,
          status: entry.status ?? 'unknown',
          ...(entry.lastActivityAt === undefined ? {} : { lastActivityAt: entry.lastActivityAt }),
        };
      });
      return { host, rows };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      debug.log('sidetab.remote', 'host-unreachable', { host, reason });
      return { host, rows: [], error: reason };
    }
  }));
}

export function markRemoteHostUnavailable(rows: readonly SidetabRow[], host: string, reason: string): SidetabRow[] {
  return rows.map((row) => row.remoteHost === host
    ? { ...row, badge: 'stale', label: `${row.label.replace(/ · 측정 불가.*$/, '')} · 측정 불가`, status: `측정 불가 · ${reason}` }
    : row);
}


export async function runRemoteElnPty(host: string, args: readonly string[]): Promise<string> {
  const command = ['eln', ...args].map(quoteShell).join(' ');
  const { stdout } = await execFileAsync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'ControlPath=none', '--', host, command,
  ], { timeout: 7_000, maxBuffer: 1024 * 1024 });
  return stdout;
}

export function quoteShell(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
