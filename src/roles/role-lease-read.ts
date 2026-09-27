import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsentSaid } from './lease-cas.js';
import { debug } from '../debug/log.js';
import { gcloudSearchPaths } from '../cli/role-cli.js';
import { ROLE_LEASE_OBJECT_PATH, parseRoleLease, type RoleLeaseRead } from './role-lease.js';

interface CommandResult {
  code: number | null;
  stdout: string;
  said: string;
}

async function runGcloud(args: string[]): Promise<CommandResult> {
  let binary: string | undefined;
  for (const path of gcloudSearchPaths()) {
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) { binary = path; break; } }
    catch { /* try the next executable */ }
  }
  if (!binary) return { code: null, stdout: '', said: 'gcloud not found' };
  return new Promise(resolve => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', error = '', settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, stdout, said: 'gcloud timeout (8s)' });
    }, 8_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (err: Error) => { error = err.message; });
    child.on('close', code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, stdout, said: `${stdout}${stderr}${error}` });
    });
  });
}

export async function readRoleLeaseAsync(bucket: string, { run = runGcloud }: {
  run?: (args: string[]) => Promise<CommandResult>;
} = {}): Promise<RoleLeaseRead> {
  const started = Date.now();
  let result: RoleLeaseRead;
  const uri = `${bucket}/${ROLE_LEASE_OBJECT_PATH}`;
  const describe = async (): Promise<{ kind: 'present'; gen: string } | { kind: 'absent' } | { kind: 'unmeasured'; why: string }> => {
    const response = await run(['storage', 'objects', 'describe', uri, '--format=value(generation)']);
    if (response.code !== 0) {
      return response.code !== null && isAbsentSaid(response.said)
        ? { kind: 'absent' } : { kind: 'unmeasured', why: response.said.trim() || 'gcloud describe failed' };
    }
    const gen = response.stdout.trim();
    return /^\d+$/.test(gen) ? { kind: 'present', gen } : { kind: 'unmeasured', why: 'invalid GCS generation' };
  };
  try {
    const before = await describe();
    if (before.kind !== 'present') result = before;
    else {
      const body = await run(['storage', 'cat', uri]);
      if (body.code !== 0) result = { kind: 'unmeasured', why: body.said.trim() || 'gcloud cat failed' };
      else {
        const after = await describe();
        result = after.kind !== 'present' || before.gen !== after.gen
          ? { kind: 'unmeasured', why: 'lease changed during read; retry' }
          : parseRoleLease(body.stdout);
      }
    }
  } catch (error) {
    result = { kind: 'unmeasured', why: error instanceof Error ? error.message : String(error) };
  }
  debug.log('control.lease', 'read', {
    kind: result.kind, holder: result.kind === 'present' ? result.doc.holder : null,
    generation: result.kind === 'present' ? result.doc.generation : null, ms: Date.now() - started,
  });
  return result;
}
