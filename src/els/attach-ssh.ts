// ELS-SSH-ATTACH-ANYWHERE (OP #108522): attach to a pane on a remote host over ssh from
// anywhere. Same wire as the socket attach (auth/attach/input/resize out; frame/end/error
// in) — see attach-client.ts — but the transport is `ssh <host> -- elanous side
// attach-stdio <pane> <cols> <rows>`, which bridges the remote local socket to stdio.
//
// Credentials (security): this side forwards NOTHING. No owner token and no pane token leaves this
// process — the remote `attach-stdio` bridge authenticates itself against the remote server's own
// socket (pane token from its env; owner token only via the human-terminal gate when its stdin and
// stdout are both a terminal, e.g. `ssh -t`). Over a plain ssh pipe the attach is view-only.
import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createLineDecoder } from './wire.js';
import type { AttachFrame, AttachHandlers } from './attach-client.js';
import { isTailnetOrLoopback, type FederatedHost, type HostRegistry } from './hosts.js';
import { parseAddress } from './address.js';

export interface SshChild {
  readonly write: (text: string) => void;
  readonly kill: () => void;
  readonly end: () => void;
}

export interface SshSpawnHandlers {
  readonly onStdout: (chunk: Buffer) => void;
  readonly onStderr: (chunk: Buffer) => void;
  readonly onExit: (code: number | null, message: string) => void;
}

export interface SshAttachDeps {
  readonly spawn: (argv: readonly string[], handlers: SshSpawnHandlers) => SshChild;
}

/** Default ssh transport: `ssh <host> -- elanous side attach-stdio <pane> <cols> <rows>`. */
const defaultDeps: SshAttachDeps = {
  spawn: (argv, handlers) => {
    const child = spawn('ssh', [...argv], { stdio: ['pipe', 'pipe', 'pipe'] });
    let exited = false;
    child.stdout.on('data', (chunk: Buffer) => handlers.onStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => handlers.onStderr(chunk));
    child.on('close', (code) => {
      if (exited) return;
      exited = true;
      handlers.onExit(code, '');
    });
    child.on('error', (error) => {
      if (exited) return;
      exited = true;
      handlers.onExit(null, error.message);
    });
    child.stdin.on('error', (error) => {
      if (exited) return;
      exited = true;
      child.kill('SIGKILL');
      handlers.onExit(null, error.message);
    });
    return {
      write: (text) => { child.stdin.write(text); },
      kill: () => { child.kill('SIGKILL'); },
      end: () => { child.stdin.end(); },
    };
  },
};

export interface AttachedSsh {
  readonly detach: () => void;
  readonly input: (text: string) => void;
  readonly resize: (cols: number, rows: number) => void;
}

const wire = (payload: unknown): string => JSON.stringify(payload) + '\n';

/** The remote login shell re-parses the ssh command line, so the pane is a single shell word: a plain pane id passes through, anything else is refused. */
const SAFE_PANE = /^[A-Za-z0-9_][A-Za-z0-9_.:@%+=,/-]*$/;
const inert: AttachedSsh = { detach: () => {}, input: () => {}, resize: () => {} };
const MAX_STDOUT_LINE = 1024 * 1024;
const MAX_STDERR = 64 * 1024;

/** Resolve only a registered, operator-pinned remote address. */
export function resolveSshAttach(registry: HostRegistry, ref: string): { host: FederatedHost; pane: string } {
  if (registry.problem || registry.rejected.length) throw new Error('els attach: host registry invalid');
  const address = parseAddress(ref);
  if (!address?.host) throw new Error('els attach: remote address must be host:ws/tab/pane');
  const host = registry.hosts.find(row => row.name === address.host);
  if (!host) throw new Error(`els attach: host ${address.host} is not registered`);
  if (!host.attach) throw new Error(`els attach: host ${address.host} has no pinned SSH attach transport`);
  return { host, pane: address.pane };
}

export function sshAttachArgv(host: FederatedHost, pane: string, cols: number, rows: number,
  address?: { readonly ws: string; readonly tab: string }): string[] {
  const config = host.attach;
  if (!config) throw new Error('els attach: pinned SSH attach transport required');
  const url = new URL(host.baseUrl);
  const urlHost = url.hostname.toLowerCase();
  const targetHost = config.sshTarget.slice(config.sshTarget.indexOf('@') + 1);
  if (!/^[a-z_][a-z0-9_-]*@[A-Za-z0-9._-]+$/i.test(config.sshTarget) || targetHost.toLowerCase() !== urlHost)
    throw new Error('els attach: SSH HostName differs from registered URL host');
  if (!isAbsolute(config.knownHostsFile) || /[\s%\0]/.test(config.knownHostsFile)) throw new Error('els attach: one absolute pinned known_hosts file required');
  const file = lstatSync(config.knownHostsFile);
  if (!file.isFile() || (file.mode & 0o022) !== 0) throw new Error('els attach: pinned known_hosts must be a regular, non-writable-by-group file');
  if (!SAFE_PANE.test(pane)) throw new Error('els attach: invalid pane');
  if (address && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(address.ws)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(address.tab)
    || host.baseUrl !== url.origin || !isTailnetOrLoopback(url.hostname)))
    throw new Error('els attach: invalid registered remote read origin or address');
  return ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${config.knownHostsFile}`,
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `HostName=${targetHost}`, '-o', 'ConnectTimeout=10', '--', config.sshTarget,
    'elanous', 'side', 'attach-stdio', pane, String(cols), String(rows), ...(address ? [host.baseUrl, address.ws, address.tab] : [])];
}

export function attachElsOverSsh(
  host: FederatedHost,
  pane: string,
  size: { readonly cols: number; readonly rows: number },
  handlers: AttachHandlers,
  deps: SshAttachDeps = defaultDeps,
  address?: { readonly ws: string; readonly tab: string },
): AttachedSsh {
  let argv: string[];
  try { argv = sshAttachArgv(host, pane, Math.max(1, Math.trunc(size.cols) || 80), Math.max(1, Math.trunc(size.rows) || 24), address); }
  catch (error) {
    queueMicrotask(() => handlers.onEnd(2, error instanceof Error ? error.message : String(error)));
    return inert;
  }
  const cols = Math.max(1, Math.trunc(size.cols) || 80);
  const rows = Math.max(1, Math.trunc(size.rows) || 24);
  const lines = createLineDecoder((line) => {
    if (!line) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      handlers.onError?.(`bad line: ${line.slice(0, 200)}`);
      return;
    }
    const op = parsed.op as string | undefined;
    if (op === 'frame') {
      handlers.onFrame(parsed as unknown as AttachFrame);
    } else if (op === 'end') {
      const code = parsed.code === 0 ? 0 : parsed.code === 2 ? 2 : 1;
      if (closed) return;
      closed = true;
      child.end();
      handlers.onEnd(code, typeof parsed.reason === 'string' ? parsed.reason : 'pty exit');
    } else if (op === 'error') {
      handlers.onError?.(typeof parsed.message === 'string' ? parsed.message : `bad error line: ${line.slice(0, 200)}`);
    } else {
      handlers.onError?.(`unexpected line: ${line.slice(0, 200)}`);
    }
  });
  let closed = false;
  let stdoutPending = 0;
  let stderrBytes = 0;
  let stderr = '';
  let overflow = false;
  const child = deps.spawn(
    argv,
    {
      onStdout: (chunk) => {
        if (closed || overflow) return;
        for (const byte of chunk) {
          stdoutPending = byte === 10 ? 0 : stdoutPending + 1;
          if (stdoutPending > MAX_STDOUT_LINE) { overflow = true; child.kill(); return; }
        }
        lines.push(chunk);
      },
      onStderr: (chunk) => {
        if (closed || overflow) return;
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR) { overflow = true; child.kill(); return; }
        stderr += chunk.toString('utf8');
      },
      onExit: (code, message) => {
        if (closed) return;
        closed = true;
        handlers.onEnd(overflow ? 1 : code === 0 ? 0 : 1,
          overflow ? 'els attach: SSH output exceeded limit' : (message || stderr.trim().slice(0, 400)));
      },
    },
  );
  child.write(wire({ op: 'attach', cols, rows }));
  return {
    detach: () => {
      if (closed) return;
      child.kill();
    },
    input: (text) => {
      if (closed) return;
      child.write(wire({ op: 'input', bytes: text }));
    },
    resize: (cols, rows) => {
      if (closed) return;
      child.write(wire({ op: 'resize', cols, rows }));
    },
  };
}
