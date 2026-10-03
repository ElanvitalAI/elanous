import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { detectBursts, formatIncidentBurstWarning, readRunExits, recentBurst, recordRunExit, type RunExit } from './harness-incidents.js';
import { installHarnessCliCommand, recordClassifiedHarnessPodExit, warnRecentIncidentBurst } from './harness-cli-command.js';
import * as podDispatch from './harness-pod-dispatch.js';
import { debug } from '../debug/log.js';

const roots: string[] = [];
const oldRoot = process.env.ELANOUS_STATE_DIR;
const oldPool = process.env.ELANOUS_POD_POOL;
const oldExit = process.exitCode;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (oldRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = oldRoot;
  if (oldPool === undefined) delete process.env.ELANOUS_POD_POOL;
  else process.env.ELANOUS_POD_POOL = oldPool;
  process.exitCode = oldExit ?? 0;
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-incidents-'));
  roots.push(dir);
  return dir;
}
function row(id: string, reason: string, at: number): RunExit {
  return { runId: id, reason, status: 143, signal: 'SIGTERM', at: new Date(at).toISOString() };
}
function cli() {
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', ask: async () => {} });
  return program;
}

test('seven signal exits in a minute form exactly one burst; spread unknown exits do not', () => {
  const at = Date.parse('2026-10-02T13:49:07.000Z');
  const rows = Array.from({ length: 7 }, (_, n) => row(`run-${n}`, 'signal', at + n));
  expect(detectBursts(rows)).toEqual([{ reason: 'signal', count: 7, firstAt: rows[0]!.at,
    lastAt: rows[6]!.at, runIds: rows.map((item) => item.runId) }]);
  expect(detectBursts([row('run-a', 'unknown', at), row('run-b', 'unknown', at + 5 * 60_000),
    row('run-c', 'unknown', at + 10 * 60_000)])).toEqual([]);
});

test('KST ledger is idempotent per run even across files, and absent runId is not recorded', () => {
  const dir = root();
  const first = row('run-first', 'signal', Date.parse('2026-10-02T14:59:59Z'));
  recordRunExit(first, dir);
  recordRunExit({ ...first, at: '2026-10-02T15:00:01Z' }, dir);
  recordRunExit(row('', 'signal', Date.now()), dir);
  const missingIdRoot = root();
  recordRunExit(row('', 'signal', Date.now()), missingIdRoot);
  expect(readRunExits(missingIdRoot)).toEqual([]);
  expect(readdirSync(missingIdRoot)).toEqual([]);
  expect(readdirSync(join(dir, 'incidents')).filter((name) => name.endsWith('.jsonl'))).toEqual(['2026-10-02.jsonl']);
  expect(readFileSync(join(dir, 'incidents', '2026-10-02.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(readRunExits(dir)).toEqual([first]);
  const nextDay = row('run-next', 'signal', Date.parse('2026-10-02T15:00:01Z'));
  recordRunExit(nextDay, dir);
  // readdir order is filesystem-defined (APFS is not sorted) — compare as a set.
  expect(readdirSync(join(dir, 'incidents')).sort()).toEqual(['2026-10-02.jsonl', '2026-10-03.jsonl']);
  expect(readRunExits(dir)).toEqual([first, nextDay]);
});

test('simultaneous duplicate writers leave exactly one JSONL row', async () => {
  const dir = root();
  const at = Date.parse('2026-10-02T13:49:07Z');
  const write = () => new Promise<void>((resolve, reject) => {
    Bun.spawn(['bun', 'src/harness/harness-incidents-writer.fixture.ts', dir, JSON.stringify(row('run-shared', 'signal', at))], {
      stdout: 'ignore', stderr: 'ignore', onExit: (_process, code) => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)),
    });
  });
  await Promise.all([write(), write()]);
  expect(readRunExits(dir)).toHaveLength(1);
  expect(readFileSync(join(dir, 'incidents', '2026-10-02.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});

test('a paused lock owner survives a contender and records one row after resuming', async () => {
  const dir = root();
  const exit = row('run-paused', 'signal', Date.parse('2026-10-02T13:49:07Z'));
  const owner = Bun.spawn(['bun', 'src/harness/harness-incidents-writer.fixture.ts', dir, JSON.stringify(exit), 'hold'], {
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const reader = owner.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('locked');
    reader.releaseLock();
    const contender = Bun.spawn(['bun', 'src/harness/harness-incidents-writer.fixture.ts', dir, JSON.stringify(exit)], {
      stdout: 'pipe', stderr: 'pipe',
    });
    try {
      await Bun.sleep(100);
      expect(contender.exitCode).toBeNull();
      writeFileSync(join(dir, 'release-hold'), '');
      expect(await owner.exited).toBe(0);
      expect(await contender.exited).toBe(0);
      expect(readRunExits(dir)).toEqual([exit]);
      expect(readFileSync(join(dir, 'incidents', '2026-10-02.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      if (contender.exitCode === null) contender.kill();
    }
  } finally {
    if (owner.exitCode === null) owner.kill();
  }
});

test('a writer killed while holding the lock releases it for another writer', async () => {
  const dir = root();
  const exit = row('run-killed', 'signal', Date.parse('2026-10-02T13:49:07Z'));
  const child = Bun.spawn(['bun', 'src/harness/harness-incidents-writer.fixture.ts', dir, JSON.stringify(exit), 'hold'], {
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain('locked');
    reader.releaseLock();
    child.kill();
    await child.exited;
    recordRunExit(exit, dir);
    recordRunExit(exit, dir);
    expect(readRunExits(dir)).toEqual([exit]);
    expect(readFileSync(join(dir, 'incidents', '2026-10-02.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test('an append failure leaves no row so a later write can succeed', () => {
  const dir = root();
  const at = Date.parse('2026-10-02T13:49:07Z');
  const path = join(dir, 'incidents');
  mkdirSync(path);
  mkdirSync(join(path, '2026-10-02.jsonl'));
  expect(() => recordRunExit(row('run-retry', 'signal', at), dir)).toThrow();
  rmSync(join(path, '2026-10-02.jsonl'), { recursive: true });
  recordRunExit(row('run-retry', 'signal', at), dir);
  expect(readRunExits(dir)).toHaveLength(1);
});

test('burst ten minutes later warns once; twenty minutes later does not warn', () => {
  const dir = root();
  const at = Date.parse('2026-10-02T13:49:07Z');
  for (let n = 0; n < 7; n++) recordRunExit(row(`run-${n}`, 'signal', at), dir);
  const burst = recentBurst(dir, new Date(at + 10 * 60_000));
  expect(burst?.count).toBe(7);
  expect(formatIncidentBurstWarning(burst!)).toBe('⚠ 최근 묶음 사고: signal ×7 (22:49 KST) — 원인 확인 전 재발사는 중복·재사고 위험 · elanous harness incidents');
  expect(recentBurst(dir, new Date(at + 20 * 60_000))).toBeNull();
});

test('CLI incidents reads rows and bursts in JSON or human format and distinguishes missing records', async () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  const program = cli();
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((value) => { lines.push(String(value)); });
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'incidents']);
    expect(lines).toEqual(['기록 없음 — 사고 0 이 아니라 아직 기록이 없다']);
    expect(process.exitCode ?? 0).toBe(oldExit ?? 0);
    expect(readdirSync(dir)).toEqual([]);
    lines.length = 0;
    await program.parseAsync(['node', 'elanous', 'harness', 'incidents', '--json']);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ rows: [], bursts: [] });
    expect(process.exitCode ?? 0).toBe(oldExit ?? 0);
    const at = Date.now() - 10 * 60_000;
    for (let n = 0; n < 3; n++) recordRunExit(row(`run-${n}`, 'signal', at + n), dir);
    lines.length = 0;
    await program.parseAsync(['node', 'elanous', 'harness', 'incidents', '--since', '11', '--json']);
    expect(JSON.parse(lines[0]!)).toMatchObject({ rows: [{ runId: 'run-0' }, { runId: 'run-1' }, { runId: 'run-2' }], bursts: [{ reason: 'signal', count: 3 }] });
    lines.length = 0;
    await program.parseAsync(['node', 'elanous', 'harness', 'incidents', '--since', '11']);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain('묶음 signal ×3');
  } finally { log.mockRestore(); }
});

test('Pod launch after a burst warns once and still dispatches; stale burst does not warn', async () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8';
  for (let n = 0; n < 3; n++) recordRunExit(row(`run-${n}`, 'signal', Date.now() - 10 * 60_000), dir);
  let dispatched = 0;
  const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation(() => { dispatched++; return 0; });
  const lines: string[] = [];
  const error = spyOn(console, 'error').mockImplementation((value) => { lines.push(String(value)); });
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const observed: Array<[string, string, unknown]> = [];
  const debugLog = spyOn(debug, 'log').mockImplementation((category, event, data) => { observed.push([category, event, data]); });
  try {
    await cli().parseAsync(['node', 'elanous', 'harness', 'ask', 'not-read-by-dispatch', '--substrate', 'pod']);
    expect(lines.filter((line) => line.startsWith('⚠ 최근 묶음 사고:'))).toHaveLength(1);
    expect(observed).toContainEqual(['harness.incident', 'burst', { reason: 'signal', count: 3 }]);
    expect(dispatched).toBe(1);
    expect(process.exitCode ?? 0).toBe(oldExit ?? 0);
    lines.length = 0;
    rmSync(join(dir, 'incidents'), { recursive: true });
    for (let n = 0; n < 3; n++) recordRunExit(row(`run-stale-${n}`, 'signal', Date.now() - 20 * 60_000), dir);
    await cli().parseAsync(['node', 'elanous', 'harness', 'ask', 'not-read-by-dispatch', '--substrate', 'pod']);
    expect(lines.filter((line) => line.startsWith('⚠ 최근 묶음 사고:'))).toHaveLength(0);
    expect(dispatched).toBe(2);
  } finally { dispatch.mockRestore(); error.mockRestore(); log.mockRestore(); debugLog.mockRestore(); }
});

test('failed Pod exit records the classified reason, status and signal once without changing the classified line', async () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8';
  const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation((_input, deps) => {
    deps?.onOutput?.('[self-dev] 1 goal 병렬 실행 · run run-recorded\n');
    return 143;
  });
  const lines: string[] = [];
  const error = spyOn(console, 'error').mockImplementation((value) => { lines.push(String(value)); });
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await cli().parseAsync(['node', 'elanous', 'harness', 'ask', 'not-read-by-dispatch', '--substrate', 'pod']);
    expect(lines).toEqual(['런이 멈췄다(SIGTERM) — `harness stop` 이나 세션 종료일 수 있다 · 그 전까지 만든 PR 은 남아 있다']);
    expect(process.exitCode).toBe(143);
    expect(readRunExits(dir)).toMatchObject([{ runId: 'run-recorded', reason: 'signal', status: 143, signal: 'SIGTERM' }]);
    recordClassifiedHarnessPodExit('run-recorded', 'signal', 143);
    expect(readRunExits(dir)).toHaveLength(1);
  } finally { dispatch.mockRestore(); error.mockRestore(); log.mockRestore(); }
});

test('unwritable incident path leaves classified output and exit untouched', async () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8';
  writeFileSync(join(dir, 'incidents'), 'not a directory');
  recordClassifiedHarnessPodExit('run-written', 'signal', 143);
  const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation((_input, deps) => {
    deps?.onOutput?.('[self-dev] 1 goal 병렬 실행 · run run-written\n');
    return 143;
  });
  const lines: string[] = [];
  const error = spyOn(console, 'error').mockImplementation((value) => { lines.push(String(value)); });
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await cli().parseAsync(['node', 'elanous', 'harness', 'ask', 'not-read-by-dispatch', '--substrate', 'pod']);
    expect(lines).toContain('런이 멈췄다(SIGTERM) — `harness stop` 이나 세션 종료일 수 있다 · 그 전까지 만든 PR 은 남아 있다');
    expect(process.exitCode).toBe(143);
    expect(readFileSync(join(dir, 'incidents'), 'utf8')).toBe('not a directory');
  } finally { dispatch.mockRestore(); error.mockRestore(); log.mockRestore(); }
});

test('dev ask --substrate pod warns through the same helper before dispatching (round 3)', () => {
  const dir = root();
  for (let n = 0; n < 3; n++) recordRunExit(row(`run-dev-${n}`, 'signal', Date.now() - 5 * 60_000), dir);
  const lines: string[] = [];
  expect(warnRecentIncidentBurst(dir, new Date(), (line) => lines.push(line))).toBe(true);
  expect(lines.filter((line) => line.startsWith('⚠ 최근 묶음 사고:'))).toHaveLength(1);
  const quiet = root();
  expect(warnRecentIncidentBurst(quiet, new Date(), (line) => lines.push(line))).toBe(false);
  expect(warnRecentIncidentBurst(join(quiet, 'missing', '\0bad'), new Date(), (line) => lines.push(line))).toBe(false);
  expect(lines).toHaveLength(1);
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const devPod = source.slice(source.indexOf("if (devAskSubstrate?.substrate === 'pod')"));
  const warnAt = devPod.indexOf('warnRecentIncidentBurst()');
  const dispatchAt = devPod.indexOf('await dispatchHarnessOnPod(');
  expect(warnAt).toBeGreaterThan(0);
  expect(dispatchAt).toBeGreaterThan(warnAt);
});
