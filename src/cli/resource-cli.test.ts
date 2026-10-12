import { afterEach, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { trafficTick } from '../loops/orchestrator/traffic.js';
import { debug } from '../debug/log.js';
import { program } from '../index.js';
import { registerResourceCommands } from './resource-cli.js';

const resource = trafficTick({
  now: new Date('2026-10-05T00:00:00Z'), caps: { OP: 2, TC: 4, MK: 6, UX: 2 }, totalSlots: 14,
  processes: [{ seat: 'MK', elapsedSeconds: 2400, command: 'bun bin/elanous.mjs harness ask goal' }],
  openCells: [
    { owner: 'OP', status: 'yellow', id: 'OP-1', title: 'OP next' },
    { owner: 'TC', status: 'yellow', id: 'TC-1', title: 'TC next' },
    { owner: 'MK', status: 'yellow', id: 'MK-1', title: 'MK next' },
    { owner: 'UX', status: 'yellow', id: 'UX-1', title: 'UX next' },
  ], nextRound: [], retainQueuedCells: true,
});

const originalExitCode = process.exitCode;
afterEach(() => { process.exitCode = originalExitCode ?? 0; });

test('index registers resource status alongside loop without changing the other commands', () => {
  expect(program.commands.map(command => command.name())).toContain('resource');
  const resourceCommand = program.commands.find(command => command.name() === 'resource')!;
  expect(resourceCommand.commands.map(command => command.name())).toEqual(['status']);
  expect(resourceCommand.commands[0]!.options.map(option => option.flags)).toEqual(['--json']);
  expect(program.commands.find(command => command.name() === 'loop')).toBeDefined();
});

test('status --json carries the injected Nexus snapshot verbatim and records the read', async () => {
  const root = new Command();
  let calls = 0;
  registerResourceCommands(root, () => { calls++; return resource; });
  const chunks: string[] = [];
  const write = process.stdout.write;
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    chunks.push(String(chunk)); callback?.(); return true;
  }) as typeof process.stdout.write;
  try {
    await root.parseAsync(['node', 'elanous', 'resource', 'status', '--json']);
    expect(chunks.join('')).toBe(JSON.stringify({ resource, readStatus: 'ok' }) + '\n');
    expect(JSON.parse(chunks.join(''))).toEqual({ resource: JSON.parse(JSON.stringify(resource)), readStatus: 'ok' });
    expect(calls).toBe(1);
    expect(log).toHaveBeenCalledWith('resource.loop', 'status-read', { readStatus: 'ok', seats: 4, cells: 4 });
    expect(process.exitCode).toBe(0);
  } finally { process.stdout.write = write; log.mockRestore(); }
});

test('failed process observation is unreadable with reason and exit 1, not an empty resource', async () => {
  const root = new Command();
  registerResourceCommands(root, () => { throw new Error('process observation unavailable'); });
  const chunks: string[] = [];
  const write = process.stdout.write;
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    chunks.push(String(chunk)); callback?.(); return true;
  }) as typeof process.stdout.write;
  try {
    await root.parseAsync(['node', 'elanous', 'resource', 'status', '--json']);
    expect(JSON.parse(chunks.join(''))).toEqual({ readStatus: 'unreadable', reason: 'process observation unavailable' });
    expect(chunks.join('')).not.toContain('"resource"');
    expect(log).toHaveBeenCalledWith('resource.loop', 'status-read', { readStatus: 'unreadable', seats: null, cells: null });
    expect(process.exitCode).toBe(1);
  } finally { process.stdout.write = write; log.mockRestore(); }
});

test('human observation failure prints the reason and exits nonzero', async () => {
  const root = new Command();
  registerResourceCommands(root, () => { throw new Error('process observation unknown'); });
  const errors: string[] = [];
  const print = spyOn(console, 'error').mockImplementation((line: unknown) => { errors.push(String(line)); });
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    await root.parseAsync(['node', 'elanous', 'resource', 'status']);
    expect(errors).toEqual(['resource status: 못 읽음 — process observation unknown']);
    expect(process.exitCode).toBe(1);
  } finally { print.mockRestore(); log.mockRestore(); }
});

test('human status prints all four seats with observed slots, next cells and a waiting reason', async () => {
  const root = new Command();
  const observed = { ...resource, seats: resource.seats.map(row => row.seat === 'OP' ? { ...row, borrowed: 1 }
    : row.seat === 'TC' ? { ...row, lent: 1 } : row.seat === 'UX' ? { ...row, nextCell: null } : row) };
  registerResourceCommands(root, () => observed);
  const lines: string[] = [];
  const print = spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
  try {
    await root.parseAsync(['node', 'elanous', 'resource', 'status']);
    expect(lines).toHaveLength(5);
    for (const [index, seat] of ['OP', 'TC', 'MK', 'UX'].entries()) {
      expect(lines[index + 1]).toMatch(new RegExp(`^${seat}\\t`));
      if (seat !== 'UX') expect(lines[index + 1]).toContain(`${seat}-1`);
      expect(lines[index + 1]).toContain(seat === 'UX' ? '0\t' : '대기');
    }
    expect(lines[0]).toContain('임대');
    expect(lines[1]).toContain('1/0');
    expect(lines[2]).toContain('0/1');
    expect(lines[3]).toContain('1/6');
    expect(lines[4]).toContain('다음 칸 없음');
  } finally { print.mockRestore(); }
});

test('multi-line checklist titles stay on one table row per seat (first line · capped)', async () => {
  const root = new Command();
  const longTitle = `대상 경로: src/a.ts · src/b.ts ${'x'.repeat(80)}\n신설: src/c.ts\n현재 계약: bun test src/a.test.ts → 1 pass`;
  const observed = { ...resource, seats: resource.seats.map(row => row.nextCell ? { ...row, nextCell: { ...row.nextCell, title: longTitle } } : row) };
  registerResourceCommands(root, () => observed);
  const lines: string[] = [];
  const print = spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
  try {
    await root.parseAsync(['node', 'elanous', 'resource', 'status']);
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(line).not.toContain('\n');
    expect(lines[1]).toContain('대상 경로: src/a.ts');
    expect(lines[1]).not.toContain('신설:');
    expect(lines[1]).toContain('…');
    for (const line of lines.slice(1)) expect(line.split('\t')).toHaveLength(5);
  } finally { print.mockRestore(); }
});
