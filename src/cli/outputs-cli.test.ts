import { afterEach, expect, setSystemTime, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { recordOutput } from '../outputs/ledger.js';
import { registerOutputsCommands } from './outputs-cli.js';

const roots: string[] = [];
afterEach(() => {
  setSystemTime();
  resetElanousConfigDir();
  process.exitCode = 0;
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'outputs-cli-'));
  roots.push(dir);
  setElanousConfigDir(dir);
  return dir;
}

async function invoke(...args: string[]): Promise<{ lines: string[]; errors: string[]; code: number }> {
  const lines: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...parts) => { lines.push(parts.join(' ')); });
  const err = spyOn(console, 'error').mockImplementation((...parts) => { errors.push(parts.join(' ')); });
  const write = spyOn(process.stdout, 'write').mockImplementation(((text: string, callback?: (error?: Error) => void) => {
    lines.push(text);
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    const program = new Command();
    registerOutputsCommands(program);
    await program.parseAsync(['outputs', 'list', ...args], { from: 'user' });
    return { lines, errors, code: Number(process.exitCode ?? 0) };
  } finally {
    log.mockRestore(); err.mockRestore(); write.mockRestore();
    process.exitCode = 0;
  }
}

test('real ledger lists newest first, kind counts, source, ISO and relative since, without writes', async () => {
  const dir = root();
  setSystemTime(new Date('2026-10-04T12:00:00.000Z'));
  recordOutput({ source: 'exec', sourceId: 'one', kind: 'report', title: '보고서', path: '/tmp/report.md', seat: 'CMO', at: '2026-10-04T00:00:00.000Z' }, dir);
  recordOutput({ source: 'exec', sourceId: 'two', kind: 'slides', title: '발표', url: 'https://example.org/slides', seat: 'CTO', at: '2026-10-04T10:00:00.000Z' }, dir);
  recordOutput({ source: 'field-reel', sourceId: 'reel', kind: 'video', title: '현장', path: '/tmp/reel.mp4', at: '2026-10-04T11:00:00.000Z' }, dir);
  const files = readdirSync(join(dir, 'outputs')).sort();
  const contents = files.map(file => readFileSync(join(dir, 'outputs', file)));
  const observed = spyOn(debug, 'log');
  try {
    const json = await invoke('--json');
    expect(json.code).toBe(0);
    expect(json.errors).toEqual([]);
    const data = JSON.parse(json.lines.join(''));
    expect(data).toMatchObject({ count: 3, byKind: { report: 1, slides: 1, video: 1 }, scope: { since: null, source: null, limit: 50 } });
    expect(data.items.map((entry: { sourceId: string }) => entry.sourceId)).toEqual(['reel', 'two', 'one']);
    expect(data.items[0]).toMatchObject({ source: 'field-reel', kind: 'video', path: '/tmp/reel.mp4' });
    expect((await invoke('--source', 'exec', '--json')).lines.join('')).toContain('"count":2');
    expect(JSON.parse((await invoke('--source', 'field-reel', '--json')).lines.join(''))).toMatchObject({ count: 1, byKind: { video: 1 } });
    expect(JSON.parse((await invoke('--source', 'field-feed', '--json')).lines.join(''))).toMatchObject({ count: 0, byKind: {} });
    const since = JSON.parse((await invoke('--since', '24h', '--json')).lines.join(''));
    expect(since.count).toBe(3);
    expect(since.scope.since).toBe('2026-10-03T12:00:00.000Z');
    expect(JSON.parse((await invoke('--since', '7d', '--limit', '1', '--json')).lines.join('')).count).toBe(1);
    expect(JSON.parse((await invoke('--since', '2026-10-04T10:30:00+09:00', '--json')).lines.join('')).count).toBe(2);
    const human = await invoke();
    expect(human.lines[0]).toContain('2026-10-04 20:00:00 KST · video · 현장 · field-reel/reel · — · /tmp/reel.mp4');
    expect(human.lines[2]).toContain('CMO · /tmp/report.md');
    expect(human.lines.at(-1)).toBe('3개 · 종류별 수 {"video":1,"slides":1,"report":1}');
    expect(observed.mock.calls.some(call => call[0] === 'outputs.cli' && call[1] === 'list'
      && (call[2] as { count: number }).count === 3)).toBe(true);
    expect(readdirSync(join(dir, 'outputs')).sort()).toEqual(files);
    expect(files.map(file => readFileSync(join(dir, 'outputs', file)))).toEqual(contents);
  } finally { observed.mockRestore(); }
});

test('missing ledger is a successful zero with scope; unreadable folder or month is not zero', async () => {
  const empty = root();
  const zero = JSON.parse((await invoke('--source', 'exec', '--json')).lines.join(''));
  expect(zero).toMatchObject({ items: [], count: 0, byKind: {}, scope: { source: 'exec', limit: 50 } });
  setSystemTime(new Date('2026-10-04T12:00:00.000Z'));
  expect((await invoke('--since', '7d')).lines).toEqual([
    'scope: ' + JSON.stringify({ since: '2026-09-27T12:00:00.000Z', source: null, limit: 50 }),
    '0개 · 종류별 수 {}',
  ]);
  const folder = join(empty, 'outputs');
  mkdirSync(folder);
  writeFileSync(join(folder, 'outputs-2026-10.jsonl'), '');
  expect(JSON.parse((await invoke('--json')).lines.join(''))).toMatchObject({ count: 0, byKind: {} });
  chmodSync(folder, 0o000);
  try {
    const failure = await invoke('--json');
    expect(failure.code).toBe(1);
    expect(failure.lines).toEqual([]);
    expect(failure.errors).toHaveLength(1);
    expect(failure.errors[0]).toContain('outputs ledger directory unreadable');
  } finally { chmodSync(folder, 0o700); }
  recordOutput({ source: 'exec', sourceId: 'one', kind: 'report', title: 'one', url: '/one' }, empty);
  const file = readdirSync(folder).find(name => name.endsWith('.jsonl'))!;
  chmodSync(join(folder, file), 0o000);
  try {
    const failure = await invoke('--json');
    expect(failure.code).toBe(1);
    expect(failure.errors[0]).toContain('outputs ledger file unreadable');
  } finally { chmodSync(join(folder, file), 0o600); }
});

test('field-feed entries are included and can be selected without creating another store', async () => {
  const dir = root();
  recordOutput({ source: 'field-feed', sourceId: 'post-one', kind: 'post', title: '초안', path: '/tmp/post.md' }, dir);
  const result = JSON.parse((await invoke('--source', 'field-feed', '--json')).lines.join(''));
  expect(result).toMatchObject({ count: 1, byKind: { post: 1 }, scope: { source: 'field-feed' },
    items: [{ source: 'field-feed', sourceId: 'post-one', title: '초안' }] });
});

test('the real CLI entry dispatches outputs list with an isolated instance root', () => {
  const dir = root();
  recordOutput({ source: 'exec', sourceId: 'entry', kind: 'report', title: 'entry', url: '/entry' }, dir);
  const result = spawnSync('bun', ['bin/elanous.mjs', '--test', `--config-dir=${dir}`, 'outputs', 'list', '--json'],
    { cwd: join(import.meta.dir, '../..'), encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ count: 1, byKind: { report: 1 }, items: [{ sourceId: 'entry' }] });
  const folder = join(dir, 'outputs');
  chmodSync(folder, 0o000);
  try {
    const failure = spawnSync('bun', ['bin/elanous.mjs', '--test', `--config-dir=${dir}`, 'outputs', 'list', '--json'],
      { cwd: join(import.meta.dir, '../..'), encoding: 'utf8' });
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe('');
    expect(failure.stderr).toContain('outputs ledger directory unreadable');
  } finally { chmodSync(folder, 0o700); }
});

test('invalid filters fail once rather than return an empty ledger', async () => {
  root();
  for (const args of [['--since', 'yesterday'], ['--since', '2026-02-30T00:00:00Z'], ['--source', 'unknown'], ['--limit', '0']]) {
    const result = await invoke(...args, '--json');
    expect(result.code).toBe(1);
    expect(result.lines).toEqual([]);
    expect(result.errors).toHaveLength(1);
  }
});
