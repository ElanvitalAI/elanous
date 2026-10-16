import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { classifyGhCall } from './capture.js';

const dir = dirname(fileURLToPath(import.meta.url));
const wrapper = join(dir, 'gh');
const temporary: string[] = [];
const initialPath = process.env.PATH;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gh-surface-'));
  temporary.push(root);
  const real = join(root, 'fake-gh');
  const jsonl = join(root, 'capture.jsonl');
  writeFileSync(real, `#!/bin/sh\nprintf 'argc=%s\\n' "$#"\nfor arg do printf '<%s>\\n' "$arg"; done\ncat\nprintf 'fake-stderr\\n' >&2\nexit 23\n`);
  chmodSync(real, 0o700);
  return { root, real, jsonl, env: {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    ELANOUS_GH_REAL_BIN: real,
    ELANOUS_GH_SURFACE_JSONL: jsonl,
  } };
}

afterEach(() => {
  const roots = temporary.splice(0);
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  }
  expect(temporary).toHaveLength(0);
  expect(process.env.PATH).toBe(initialPath);
});

test('opt-in PATH wrapper forwards argv, stdin, stdout, stderr and exit; records only safe names', () => {
  const { env, real, jsonl } = fixture();
  const secret = 'SENTINEL_SECRET_789';
  const args = ['pr', 'list', '--json', 'number,title', '--body', secret, '-f', `query=${secret}`, `https://example.invalid/${secret}`];
  const input = `stdin-${secret}\n`;
  const direct = spawnSync(real, args, { env, input, encoding: 'utf8' });
  const wrapped = spawnSync('gh', args, { env, input, encoding: 'utf8' });
  expect(wrapped.status).toBe(23);
  expect(wrapped.status).toBe(direct.status);
  expect(wrapped.stdout).toBe(direct.stdout);
  expect(wrapped.stderr).toBe(direct.stderr);
  expect(JSON.parse(readFileSync(jsonl, 'utf8'))).toEqual({ command: 'pr list', fields: ['number', 'title'], unknown: false });
  expect(readFileSync(jsonl, 'utf8')).not.toContain(secret);
  expect(process.env.PATH).not.toBe(env.PATH);
});

test('both --json forms and unsupported command/field forms are counted as unknown, not copied', () => {
  const { env, jsonl } = fixture();
  const calls = [
    ['issue', 'view', '7', '--json=number,state'],
    ['pr', 'list', '--json', 'title,author'],
    ['pr', 'list', '--json', 'title;SENTINEL_SECRET_789'],
    ['pr', 'list', '--json=SENTINEL_SECRET_789'],
    ['extension', 'SENTINEL_SECRET_789', '--json', 'title'],
    ['pr', 'list', '--json', '--body', 'SENTINEL_SECRET_789'],
    ['pr', 'list', '--json-file=SENTINEL_SECRET_789'],
    ['run', 'list', '-w', '--json=number'],
    ['run', 'list', '-w', 'number', '--json=number'],
    ['pr', 'create', '-w', '--json=number'],
    ['pr', 'list', '-w', '--json=number'],
    ['repo', 'list', '-s', '--json=name'],
    ['issue', 'list', '-s', 'open', '--json=number'],
    ['run', 'list', '-s', '--json=number'],
    ['pr', 'list', '--body', '--json=number'],
    ['pr', 'list', '-f', '--json=number'],
    ['pr', 'list', '-F', '--json=number'],
  ];
  for (const args of calls) expect(spawnSync('gh', args, { env }).status).toBe(23);
  const rows = readFileSync(jsonl, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  expect(rows).toEqual([
    { command: 'issue view', fields: ['number', 'state'], unknown: false },
    { command: 'pr list', fields: ['title', 'author'], unknown: false },
    { command: 'pr list', fields: 'unknown', unknown: true },
    { command: 'pr list', fields: 'unknown', unknown: true },
    { command: 'unknown', fields: 'unknown', unknown: true },
    { command: 'pr list', fields: 'unknown', unknown: true },
    { command: 'pr list', fields: 'unknown', unknown: true },
    { command: 'run list', fields: 'unknown', unknown: true },
    { command: 'run list', fields: ['number'], unknown: false },
    { command: 'pr create', fields: ['number'], unknown: false },
    { command: 'pr list', fields: 'unknown', unknown: true },
    { command: 'repo list', fields: ['name'], unknown: false },
    { command: 'issue list', fields: ['number'], unknown: false },
    { command: 'run list', fields: 'unknown', unknown: true },
    { command: 'pr list', fields: 'unknown', unknown: true },
    { command: 'pr list', fields: 'unknown', unknown: true },
    { command: 'pr list', fields: 'unknown', unknown: true },
  ]);
  expect(readFileSync(jsonl, 'utf8')).not.toContain('SENTINEL_SECRET_789');
  expect(classifyGhCall(['api', 'graphql', '-f', 'query=SENTINEL_SECRET_789'])).toEqual({ command: 'api graphql', fields: [], unknown: false });
  expect(classifyGhCall(['api', 'graphql', '--json=title'])).toEqual({ command: 'api graphql', fields: 'unknown', unknown: true });
  expect(classifyGhCall(['pr', 'list', '--json=number', '--json', 'title'])).toEqual({ command: 'pr list', fields: 'unknown', unknown: true });
  expect(classifyGhCall(['pr', 'list', '--body', '--json=number', '--json', 'title'])).toEqual({ command: 'pr list', fields: 'unknown', unknown: true });
});

test('parallel child append is one complete JSONL row per invocation', async () => {
  const { env, jsonl } = fixture();
  const args = ['pr', 'view', '--json=number,title', '--body', 'SENTINEL_SECRET_789'];
  const children = Array.from({ length: 24 }, () => spawn(wrapper, args, { env, stdio: ['ignore', 'ignore', 'ignore'] }));
  const results = await Promise.all(children.map((child) => new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => done(code));
  })));
  expect(results).toEqual(Array(24).fill(23));
  const lines = readFileSync(jsonl, 'utf8').split('\n');
  expect(lines.pop()).toBe('');
  expect(lines).toHaveLength(24);
  for (const line of lines) expect(JSON.parse(line)).toEqual({ command: 'pr view', fields: ['number', 'title'], unknown: false });
  expect(readFileSync(jsonl, 'utf8')).not.toContain('SENTINEL_SECRET_789');
});

test('exec preserves the real gh signal termination', () => {
  const { env, real } = fixture();
  writeFileSync(real, '#!/bin/sh\nkill -TERM "$$"\n');
  const direct = spawnSync(real, ['pr', 'list'], { env, encoding: 'utf8' });
  const wrapped = spawnSync(wrapper, ['pr', 'list'], { env, encoding: 'utf8' });
  expect(wrapped.signal).toBe('SIGTERM');
  expect(wrapped.signal).toBe(direct.signal);
  expect(wrapped.status).toBe(direct.status);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) test(`external ${signal} during capture stops the child and never starts real gh`, async () => {
  const { env, real, root, jsonl } = fixture();
  const childStarted = join(root, 'capture-pid');
  const childTerminated = join(root, 'capture-terminated');
  const realStarted = join(root, 'real-started');
  const fakeBun = join(root, 'bun');
  writeFileSync(fakeBun, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(childStarted)}, String(process.pid));
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(childTerminated)}, 'TERM'); process.exit(143); });
setInterval(() => {}, 1000);
`);
  chmodSync(fakeBun, 0o700);
  writeFileSync(real, `#!/bin/sh\nprintf started > ${JSON.stringify(realStarted)}\n`);
  const child = spawn(wrapper, ['pr', 'list'], { env: { ...env, PATH: `${root}:${env.PATH}` }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 150 && !existsSync(childStarted); i++) await Bun.sleep(20);
    expect(existsSync(childStarted)).toBe(true);
    child.kill(signal);
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    expect(exit).toEqual({ code: null, signal });
    expect(readFileSync(childTerminated, 'utf8')).toBe('TERM');
    expect(existsSync(realStarted)).toBe(false);
    expect(existsSync(jsonl)).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('invalid binary or failed capture returns nonzero without invoking the real gh', () => {
  const { env, root } = fixture();
  const missing = spawnSync(wrapper, ['pr', 'list'], { env: { ...env, ELANOUS_GH_REAL_BIN: 'gh' }, encoding: 'utf8' });
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain('absolute path required');
  const failed = spawnSync(wrapper, ['pr', 'list'], { env: { ...env, ELANOUS_GH_SURFACE_JSONL: root }, encoding: 'utf8' });
  expect(failed.status).not.toBe(0);
  expect(failed.stdout).toBe('');
  expect(failed.stderr).not.toContain(root);
});
