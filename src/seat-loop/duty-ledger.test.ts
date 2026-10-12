import { expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSeatRequestsCommands } from '../cli/seat-requests-cli.js';
import { appendDuty, listDuties, type DutyInput } from './duty-ledger.js';

function tempRoot(): { root: string; path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'duty-ledger-'));
  return { root, path: join(root, 'seat-duties', 'duties.jsonl'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('appendDuty twice then listDuties returns both rows in at order', () => {
  const t = tempRoot();
  try {
    appendDuty(t.root, { seat: 'MK', duty: 'later', source: 'test', at: '2026-10-11T02:00:00.000Z' });
    appendDuty(t.root, { seat: 'role:scout', duty: 'earlier', source: 'test', ref: 'r1', status: 'done', at: '2026-10-11T01:00:00.000Z' });
    expect(listDuties(t.root).map((row) => [row.duty, row.seat, row.status, row.ref]))
      .toEqual([['earlier', 'role:scout', 'done', 'r1'], ['later', 'MK', 'standing', undefined]]);
    expect(listDuties(t.root, { seat: 'MK' })).toHaveLength(1);
    expect(readFileSync(t.path, 'utf8').trim().split('\n')).toHaveLength(2);
  } finally { t.cleanup(); }
});

test('out-of-schema key, invalid status or invalid seat throws and writes nothing', () => {
  const t = tempRoot();
  try {
    expect(() => appendDuty(t.root, { seat: 'MK', duty: 'x', source: 's', owner: 'me' } as DutyInput)).toThrow('unknown duty key: owner');
    expect(() => appendDuty(t.root, { seat: 'MK', duty: 'x', source: 's', status: 'late' } as unknown as DutyInput)).toThrow('invalid duty status');
    expect(() => appendDuty(t.root, { seat: 'CEO', duty: 'x', source: 's' })).toThrow('invalid duty seat');
    expect(existsSync(t.path)).toBe(false);
    appendDuty(t.root, { seat: 'OP', duty: 'ok', source: 's' });
    const before = readFileSync(t.path, 'utf8');
    expect(() => appendDuty(t.root, { seat: 'OP', duty: 'y', source: 's', owner: 'me' } as DutyInput)).toThrow();
    expect(readFileSync(t.path, 'utf8')).toBe(before);
  } finally { t.cleanup(); }
});

test('seat duty add then seat duty ls --json round-trips the same row with an injected root', async () => {
  const t = tempRoot();
  const output: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => { output.push(line); });
  const error = spyOn(console, 'error').mockImplementation((line: string) => { errors.push(line); });
  const exit = process.exitCode;
  try {
    const cli = new Command();
    registerSeatRequestsCommands(cli.command('seat'), { root: () => t.root, now: () => new Date('2026-10-11T03:00:00.000Z') });
    const run = (...args: string[]) => cli.parseAsync(['seat', 'duty', ...args], { from: 'user' });
    await run('add', 'MK', 'morning brief', '--source', 'role-table', '--ref', 'doc:MK');
    await run('ls', '--json');
    expect(JSON.parse(output.at(-1)!)).toEqual([
      { at: '2026-10-11T03:00:00.000Z', seat: 'MK', duty: 'morning brief', source: 'role-table', status: 'standing', ref: 'doc:MK' },
    ]);
    expect(JSON.parse(output.at(-1)!)).toEqual(listDuties(t.root));
    await run('ls', '--seat', 'UX', '--json');
    expect(JSON.parse(output.at(-1)!)).toEqual([]);
    await run('add', 'MK', 'bad', '--source', 's', '--status', 'late');
    expect(errors.at(-1)).toContain('seat duty add: invalid duty status');
    expect(listDuties(t.root)).toHaveLength(1);
  } finally {
    log.mockRestore(); error.mockRestore(); process.exitCode = exit ?? 0; t.cleanup();
  }
});
