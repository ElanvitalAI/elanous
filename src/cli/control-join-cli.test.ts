import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { issueMemberToken } from '../control-plane/member-tokens.js';
import { startControlServer } from '../control-plane/server.js';
import { defineControlJoinCommands, runControlJoin, runControlLeave, runControlStatus } from './control-join-cli.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'control-join-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const token = 'a'.repeat(64);
const joinFile = (dir: string) => join(dir, 'control', 'join.json');
const options = { url: 'http://127.0.0.1:31413', machine: 'node-1' };

async function capture<T>(run: () => Promise<T> | T): Promise<{ result: T; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { err.push(args.join(' ')); };
  try { return { result: await run(), out, err }; }
  finally { console.log = log; console.error = error; }
}

test('join validates the scoped member token through GET /v1/resources?machine before persisting it', async () => {
  const dir = root();
  const serverRoot = root();
  const server = startControlServer({ root: serverRoot, port: 0 });
  try {
    const credential = issueMemberToken('node-1', serverRoot);
    const tokenPath = join(dir, 'credential');
    writeFileSync(tokenPath, `${credential}\n`);
    const joined = await capture(() => runControlJoin({ ...options, url: server.url, tokenFile: tokenPath }, { root: dir }));
    expect(joined.result).toBe(0);
    expect(joined.out).toEqual([`Joined ${server.url} as node-1`]);
    expect(joined.out.join('') + joined.err.join('')).not.toContain(credential);
    expect(JSON.parse(readFileSync(joinFile(dir), 'utf8'))).toEqual({ url: `${server.url}/`, machine: 'node-1', token: credential });
    expect(statSync(joinFile(dir)).mode & 0o077).toBe(0);
    const status = await capture(() => runControlStatus(dir));
    expect(status).toMatchObject({ result: 0, out: [`Joined ${server.url}/ as node-1`], err: [] });
    expect(status.out.join('')).not.toContain(credential);
    const left = await capture(() => runControlLeave(dir));
    expect(left).toMatchObject({ result: 0, out: ['Left coordinator'] });
    expect(existsSync(joinFile(dir))).toBe(false);
    expect(await capture(() => runControlStatus(dir))).toMatchObject({ result: 0, out: ['Not joined'] });
    expect(await capture(() => runControlLeave(dir))).toMatchObject({ result: 0, out: ['Not joined'] });
  } finally { server.stop(); }
});

test('stdin token uses the same validation and is never echoed', async () => {
  const dir = root();
  const calls: Array<{ url: URL | RequestInfo; init?: RequestInit }> = [];
  const result = await capture(() => runControlJoin({ ...options, tokenStdin: true }, {
    root: dir, readStdin: async () => `${token}\n`,
    fetch: async (url, init) => {
      calls.push({ url, init });
      expect(existsSync(joinFile(dir))).toBe(false);
      return Response.json({ resources: [] });
    },
  }));
  expect(result.result).toBe(0);
  expect(String(calls[0]?.url)).toBe('http://127.0.0.1:31413/v1/resources?machine=node-1');
  expect(calls[0]?.init?.method).toBe('GET');
  expect(calls[0]?.init?.headers).toEqual({ authorization: `Bearer ${token}` });
  expect(JSON.parse(readFileSync(joinFile(dir), 'utf8')).token).toBe(token);
  expect(result.out.join('') + result.err.join('')).not.toContain(token);
});

test('failed validation, malformed response, network error, and invalid inputs write no join file', async () => {
  for (const response of [
    () => new Response(token, { status: 401, statusText: token }),
    () => Response.json({ resources: null }),
    () => new Response('not json'),
    () => { throw new Error(token); },
  ]) {
    const dir = root();
    const result = await capture(() => runControlJoin({ ...options, tokenStdin: true }, {
      root: dir, readStdin: async () => token, fetch: async () => response(),
    }));
    expect(result.result).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err).toHaveLength(1);
    expect(result.err[0]).toMatch(/^합류 실패: [^\n]+$/);
    expect(result.err[0]).not.toMatch(/at |Bun v/);
    expect(result.out.join('') + result.err.join('')).not.toContain(token);
    expect(existsSync(joinFile(dir))).toBe(false);
    expect(existsSync(join(dir, 'control'))).toBe(false);
  }
  for (const overrides of [
    {}, { tokenStdin: true, tokenFile: 'unused' }, { machine: '../escape', tokenStdin: true },
    { url: 'file:///secret', tokenStdin: true },
  ]) {
    const dir = root();
    const result = await capture(() => runControlJoin({ ...options, ...overrides }, { root: dir }));
    expect(result.result).toBe(1);
    expect(result.err).toHaveLength(1);
    expect(result.err[0]).toMatch(/^합류 실패: [^\n]+$/);
    expect(existsSync(joinFile(dir))).toBe(false);
  }
  const dir = root();
  const invalid = await capture(() => runControlJoin({ ...options, tokenStdin: true }, {
    root: dir, readStdin: async () => 'not-a-token', fetch: async () => { throw new Error('must not fetch'); },
  }));
  expect(invalid.result).toBe(1);
  expect(existsSync(joinFile(dir))).toBe(false);
});

test('failed rejoin preserves the previous join file and status never exposes the secret', async () => {
  const dir = root();
  const initial = await runControlJoin({ ...options, tokenStdin: true }, {
    root: dir, readStdin: async () => token, fetch: async () => Response.json({ resources: [] }),
  });
  expect(initial).toBe(0);
  const original = readFileSync(joinFile(dir), 'utf8');
  const failure = await capture(() => runControlJoin({ ...options, tokenStdin: true }, {
    root: dir, readStdin: async () => token, fetch: async () => new Response(null, { status: 403 }),
  }));
  expect(failure.result).toBe(1);
  expect(readFileSync(joinFile(dir), 'utf8')).toBe(original);
  expect(readdirSync(join(dir, 'control'))).toEqual(['join.json']);
  writeFileSync(joinFile(dir), '{bad json');
  expect(await capture(() => runControlStatus(dir))).toMatchObject({ result: 2, err: ['invalid join file'] });
  expect(runControlLeave(dir)).toBe(0);
});

test('standalone join commands can be defined on a supplied group; real CLI registers join separately', async () => {
  const program = new Command();
  const control = program.command('control');
  defineControlJoinCommands(control);
  expect(control.commands.map(command => command.name())).toEqual(['join', 'leave', 'status']);
  const dir = root();
  const entry = resolve(import.meta.dir, '../../bin/elanous.mjs');
  const child = Bun.spawnSync(['bun', entry, `--test=${dir}`, 'control', '--help'], {
    cwd: resolve(import.meta.dir, '../..'), env: { ...process.env, ELANOUS_CONTROL_PORT: '' },
    stdout: 'pipe', stderr: 'pipe',
  });
  expect(child.exitCode).toBe(0);
  const help = new TextDecoder().decode(child.stdout);
  expect(help).toContain('serve');
  expect(help).toMatch(/\bjoin\b/);
  expect(help).not.toMatch(/\bleave\b|\bstatus\b/);
});
