import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerControlCommands, runResourcesQuery } from '../cli/control-cli.js';
import { readPrimaryJoin, resolvePrimary, writePrimaryJoin } from './primary.js';

const roots: string[] = [];
const token = { admin: 'a'.repeat(64), member: 'b'.repeat(64), query: 'c'.repeat(64) };
function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'control-primary-'));
  roots.push(value);
  return value;
}
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { force: true, recursive: true }); });

test('join file is private, replaces atomically and reads only scoped credentials', () => {
  const dir = root();
  writePrimaryJoin({ url: 'https://primary.example:31413', tokens: { query: token.query } }, dir);
  const file = join(dir, 'control', 'join.json');
  expect(statSync(file).mode & 0o077).toBe(0);
  expect(readPrimaryJoin(dir)).toEqual({ url: 'https://primary.example:31413', tokens: { query: token.query } });
  chmodSync(file, 0o644);
  expect(readPrimaryJoin(dir)).toBeUndefined();
  writePrimaryJoin({ url: 'http://localhost:31413', tokens: { member: token.member } }, dir);
  expect(statSync(file).mode & 0o077).toBe(0);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ url: 'http://localhost:31413', tokens: { member: token.member } });
  expect(existsSync(join(dir, 'control', 'tokens.json'))).toBe(false);
});

test('rename failure preserves the existing join and removes the private temporary file', () => {
  const dir = root();
  const file = join(dir, 'control', 'join.json');
  writePrimaryJoin({ url: 'https://old.example', tokens: { query: token.query } }, dir);
  const before = readFileSync(file, 'utf8');
  const rename = spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('injected rename failure'); });
  try {
    expect(() => writePrimaryJoin({ url: 'https://new.example', tokens: { member: token.member } }, dir))
      .toThrow('injected rename failure');
  } finally {
    rename.mockRestore();
  }
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(readdirSync(join(dir, 'control'))).toEqual(['join.json']);
});

test('missing or malformed join never creates credentials or supersedes local address', () => {
  const dir = root();
  expect(readPrimaryJoin(dir)).toBeUndefined();
  expect(resolvePrimary({ root: dir, role: 'query' })).toEqual({ url: 'http://127.0.0.1:31413', token: undefined, source: 'local' });
  mkdirSync(join(dir, 'control'));
  const file = join(dir, 'control', 'join.json');
  for (const malformed of ['{', JSON.stringify({ url: 'https://primary.example', tokens: { admin: 'short' } }),
    JSON.stringify({ url: 'https://user:password@primary.example', tokens: { query: token.query } })]) {
    writeFileSync(file, malformed);
    expect(readPrimaryJoin(dir)).toBeUndefined();
  }
  expect(existsSync(join(dir, 'control', 'tokens.json'))).toBe(false);
});

test('config URL outranks join; scoped token cannot leak across addresses or roles', () => {
  const dir = root();
  writePrimaryJoin({ url: 'https://joined.example', tokens: { member: token.member, query: token.query } }, dir);
  expect(resolvePrimary({ root: dir, role: 'member', port: 12345 })).toEqual({
    url: 'https://joined.example', token: token.member, source: 'join',
  });
  expect(resolvePrimary({ root: dir, role: 'admin' }).token).toBeUndefined();
  expect(resolvePrimary({ root: dir, role: 'member', config: { url: 'https://configured.example', tokens: { query: token.query } } })).toEqual({
    url: 'https://configured.example', token: undefined, source: 'config',
  });
  expect(resolvePrimary({ root: dir, role: 'query', config: { url: 'https://joined.example' } })).toEqual({
    url: 'https://joined.example', token: token.query, source: 'config',
  });
  expect(resolvePrimary({ root: dir, role: 'admin', config: { url: 'https://configured.example', tokens: { admin: token.admin } } })).toEqual({
    url: 'https://configured.example', token: token.admin, source: 'config',
  });
});

test('joined local address never inherits a missing role from local tokens', () => {
  const dir = root();
  mkdirSync(join(dir, 'control'));
  writeFileSync(join(dir, 'control', 'tokens.json'), JSON.stringify(token));
  writePrimaryJoin({ url: 'http://127.0.0.1:31413', tokens: { member: token.member } }, dir);
  expect(resolvePrimary({ root: dir, role: 'member' })).toEqual({
    url: 'http://127.0.0.1:31413', token: token.member, source: 'join',
  });
  expect(resolvePrimary({ root: dir, role: 'query' })).toEqual({
    url: 'http://127.0.0.1:31413', token: undefined, source: 'join',
  });
});

test('local-only port override selects local scoped token; remote ignores even invalid override', () => {
  const dir = root();
  mkdirSync(join(dir, 'control'));
  writeFileSync(join(dir, 'control', 'tokens.json'), JSON.stringify(token));
  expect(resolvePrimary({ root: dir, role: 'query', port: 43210 })).toEqual({
    url: 'http://127.0.0.1:43210', token: token.query, source: 'local',
  });
  expect(resolvePrimary({ root: dir, role: 'admin', port: 43210 }).token).toBe(token.admin);
  expect(resolvePrimary({ root: dir, role: 'query', config: { url: 'http://127.0.0.1:43210' }, port: 43210 }).token).toBe(token.query);
  expect(() => resolvePrimary({ root: dir, role: 'query', port: -1 })).toThrow('invalid control port');
  writePrimaryJoin({ url: 'https://joined.example', tokens: { member: token.member } }, dir);
  expect(resolvePrimary({ root: dir, role: 'member', port: -1 })).toEqual({
    url: 'https://joined.example', token: token.member, source: 'join',
  });
  expect(resolvePrimary({ root: dir, role: 'admin' }).token).toBeUndefined();
  expect(resolvePrimary({ root: dir, role: 'query', config: { tokens: { query: token.query } } })).toEqual({
    url: 'https://joined.example', token: token.query, source: 'join',
  });
});

test('control join command writes a scoped join record into the isolated instance', async () => {
  const dir = root();
  const before = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = dir;
  try {
    const program = new Command();
    registerControlCommands(program);
    await program.parseAsync(['control', 'join', '--url', 'https://primary.example', '--query-token', token.query], { from: 'user' });
    expect(readPrimaryJoin(dir)).toEqual({ url: 'https://primary.example', tokens: { query: token.query } });
    expect(statSync(join(dir, 'control', 'join.json')).mode & 0o077).toBe(0);
    expect(existsSync(join(dir, 'control', 'tokens.json'))).toBe(false);
  } finally {
    if (before === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = before;
  }
});

test('resources query preserves local scoped-token behavior and honors explicit Primary configuration', async () => {
  const dir = root();
  mkdirSync(join(dir, 'control'));
  writeFileSync(join(dir, 'control', 'tokens.json'), JSON.stringify(token));
  const before = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = dir;
  const requests: string[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push(`${String(input)} ${new Headers(init?.headers).get('authorization')}`);
    return Response.json({ resources: [] });
  }) as typeof fetch);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await runResourcesQuery({ port: '31499', json: true })).toBe(0);
    writePrimaryJoin({ url: 'https://joined.example', tokens: { query: token.query } }, dir);
    expect(await runResourcesQuery({ port: '31499', primaryUrl: 'https://configured.example', queryToken: token.member, json: true })).toBe(0);
    expect(requests).toEqual([
      `http://127.0.0.1:31499/v1/resources Bearer ${token.query}`,
      `https://configured.example/v1/resources Bearer ${token.member}`,
    ]);
  } finally {
    logSpy.mockRestore();
    fetchSpy.mockRestore();
    if (before === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = before;
  }
});

test('resources query refuses to send local credentials to a joined Primary lacking query scope', async () => {
  const dir = root();
  mkdirSync(join(dir, 'control'));
  writeFileSync(join(dir, 'control', 'tokens.json'), JSON.stringify(token));
  writePrimaryJoin({ url: 'https://joined.example', tokens: { member: token.member } }, dir);
  const before = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = dir;
  const fetchSpy = spyOn(globalThis, 'fetch');
  const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await runResourcesQuery({})).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
    fetchSpy.mockRestore();
    if (before === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = before;
  }
});

test('resources query retains local credential creation when no join exists', async () => {
  const dir = root();
  const before = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = dir;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: URL | RequestInfo, init?: RequestInit) => {
    expect(String(input)).toBe('http://127.0.0.1:31413/v1/resources');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${JSON.parse(readFileSync(join(dir, 'control', 'tokens.json'), 'utf8')).query}`);
    return Response.json({ resources: [] });
  }) as typeof fetch);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await runResourcesQuery({ json: true })).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(statSync(join(dir, 'control', 'tokens.json')).mode & 0o077).toBe(0);
  } finally {
    logSpy.mockRestore();
    fetchSpy.mockRestore();
    if (before === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = before;
  }
});

test('resources query uses the joined primary and its query credential without creating local tokens', async () => {
  const dir = root();
  writePrimaryJoin({ url: 'https://primary.example', tokens: { query: token.query, admin: token.admin } }, dir);
  const before = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = dir;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: URL | RequestInfo, init?: RequestInit) => {
    expect(String(input)).toBe('https://primary.example/v1/resources');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token.query}`);
    return Response.json({ resources: [] });
  }) as typeof fetch);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await runResourcesQuery({ port: '31499', json: true })).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, 'control', 'tokens.json'))).toBe(false);
  } finally {
    logSpy.mockRestore();
    fetchSpy.mockRestore();
    if (before === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = before;
  }
});
