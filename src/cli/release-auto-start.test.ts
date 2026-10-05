import { afterEach, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { setSchedule } from '../release-loop/release-schedule.js';
import { enableLandingFreeze } from '../release-loop/landing-freeze.js';
import { registerReleaseCommands } from './release-cli.js';

const version = '0.2.8';
let root = '';
const current = () => new Date(Date.now() - 60_000).toISOString();
function setup(cutAt = current()) {
  root = mkdtempSync(join(tmpdir(), 'release-auto-start-cli-'));
  setElanousConfigDir(root);
  setSchedule(version, { cutAt }, 'OP', root);
  mkdirSync(join(root, 'release', '0.2.7'), { recursive: true });
  writeFileSync(join(root, 'release', '0.2.7', 'release.json'), JSON.stringify({ version: '0.2.7', publishedAt: '2026-10-01T00:00:00Z' }));
}
afterEach(() => { resetElanousConfigDir(); if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

test('auto-start previews the scheduled cut without touching readiness, lock or graph; invalid window fails closed', async () => {
  setup();
  const lines: string[] = [];
  const output = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  const before = process.exitCode;
  let checks = 0;
  const cli = new Command();
  registerReleaseCommands(cli, { ledgerRoot: root, checklist: () => { checks++; throw new Error('preview checked readiness'); }, graph: async () => { throw new Error('preview started graph'); } });
  const run = (...args: string[]) => cli.parseAsync(['release', 'auto-start', ...args], { from: 'user' });
  try {
    process.exitCode = 0;
    await run('--window-minutes', '2');
    expect(lines.at(-1)).toContain(`· 미리 보기 ${version} · 컷 `);
    expect(lines.at(-1)).toContain('실행하려면 --apply');
    expect(checks).toBe(0);
    expect(existsSync(join(root, 'release', version, 'run.lock'))).toBe(false);
    await run('--window-minutes', '0');
    expect(process.exitCode).toBe(1);
    expect(checks).toBe(0);
  } finally { process.exitCode = before ?? 0; errors.mockRestore(); output.mockRestore(); }
});

test('auto-start --apply delegates the selected version to the guarded release run; --json prints one result line', async () => {
  setup();
  const stdout: string[] = [];
  const human: string[] = [];
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => { stdout.push(String(chunk)); (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.(); return true; }) as typeof process.stdout.write);
  const error = spyOn(console, 'error').mockImplementation((line: string) => { human.push(line); });
  const before = process.exitCode;
  let graphs = 0;
  const lock = join(root, 'release', version, 'run.lock');
  const cli = new Command();
  registerReleaseCommands(cli, { ledgerRoot: root, config: { gatePodPool: 'pool' },
    checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
    graph: async (_path, opts) => {
      expect(opts.input.version).toBe(version);
      expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid);
      graphs++;
      return { status: 'done' } as never;
    },
  });
  try {
    process.exitCode = 0;
    await cli.parseAsync(['release', 'auto-start', '--window-minutes', '2', '--apply', '--json'], { from: 'user' });
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: true, status: 'started', version });
    expect(human.join('\n')).toContain(`▶ 릴리스 루프 ${version}`);
    expect(graphs).toBe(1);
    expect(existsSync(lock)).toBe(false);
    expect(process.exitCode).toBe(0);
  } finally { process.exitCode = before ?? 0; error.mockRestore(); write.mockRestore(); }
});

test('auto-start --apply defers when freeze turns on after selection without marking the run failed', async () => {
  setup();
  const stdout: string[] = [];
  const human: string[] = [];
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write);
  const error = spyOn(console, 'error').mockImplementation((line: string) => { human.push(line); });
  const before = process.exitCode;
  let checks = 0;
  let graphs = 0;
  const cli = new Command();
  registerReleaseCommands(cli, { ledgerRoot: root, freezeRoot: root,
    checklist: () => {
      if (++checks === 1) enableLandingFreeze({ reason: 'cut paused', by: 'OP' }, root);
      return { ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] };
    },
    graph: async () => { graphs++; throw new Error('frozen release reached graph'); },
  });
  try {
    process.exitCode = 0;
    await cli.parseAsync(['release', 'auto-start', '--apply', '--json'], { from: 'user' });
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: true, status: 'skipped', version, reason: 'frozen' });
    expect(human.join('\n')).toContain('릴리스 루프 연기');
    expect(checks).toBe(1);
    expect(graphs).toBe(0);
    expect(process.exitCode).toBe(0);
  } finally { process.exitCode = before ?? 0; error.mockRestore(); write.mockRestore(); }
});

test('auto-start --apply defers when readiness changes after cut selection', async () => {
  setup();
  const stdout: string[] = [];
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write);
  const error = spyOn(console, 'error').mockImplementation(() => {});
  const before = process.exitCode;
  let checks = 0;
  const cli = new Command();
  registerReleaseCommands(cli, { ledgerRoot: root,
    checklist: () => ({ ok: ++checks === 1, red: checks === 1 ? [] : ['K1'], undecided: [], blocked: [], moved: [], knownIssues: [] }),
    graph: async () => { throw new Error('unready release reached graph'); },
  });
  try {
    process.exitCode = 0;
    await cli.parseAsync(['release', 'auto-start', '--apply', '--json'], { from: 'user' });
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: true, status: 'skipped', version, reason: 'checklist-blocked' });
    expect(checks).toBe(2);
    expect(process.exitCode).toBe(0);
  } finally { process.exitCode = before ?? 0; error.mockRestore(); write.mockRestore(); }
});

test('auto-start --apply reports a failed release run as failure, not started', async () => {
  setup();
  const stdout: string[] = [];
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write);
  const error = spyOn(console, 'error').mockImplementation(() => {});
  const before = process.exitCode;
  const cli = new Command();
  registerReleaseCommands(cli, { ledgerRoot: root, config: { gatePodPool: 'pool' },
    checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
    graph: async () => ({ status: 'failed' }) as never,
  });
  try {
    process.exitCode = 0;
    await cli.parseAsync(['release', 'auto-start', '--apply', '--json'], { from: 'user' });
    expect(JSON.parse(stdout.at(-1)!)).toMatchObject({ ok: false, error: `release run 미시작 또는 실패: ${version}` });
    expect(stdout).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  } finally { process.exitCode = before ?? 0; error.mockRestore(); write.mockRestore(); }
});

test('auto-start --apply does not launch an already-running or out-of-window cut', async () => {
  setup();
  const dir = join(root, 'release', version);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'run.lock');
  const body = JSON.stringify({ pid: process.pid, startedAt: current() });
  writeFileSync(lock, body);
  const lines: string[] = [];
  const output = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  const cli = new Command();
  registerReleaseCommands(cli, { ledgerRoot: root, checklist: () => { throw new Error('running cut reached checklist'); }, graph: async () => { throw new Error('running cut started graph'); } });
  try {
    await cli.parseAsync(['release', 'auto-start', '--window-minutes', '2', '--apply'], { from: 'user' });
    expect(lines.at(-1)).toBe(`· 릴리스 연기 ${version} · already-running`);
    expect(readFileSync(lock, 'utf8')).toBe(body);
    await cli.parseAsync(['release', 'auto-start', '--window-minutes', '0.01', '--apply'], { from: 'user' });
    expect(lines.at(-1)).toBe('· 선택할 컷 없음');
    expect(readFileSync(lock, 'utf8')).toBe(body);
  } finally { output.mockRestore(); }
});

test('auto-start --apply defers when freeze turns on after the entry check (LandingFrozenError at the run boundary)', async () => {
  setup();
  const stdout: string[] = [];
  const human: string[] = [];
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write);
  const error = spyOn(console, 'error').mockImplementation((line: string) => { human.push(line); });
  const before = process.exitCode;
  let checks = 0;
  let graphs = 0;
  const cli = new Command();
  registerReleaseCommands(cli, { ledgerRoot: root, freezeRoot: root, config: { gatePodPool: 'pool' },
    checklist: () => {
      // 1st = auto-start readiness · entry freeze check runs after it with the switch still off · 2nd+ = inside the guarded run.
      if (++checks === 2) enableLandingFreeze({ reason: 'late freeze', by: 'OP' }, root);
      return { ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] };
    },
    graph: async () => { graphs++; throw new Error('frozen release reached graph'); },
  });
  try {
    process.exitCode = 0;
    await cli.parseAsync(['release', 'auto-start', '--apply', '--json'], { from: 'user' });
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(graphs).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: true, status: 'skipped', version, reason: 'frozen' });
    expect(human.join('\n')).toContain('릴리스 루프 연기');
    expect(process.exitCode).toBe(0);
  } finally { process.exitCode = before ?? 0; error.mockRestore(); write.mockRestore(); }
});
