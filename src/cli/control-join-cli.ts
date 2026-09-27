import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { effectiveInstanceRoot } from '../instance/resolve.js';

interface JoinRecord { url: string; machine: string; token: string }
export interface ControlJoinOptions {
  url: string;
  machine: string;
  tokenFile?: string;
  tokenStdin?: boolean;
}
interface JoinDeps {
  root?: string;
  fetch?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
  readStdin?: () => Promise<string>;
}

function joinPath(root: string): string {
  return join(root, 'control', 'join.json');
}

function validMachine(machine: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(machine) && !['__proto__', 'constructor', 'prototype'].includes(machine);
}

function coordinatorUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('invalid coordinator URL');
  }
  return url;
}

function readJoin(root: string): JoinRecord | undefined {
  let text: string;
  try { text = readFileSync(joinPath(root), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid join file');
  const { url, machine, token } = value as Record<string, unknown>;
  if (typeof url !== 'string' || typeof machine !== 'string' || typeof token !== 'string' ||
      !validMachine(machine) || !/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid join file');
  try { coordinatorUrl(url); } catch { throw new Error('invalid join file'); }
  return { url, machine, token };
}

export async function runControlJoin(options: ControlJoinOptions, deps: JoinDeps = {}): Promise<number> {
  try {
    if (!validMachine(options.machine)) throw new Error('invalid control machine');
    if (Boolean(options.tokenFile) === Boolean(options.tokenStdin)) throw new Error('choose exactly one of --token-file or --token-stdin');
    const base = coordinatorUrl(options.url);
    const raw = options.tokenFile ? readFileSync(options.tokenFile, 'utf8')
      : await (deps.readStdin ?? (() => Bun.stdin.text()))();
    const token = raw.trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid member token');
    const url = new URL('/v1/resources', base);
    url.searchParams.set('machine', options.machine);
    let response: Response;
    try {
      response = await (deps.fetch ?? globalThis.fetch)(url, {
        method: 'GET', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error('coordinator unreachable or timed out');
    }
    if (!response.ok) throw new Error(`coordinator rejected token (HTTP ${response.status})`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error('invalid coordinator response'); }
    if (!body || typeof body !== 'object' || !('resources' in body) || !Array.isArray(body.resources)) {
      throw new Error('invalid coordinator response');
    }
    const root = deps.root ?? effectiveInstanceRoot();
    const path = joinPath(root);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ url: base.href, machine: options.machine, token }), { flag: 'wx', mode: 0o600 });
      renameSync(temp, path);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* no temporary file */ }
      throw error;
    }
    console.log(`Joined ${base.origin} as ${options.machine}`.replaceAll(token, '[redacted]'));
    return 0;
  } catch (error) {
    // Peer and filesystem errors can echo credentials; never print an untrusted message.
    const safe = error instanceof Error && [
      'invalid control machine', 'choose exactly one of --token-file or --token-stdin',
      'invalid coordinator URL', 'invalid member token', 'coordinator unreachable or timed out',
      'invalid coordinator response',
    ].includes(error.message) ? error.message
      : error instanceof Error && /^coordinator rejected token \(HTTP \d+\)$/.test(error.message) ? error.message
      : 'join failed';
    console.error(`합류 실패: ${safe}`);
    return 1;
  }
}

export function runControlLeave(root: string = effectiveInstanceRoot()): number {
  try {
    unlinkSync(joinPath(root));
    console.log('Left coordinator');
    return 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log('Not joined');
      return 0;
    }
    console.error('leave failed');
    return 2;
  }
}

export function runControlStatus(root: string = effectiveInstanceRoot()): number {
  try {
    const record = readJoin(root);
    console.log(record ? `Joined ${record.url} as ${record.machine}` : 'Not joined');
    return 0;
  } catch {
    console.error('invalid join file');
    return 2;
  }
}

/** Define the standalone join/leave/status commands on a supplied control group. */
export function defineControlJoinCommands(control: Command): void {
  control.command('join').description('Join a coordinator')
    .requiredOption('--url <url>', 'coordinator URL')
    .requiredOption('--machine <name>', 'local machine name')
    .option('--token-file <path>', 'read member token from a file')
    .option('--token-stdin', 'read member token from stdin')
    .action(async (options: ControlJoinOptions) => { process.exitCode = await runControlJoin(options); });
  control.command('leave').description('Remove local coordinator membership')
    .action(() => { process.exitCode = runControlLeave(); });
  control.command('status').description('Show local coordinator membership without the token')
    .action(() => { process.exitCode = runControlStatus(); });
}
