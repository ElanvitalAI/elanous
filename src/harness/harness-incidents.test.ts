import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Command } from 'commander';
import { detectBursts, formatIncidentBurstWarning, incidentLastLines, readRunExits, recentBurst, recordRunExit, type RunExit } from './harness-incidents.js';
import { installHarnessCliCommand, recordClassifiedHarnessPodExit, warnRecentIncidentBurst } from './harness-cli-command.js';
import * as podDispatch from './harness-pod-dispatch.js';
import { debug } from '../debug/log.js';

const roots: string[] = [];
const oldRoot = process.env.ELANOUS_STATE_DIR;
const oldPool = process.env.ELANOUS_POD_POOL;
const oldSeat = process.env.ELANOUS_HARNESS_SEAT;
const oldExit = process.exitCode;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (oldRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = oldRoot;
  if (oldPool === undefined) delete process.env.ELANOUS_POD_POOL;
  else process.env.ELANOUS_POD_POOL = oldPool;
  if (oldSeat === undefined) delete process.env.ELANOUS_HARNESS_SEAT;
  else process.env.ELANOUS_HARNESS_SEAT = oldSeat;
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
    expect(lines[0]).toContain('seat=- entrance=- reason=signal');
    expect(lines[3]).toContain('묶음 signal ×3');
  } finally { log.mockRestore(); }
});

test('Pod launch after a burst warns once and still dispatches; stale burst does not warn', async () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8';
  delete process.env.ELANOUS_HARNESS_SEAT;
  for (let n = 0; n < 3; n++) recordRunExit({ ...row(`run-${n}`, 'signal', Date.now() - 10 * 60_000), entrance: 'cli-harness-ask' }, dir);
  let dispatched = 0;
  const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation(() => { dispatched++; return 0; });
  const lines: string[] = [];
  const error = spyOn(console, 'error').mockImplementation((value) => { lines.push(String(value)); });
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const observed: Array<[string, string, unknown]> = [];
  const debugLog = spyOn(debug, 'log').mockImplementation((category, event, data) => { observed.push([category, event, data]); });
  try {
    await cli().parseAsync(['node', 'elanous', 'harness', 'ask', 'not-read-by-dispatch', '--substrate', 'pod']);
    expect(lines.filter((line) => line.startsWith('⚠ 최근 묶음 사고'))).toHaveLength(1);
    expect(observed).toContainEqual(['harness.incident', 'burst', { reason: 'signal', count: 3, entrance: 'cli-harness-ask' }]);
    expect(dispatched).toBe(1);
    expect(process.exitCode ?? 0).toBe(oldExit ?? 0);
    lines.length = 0;
    rmSync(join(dir, 'incidents'), { recursive: true });
    for (let n = 0; n < 3; n++) recordRunExit(row(`run-stale-${n}`, 'signal', Date.now() - 20 * 60_000), dir);
    await cli().parseAsync(['node', 'elanous', 'harness', 'ask', 'not-read-by-dispatch', '--substrate', 'pod']);
    expect(lines.filter((line) => line.startsWith('⚠ 최근 묶음 사고'))).toHaveLength(0);
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
    expect(readRunExits(dir)).toMatchObject([{ runId: 'run-recorded', reason: 'signal', status: 143, signal: 'SIGTERM',
      entrance: 'cli-harness-ask', lastLines: ['[self-dev] 1 goal 병렬 실행 · run run-recorded'] }]);
    recordClassifiedHarnessPodExit('run-recorded', 'signal', 143);
    expect(readRunExits(dir)).toHaveLength(1);
  } finally { dispatch.mockRestore(); error.mockRestore(); log.mockRestore(); }
});

test('Pod launch warns only for its own seat and entrance burst', async () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8';
  delete process.env.ELANOUS_HARNESS_SEAT;
  for (let n = 0; n < 3; n++) recordRunExit({ ...row(`run-mk-warning-${n}`, 'pod-error', Date.now() - 30_000 + n),
    seat: 'MK', entrance: 'cli-harness-ask' }, dir);
  const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation(() => 0);
  const errors: string[] = [];
  const error = spyOn(console, 'error').mockImplementation((line) => { errors.push(String(line)); });
  try {
    await cli().parseAsync(['node', 'elanous', 'harness', 'ask', 'not-read-by-dispatch', '--substrate', 'pod', '--seat', 'UX']);
    expect(errors.filter((line) => line.includes('최근 묶음 사고'))).toEqual([]);
    await cli().parseAsync(['node', 'elanous', 'harness', 'ask', 'not-read-by-dispatch', '--substrate', 'pod', '--seat', 'MK']);
    expect(errors.filter((line) => line.includes('최근 묶음 사고'))).toEqual([
      expect.stringContaining('seat=MK entrance=cli-harness-ask'),
    ]);
  } finally { dispatch.mockRestore(); error.mockRestore(); }
});

test('Pod ask records plain pod-error tail with its flagged seat and entrance before any run ledger exists', async () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8';
  const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation((_input, deps) => {
    deps?.onOutput?.('[self-dev] 1 goal 병렬 실행 · run run-before-ledger\npod-error: pool unavailable\n');
    return 1;
  });
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await cli().parseAsync(['node', 'elanous', 'harness', 'ask', 'not-read-by-dispatch', '--substrate', 'pod', '--seat', 'MK']);
    expect(readRunExits(dir)).toMatchObject([{ runId: 'run-before-ledger', reason: 'pod-error',
      seat: 'MK', entrance: 'cli-harness-ask', lastLines: [expect.any(String), 'pod-error: pool unavailable'] }]);
    expect(process.exitCode).toBe(1);
  } finally { dispatch.mockRestore(); error.mockRestore(); }
});

test('Pod launch retains an inherited harness seat in its incident', async () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8';
  process.env.ELANOUS_HARNESS_SEAT = 'TC';
  const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation((_input, deps) => {
    deps?.onOutput?.('[self-dev] 1 goal 병렬 실행 · run run-env-seat\npod-error: pool unavailable\n');
    return 1;
  });
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await cli().parseAsync(['node', 'elanous', 'harness', 'ask', 'not-read-by-dispatch', '--substrate', 'pod']);
    expect(readRunExits(dir)).toMatchObject([{ runId: 'run-env-seat', entrance: 'cli-harness-ask', seat: 'TC' }]);
  } finally { dispatch.mockRestore(); error.mockRestore(); }
});

test('Pod launch uses a flagged seat over an inherited seat when recording incidents', async () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8';
  process.env.ELANOUS_HARNESS_SEAT = 'TC';
  const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation((_input, deps) => {
    deps?.onOutput?.('[self-dev] 1 goal 병렬 실행 · run run-flag-seat\npod-error: pool unavailable\n');
    return 1;
  });
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await cli().parseAsync(['node', 'elanous', 'harness', 'ask', 'not-read-by-dispatch', '--substrate', 'pod', '--seat', 'MK']);
    expect(readRunExits(dir)).toMatchObject([{ runId: 'run-flag-seat', entrance: 'cli-harness-ask', seat: 'MK' }]);
  } finally { dispatch.mockRestore(); error.mockRestore(); }
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
  for (let n = 0; n < 3; n++) recordRunExit({ ...row(`run-dev-${n}`, 'signal', Date.now() - 5 * 60_000), entrance: 'cli-dev-ask' }, dir);
  const lines: string[] = [];
  expect(warnRecentIncidentBurst(dir, new Date(), (line) => lines.push(line), { entrance: 'cli-dev-ask' })).toBe(true);
  expect(lines.filter((line) => line.startsWith('⚠ 최근 묶음 사고'))).toHaveLength(1);
  const quiet = root();
  expect(warnRecentIncidentBurst(quiet, new Date(), (line) => lines.push(line))).toBe(false);
  expect(warnRecentIncidentBurst(join(quiet, 'missing', '\0bad'), new Date(), (line) => lines.push(line))).toBe(false);
  expect(lines).toHaveLength(1);
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const devPod = source.slice(source.indexOf("if (devAskSubstrate?.substrate === 'pod')"));
  const warnAt = devPod.indexOf('warnRecentIncidentBurst(');
  const dispatchAt = devPod.indexOf('await dispatchHarnessOnPod(');
  expect(warnAt).toBeGreaterThan(0);
  expect(dispatchAt).toBeGreaterThan(warnAt);
});

test('incident tail scrubs secrets before the 200-character cap and keeps the last three nonempty lines', () => {
  const token = 'ghp_' + 'a'.repeat(36);
  const result = incidentLastLines(`first\n\nsecond\n${'x'.repeat(190)} ${token}\nfourth\n`);
  expect(result).toHaveLength(3);
  expect(result[0]).toBe('second');
  expect(result[1]!.length).toBeLessThanOrEqual(200);
  expect(result[1]).toContain('ghp_***');
  expect(result.join(' ')).not.toContain(token);
  expect(result[2]).toBe('fourth');
});

test('recorded exit carries entrance, explicit seat, short cwd/host, pid and redacted output tail', () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  process.env.ELANOUS_HARNESS_SEAT = 'UX';
  const token = 'ghp_' + 'b'.repeat(36);
  recordClassifiedHarnessPodExit('run-fields', 'pod-error', 1,
    { entrance: 'cli-harness-say', seat: 'MK', output: `[self-dev] run run-fields\npod-error: ${token}\n` });
  const [recorded] = readRunExits(dir);
  expect(recorded).toMatchObject({ runId: 'run-fields', reason: 'pod-error', entrance: 'cli-harness-say',
    seat: 'MK', cwd: `${basename(dirname(process.cwd()))}/${basename(process.cwd())}`,
    hostname: hostname().split('.')[0], pid: process.pid,
    lastLines: ['[self-dev] run run-fields', expect.stringContaining('pod-error:')] });
  expect(JSON.stringify(recorded)).not.toContain(token);
  expect(readFileSync(join(dir, 'incidents', readdirSync(join(dir, 'incidents'))[0]!), 'utf8')).not.toContain(token);
});

test('incidents --json exposes recorded owner and redacted tail without revealing the token', async () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  const token = 'ghp_' + 'd'.repeat(36);
  recordClassifiedHarnessPodExit('run-cli-json', 'pod-error', 1,
    { entrance: 'cli-harness-ask', seat: 'OP', output: `pod-error: ${token}\n` });
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line) => { lines.push(String(line)); });
  try {
    await cli().parseAsync(['node', 'elanous', 'harness', 'incidents', '--json']);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ rows: [{ runId: 'run-cli-json', reason: 'pod-error',
      entrance: 'cli-harness-ask', seat: 'OP', lastLines: ['pod-error: ghp_***'] }] });
    expect(lines[0]).not.toContain(token);
    lines.length = 0;
    await cli().parseAsync(['node', 'elanous', 'harness', 'incidents']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('seat=OP entrance=cli-harness-ask reason=pod-error');
    expect(lines[0]).not.toContain(token);
  } finally { log.mockRestore(); }
});

test('incident recorder takes seat from the inherited harness environment when no flag is supplied', () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  process.env.ELANOUS_HARNESS_SEAT = 'TC';
  recordClassifiedHarnessPodExit('run-inherited', 'unknown', 1,
    { entrance: 'cli-dev-ask', output: 'unrecognized failure' });
  expect(readRunExits(dir)).toMatchObject([{ runId: 'run-inherited', seat: 'TC', entrance: 'cli-dev-ask' }]);
});

test('recordRunExit itself scrubs a supplied tail before appending to JSONL', () => {
  const dir = root();
  const token = 'ghp_' + 'c'.repeat(36);
  recordRunExit({ ...row('run-direct', 'unknown', Date.now()), lastLines: [`pod-error: ${token}`, 'x'.repeat(250)] }, dir);
  expect(readRunExits(dir)[0]?.lastLines).toEqual(['pod-error: ghp_***', 'x'.repeat(200)]);
  const stored = readFileSync(join(dir, 'incidents', readdirSync(join(dir, 'incidents'))[0]!), 'utf8');
  expect(stored).not.toContain(token);
});

test('bursts are isolated by seat and entrance and a warning names only its own owner', () => {
  const dir = root();
  const at = Date.now() - 60_000;
  for (let n = 0; n < 3; n++) {
    recordRunExit({ ...row(`run-mk-${n}`, 'unknown', at + n), seat: 'MK', entrance: 'cli-harness-ask' }, dir);
    recordRunExit({ ...row(`run-ux-${n}`, 'unknown', at + n), seat: 'UX', entrance: 'cli-harness-ask' }, dir);
    recordRunExit({ ...row(`run-mk-say-${n}`, 'unknown', at + n), seat: 'MK', entrance: 'cli-harness-say' }, dir);
  }
  const bursts = detectBursts(readRunExits(dir));
  expect(bursts).toHaveLength(3);
  expect(bursts.map((burst) => burst.count)).toEqual([3, 3, 3]);
  const lines: string[] = [];
  expect(warnRecentIncidentBurst(dir, new Date(), (line) => lines.push(line), { seat: 'TC', entrance: 'cli-harness-ask' })).toBe(false);
  expect(warnRecentIncidentBurst(dir, new Date(), (line) => lines.push(line), { seat: 'MK', entrance: 'cli-harness-ask' })).toBe(true);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('seat=MK entrance=cli-harness-ask');
  expect(lines[0]).not.toContain('UX');
  expect(formatIncidentBurstWarning(bursts.find((burst) => burst.seat === 'UX')!)).toContain('seat=UX');
});
