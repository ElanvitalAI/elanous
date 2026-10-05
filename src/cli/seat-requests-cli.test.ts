import { expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileLeaseStore, serializeLease } from '../hq/lease.js';
import { registerSeatRequestsCommands } from './seat-requests-cli.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'seat-requests-cli-'));
  const path = join(root, 'seat-requests', 'requests.jsonl');
  mkdirSync(join(root, 'seat-requests'));
  const output: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => { output.push(line); });
  const error = spyOn(console, 'error').mockImplementation((line: string) => { errors.push(line); });
  const exit = process.exitCode;
  process.exitCode = 0;
  const cli = new Command();
  const hq = { store: fileLeaseStore(join(root, 'lease.json'), () => 100),
    config: { hostName: 'mbp' }, hostPath: join(root, 'host'), localPath: join(root, 'local.json'),
    seenPath: join(root, 'seen-generation'), now: () => 100, log: (() => {}) as never };
  registerSeatRequestsCommands(cli.command('seat'), { root: () => root, hq, now: () => new Date('2026-10-05T00:00:00.000Z') });
  const run = (...args: string[]) => cli.parseAsync(['seat', 'requests', ...args], { from: 'user' });
  const append = (key: string, status: string, seat = 'TC', queuedAt = '2026-10-03T00:00:00.000Z') =>
    appendFileSync(path, JSON.stringify({ key, status, seat, text: `request ${key}`, queuedAt,
      ...(status === 'queued' ? { receiptId: `receipt-${key}` } : { ref: `pwa:${key}` }) }) + '\n');
  const rows = () => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  return { root, path, run, append, rows, output, errors, cleanup: () => {
    log.mockRestore(); error.mockRestore(); process.exitCode = exit; rmSync(root, { recursive: true, force: true });
  } };
}

test('seat requests list filters only latest state per key and supports JSON and text', async () => {
  const f = fixture();
  try {
    f.append('a', 'queued'); f.append('b', 'queued', 'UX'); f.append('a', 'done'); f.append('c', 'queued');
    await f.run('list', '--seat', 'TC', '--status', 'queued', '--json');
    expect(JSON.parse(f.output.at(-1)!)).toMatchObject([{ key: 'c', status: 'queued' }]);
    await f.run('list', '--seat', 'UX');
    expect(f.output.at(-1)).toContain('b UX queued');
    expect(f.rows()).toHaveLength(4);
  } finally { f.cleanup(); }
});

test('seat requests close appends one reasoned row per key, supports 24h age and writes nothing for dry-run', async () => {
  const f = fixture();
  try {
    f.append('old', 'queued');
    f.append('edge', 'queued', 'TC', '2026-10-04T00:00:00.000Z');
    f.append('new', 'queued', 'TC', '2026-10-04T00:00:00.001Z');
    const before = readFileSync(f.path, 'utf8');
    await f.run('close', 'old', 'edge', 'new', '--reason', '  stale  ', '--status', 'done', '--older-than', '24h', '--dry-run');
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(f.output.at(-1)).toBe('would close old done: stale');
    await f.run('close', 'old', 'edge', 'new', '--reason', 'stale', '--status', 'done', '--older-than', '24h');
    expect(f.rows()).toHaveLength(4);
    expect(f.rows().at(-1)).toMatchObject({ key: 'old', status: 'done', reason: 'stale', closedAt: '2026-10-05T00:00:00.000Z', text: 'request old', receiptId: 'receipt-old' });
    await f.run('list', '--status', 'queued', '--json');
    expect((JSON.parse(f.output.at(-1)!) as Array<{ key: string }>).map((row) => row.key)).toEqual(['edge', 'new']);
    await f.run('close', 'edge', 'new', '--reason', 'withdrawn');
    expect(f.rows()).toHaveLength(6);
    expect(f.rows().slice(-2).map(({ key, status, reason }) => [key, status, reason]))
      .toEqual([['edge', 'rejected', 'withdrawn'], ['new', 'rejected', 'withdrawn']]);
    await f.run('close', 'old', '--reason', 'again');
    expect(f.rows()).toHaveLength(6);
  } finally { f.cleanup(); }
});

test('unknown key reports one error line without writing, including alongside valid keys', async () => {
  const f = fixture();
  try {
    f.append('known', 'queued');
    const before = readFileSync(f.path, 'utf8');
    await f.run('close', 'known', 'absent', '--reason', 'stale');
    expect(f.errors).toEqual(['seat requests close: unknown key: absent']);
    expect(process.exitCode).toBe(1);
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    process.exitCode = 0;
  } finally { f.cleanup(); }
});

test('seat requests close refuses foreign HQ holder before writing, while list and dry-run remain available', async () => {
  const f = fixture();
  try {
    f.append('known', 'queued');
    const store = fileLeaseStore(join(f.root, 'lease.json'), () => 100);
    expect(store.cas(null, serializeLease({ holder: 'other', generation: 2, acquiredAt: 100, renewedAt: 100, ttlSeconds: 1500 }))).toBe(true);
    const hq = { store, config: { hostName: 'mbp', standby: 'node-b' }, hostPath: join(f.root, 'host'),
      localPath: join(f.root, 'local.json'), seenPath: join(f.root, 'seen-generation'), now: () => 100,
      log: (() => {}) as never };
    const cli = new Command();
    registerSeatRequestsCommands(cli.command('seat'), { root: () => f.root, hq });
    const run = (...args: string[]) => cli.parseAsync(['seat', 'requests', ...args], { from: 'user' });
    await run('list', '--json');
    expect(JSON.parse(f.output.at(-1)!)).toHaveLength(1);
    await run('close', 'known', '--reason', 'stale', '--dry-run');
    expect(f.output.at(-1)).toContain('would close known');
    const before = readFileSync(f.path, 'utf8');
    await run('close', 'known', '--reason', 'stale');
    expect(process.exitCode).toBe(4);
    expect(f.errors.at(-1)).toContain('원장 쓰기는 지금 본부로 보내라');
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(existsSync(`${f.path}.lock.sqlite`)).toBe(false);
    process.exitCode = 0;
  } finally { f.cleanup(); }
});
