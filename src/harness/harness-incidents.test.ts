import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Command } from 'commander';
import { classifyIncidentReasonFromLastLines, classifyTcellHealthCards, detectBursts, detectCommonCauseBursts, findIncidentPrecedents, formatIncidentBurstWarning, incidentLastLines, readRunExits, recentBurst, recordRunExit, type RunExit, type TcellHealthCard } from './harness-incidents.js';
import { installHarnessCliCommand, recordClassifiedHarnessPodExit, warnRecentIncidentBurst } from './harness-cli-command.js';
import * as podDispatch from './harness-pod-dispatch.js';
import { debug } from '../debug/log.js';
import { appendRunLedgerEntry, runLedgerDir } from '../self-implement/run-ledger.js';
import { makeRunObserver } from '../self-implement/orchestrator.js';

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

test('T-cell shadow classifier separates five health states and groups infection by stop class, site, and signature tail', () => {
  const now = Date.parse('2026-10-28T00:00:00.000Z');
  const card = (runId: string, overrides: Partial<TcellHealthCard> = {}): TcellHealthCard => ({
    runId, stage: 'implement', startedAt: now - 60_000, progressAt: now - 60_000, stageBudgetMs: 5 * 60_000,
    heartbeatAt: now, parentPresent: true, leaseExpiresAt: now + 60_000, riskSignal: false, ...overrides,
  });
  const cards = [
    card('healthy'),
    card('slow', { progressAt: now - 11 * 60_000 }),
    card('stalled', { startedAt: now - 31 * 60_000, progressAt: now - 30 * 60_000 }),
    card('zombie', { parentPresent: false }),
    card('infected-a', { stopClass: 'pod-died', site: 'launch', signatureTail: 'sig-tail-a', hostname: 'node-b' }),
    card('infected-b', { stopClass: 'pod-died', site: 'launch', signatureTail: 'sig-tail-a', hostname: 'node-c' }),
    card('infected-c', { stopClass: 'pod-died', site: 'launch', signatureTail: 'sig-tail-a', hostname: 'wsl' }),
    card('unmeasured', { heartbeatAt: Number.NaN }),
  ];
  const result = classifyTcellHealthCards(cards, now);
  expect(result.counts).toEqual({ healthy: 1, slow: 1, stalled: 1, infected: 3, zombie: 1 });
  expect(result.unmeasuredRunIds).toEqual(['unmeasured']);
  expect(result.total).toBe(8);
  expect(result.measured).toBe(7);
  const infected = result.decisions.filter((decision) => decision.classification === 'infected');
  expect(infected.map(({ runId }) => runId)).toEqual(['infected-a', 'infected-b', 'infected-c']);
  expect(new Set(infected.map(({ causeGroupId }) => causeGroupId)).size).toBe(1); // host is not part of the cause key
  expect(infected.every(({ causeGroupSize }) => causeGroupSize === 3)).toBe(true);
});

test('seven signal exits in a minute form exactly one burst; spread unknown exits do not', () => {
  const at = Date.parse('2026-10-02T13:49:07.000Z');
  const rows = Array.from({ length: 7 }, (_, n) => row(`run-${n}`, 'signal', at + n));
  expect(detectBursts(rows)).toEqual([{ reason: 'signal', count: 7, firstAt: rows[0]!.at,
    lastAt: rows[6]!.at, runIds: rows.map((item) => item.runId) }]);
  expect(detectBursts([row('run-a', 'unknown', at), row('run-b', 'unknown', at + 5 * 60_000),
    row('run-c', 'unknown', at + 10 * 60_000)])).toEqual([]);
});

test('same hostname and reason form a 60-minute common-cause burst across seats', () => {
  const at = Date.parse('2026-10-02T13:49:07.000Z');
  const rows: RunExit[] = [
    { ...row('run-a', 'signal', at), hostname: 'node-b', seat: 'MK', entrance: 'cli-harness-ask' },
    { ...row('run-b', 'signal', at + 20 * 60_000), hostname: 'node-b', seat: 'UX', entrance: 'cli-dev-ask' },
    { ...row('run-c', 'signal', at + 50 * 60_000), hostname: 'node-b', seat: 'TC', entrance: 'cli-harness-say' },
  ];
  expect(detectBursts(rows)).toEqual([{
    reason: 'signal', count: 3, firstAt: rows[0]!.at, lastAt: rows[2]!.at,
    runIds: ['run-a', 'run-b', 'run-c'], hostname: 'node-b',
  }]);
});

test('hostname common-cause burst requires three exits, one host, one reason, and a 60-minute window', () => {
  const at = Date.parse('2026-10-02T13:49:07.000Z');
  expect(detectBursts([
    { ...row('run-a', 'signal', at), hostname: 'node-b' },
    { ...row('run-b', 'signal', at + 20 * 60_000), hostname: 'node-b' },
  ])).toEqual([]);
  expect(detectBursts([
    { ...row('run-a', 'signal', at), hostname: 'node-b' },
    { ...row('run-b', 'signal', at + 20 * 60_000), hostname: 'msb2' },
    { ...row('run-c', 'signal', at + 40 * 60_000), hostname: 'msb3' },
  ])).toEqual([]);
  expect(detectBursts([
    { ...row('run-a', 'signal', at), hostname: 'node-b' },
    { ...row('run-b', 'unknown', at + 20 * 60_000), hostname: 'node-b' },
    { ...row('run-c', 'pod-error', at + 40 * 60_000), hostname: 'node-b' },
  ])).toEqual([]);
  expect(detectBursts([
    { ...row('run-a', 'signal', at), hostname: 'node-b' },
    { ...row('run-b', 'signal', at + 20 * 60_000), hostname: 'node-b' },
    { ...row('run-c', 'signal', at + 60 * 60_000 + 1), hostname: 'node-b' },
  ])).toEqual([]);
  const onWindow = [
    { ...row('run-a', 'signal', at), hostname: 'node-b' },
    { ...row('run-b', 'signal', at + 20 * 60_000), hostname: 'node-b' },
    { ...row('run-c', 'signal', at + 60 * 60_000), hostname: 'node-b' },
  ];
  expect(detectBursts(onWindow)).toEqual([{
    reason: 'signal', count: 3, firstAt: onWindow[0]!.at, lastAt: onWindow[2]!.at,
    runIds: ['run-a', 'run-b', 'run-c'], hostname: 'node-b',
  }]);
});

test('hostname grouping remains visible beside a same-seat burst inside the default one-minute window', () => {
  const at = Date.parse('2026-10-02T13:49:07.000Z');
  const rows = Array.from({ length: 3 }, (_, n) => ({
    ...row(`run-${n}`, 'signal', at + n), hostname: 'node-b', seat: 'MK', entrance: 'cli-harness-ask',
  }));
  expect(detectBursts(rows)).toEqual([
    { reason: 'signal', count: 3, firstAt: rows[0]!.at, lastAt: rows[2]!.at,
      runIds: ['run-0', 'run-1', 'run-2'], seat: 'MK', entrance: 'cli-harness-ask' },
    { reason: 'signal', count: 3, firstAt: rows[0]!.at, lastAt: rows[2]!.at,
      runIds: ['run-0', 'run-1', 'run-2'], hostname: 'node-b' },
  ]);
});

test('recorded cross-seat host burst does not enter the existing retry warning path', () => {
  const dir = root();
  const at = Date.now() - 60_000;
  for (const [index, seat] of ['MK', 'UX', 'TC'].entries()) {
    recordRunExit({ ...row(`host-${index}`, 'signal', at + index), hostname: 'node-b', seat,
      entrance: 'cli-harness-ask' }, dir);
  }
  expect(detectBursts(readRunExits(dir)).find((burst) => burst.hostname === 'node-b')).toMatchObject({ count: 3 });
  const lines: string[] = [];
  expect(warnRecentIncidentBurst(dir, new Date(), (line) => lines.push(line))).toBe(false);
  expect(lines).toEqual([]);
});

test('host common cause keeps its three-exit threshold when seat threshold changes', () => {
  const at = Date.parse('2026-10-15T00:00:00Z');
  const rows = [0, 1, 2].map((index) => ({ ...row(`host-${index}`, 'signal', at + index * 60_000),
    hostname: 'node-b', seat: `seat-${index}` }));
  expect(detectBursts(rows, { threshold: 2 }).filter((burst) => burst.hostname === 'node-b'))
    .toMatchObject([{ count: 3, hostname: 'node-b' }]);
});

test('detectCommonCauseBursts bundles same host+reason exits at 0/30/59 minutes across seats and entrances', () => {
  const at = Date.parse('2026-10-15T00:00:00Z');
  const rows: RunExit[] = [
    { ...row('run-a', 'signal', at), hostname: 'node-b', seat: 'MK', entrance: 'cli-harness-ask' },
    { ...row('run-b', 'signal', at + 30 * 60_000), hostname: 'node-b', seat: 'UX', entrance: 'cli-dev-ask' },
    { ...row('run-c', 'signal', at + 59 * 60_000), hostname: 'node-b', seat: 'TC', entrance: 'cli-harness-say' },
  ];
  expect(detectCommonCauseBursts(rows)).toEqual([{
    reason: 'signal', count: 3, firstAt: rows[0]!.at, lastAt: rows[2]!.at,
    runIds: ['run-a', 'run-b', 'run-c'], hostname: 'node-b',
  }]);
});

test('detectCommonCauseBursts needs three same-host same-reason exits', () => {
  const at = Date.parse('2026-10-15T00:00:00Z');
  expect(detectCommonCauseBursts([
    { ...row('run-a', 'signal', at), hostname: 'node-b' },
    { ...row('run-b', 'signal', at + 20 * 60_000), hostname: 'node-b' },
  ])).toEqual([]);
  expect(detectCommonCauseBursts([
    { ...row('run-a', 'signal', at), hostname: 'node-b' },
    { ...row('run-b', 'signal', at + 20 * 60_000), hostname: 'msb2' },
    { ...row('run-c', 'signal', at + 40 * 60_000), hostname: 'msb3' },
  ])).toEqual([]);
  expect(detectCommonCauseBursts([
    { ...row('run-a', 'signal', at), hostname: 'node-b' },
    { ...row('run-b', 'unknown', at + 20 * 60_000), hostname: 'node-b' },
    { ...row('run-c', 'pod-error', at + 40 * 60_000), hostname: 'node-b' },
  ])).toEqual([]);
});

test('detectCommonCauseBursts merges inside 60 minutes and not one millisecond beyond', () => {
  const at = Date.parse('2026-10-15T00:00:00Z');
  expect(detectCommonCauseBursts([
    { ...row('run-a', 'signal', at), hostname: 'node-b' },
    { ...row('run-b', 'signal', at + 30 * 60_000), hostname: 'node-b' },
    { ...row('run-c', 'signal', at + 60 * 60_000 + 1), hostname: 'node-b' },
  ])).toEqual([]);
  const onWindow: RunExit[] = [
    { ...row('run-on-a', 'signal', at), hostname: 'node-b' },
    { ...row('run-on-b', 'signal', at + 30 * 60_000), hostname: 'node-b' },
    { ...row('run-on-c', 'signal', at + 60 * 60_000), hostname: 'node-b' },
  ];
  expect(detectCommonCauseBursts(onWindow)).toEqual([{
    reason: 'signal', count: 3, firstAt: onWindow[0]!.at, lastAt: onWindow[2]!.at,
    runIds: ['run-on-a', 'run-on-b', 'run-on-c'], hostname: 'node-b',
  }]);
});

test('detectCommonCauseBursts never judges hostname-unobserved rows a common cause', () => {
  const at = Date.parse('2026-10-15T00:00:00Z');
  const hostless: RunExit[] = [
    { ...row('run-a', 'signal', at), seat: 'MK', entrance: 'cli-harness-ask' },
    { ...row('run-b', 'signal', at + 20 * 60_000), seat: 'UX', entrance: 'cli-dev-ask' },
    { ...row('run-c', 'signal', at + 40 * 60_000), seat: 'TC', entrance: 'cli-harness-say' },
  ];
  expect(detectCommonCauseBursts(hostless)).toEqual([]);
  expect(detectCommonCauseBursts([
    ...hostless,
    { ...row('run-d', 'signal', at + 50 * 60_000), hostname: 'node-b' },
    { ...row('run-e', 'signal', at + 55 * 60_000), hostname: 'node-b' },
  ])).toEqual([]);
});

test('detectCommonCauseBursts lets one runId contribute to one bundle only', () => {
  const at = Date.parse('2026-10-15T00:00:00Z');
  const rows: RunExit[] = [
    { ...row('run-a', 'signal', at), hostname: 'node-b' },
    { ...row('run-a', 'signal', at + 10 * 60_000), hostname: 'node-b' },
    { ...row('run-b', 'signal', at + 20 * 60_000), hostname: 'node-b' },
    { ...row('run-c', 'signal', at + 30 * 60_000), hostname: 'node-b' },
  ];
  expect(detectCommonCauseBursts(rows)).toEqual([{
    reason: 'signal', count: 3, firstAt: rows[0]!.at, lastAt: rows[3]!.at,
    runIds: ['run-a', 'run-b', 'run-c'], hostname: 'node-b',
  }]);
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
    await cli().parseAsync(['node', 'elanous', 'harness', 'ask', 'not-read-by-dispatch', '--substrate', 'pod', '--seat', 'UX', '--no-queue']);
    expect(errors.filter((line) => line.includes('최근 묶음 사고'))).toEqual([]);
    await cli().parseAsync(['node', 'elanous', 'harness', 'ask', 'not-read-by-dispatch', '--substrate', 'pod', '--seat', 'MK', '--no-queue']);
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
    await cli().parseAsync(['node', 'elanous', 'harness', 'ask', 'not-read-by-dispatch', '--substrate', 'pod', '--seat', 'MK', '--no-queue']);
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
    await cli().parseAsync(['node', 'elanous', 'harness', 'ask', 'not-read-by-dispatch', '--substrate', 'pod', '--seat', 'MK', '--no-queue']);
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

test('incident reads the child evidence ledger row even when forwarded stdout is truncated', () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  const childEvidence = { classification: 'scope-escape', scopeEscape: true as const,
    abandonedClassification: { classification: 'implementation-deficit' }, accountAvailability: { reason: 'no-candidate' } };
  appendRunLedgerEntry({ runId: 'run-evidence', event: 'pod-child-run', data: { job: 'current', childRunId: 'run-current' } }, runLedgerDir(dir));
  appendRunLedgerEntry({ runId: 'run-evidence', event: 'pod-child-evidence', data: { job: 'current', childRunId: 'run-current', childEvidence } }, runLedgerDir(dir));
  recordClassifiedHarnessPodExit('run-evidence', 'pod-failure', 1, { output: 'short tail without child JSON' });
  expect(readRunExits(dir)).toMatchObject([{ runId: 'run-evidence', reason: 'scope-escape', childEvidence }]);
});

test('POD-TERMINAL-EVIDENCE-JOIN persists current child tail, container exit, and parent verdict under one runId', () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  const runId = 'run-terminal-evidence-join';
  const job = 'si-terminal-join';
  const secret = 'ghp_123456789012345678901234567890123456';
  const termination = (exitCode: number) => ({ job, path: 'result-marker', observedAt: '2026-10-28T00:00:00Z',
    jobLookup: 'ok', jobUid: '0a1b2c3d-0000-4000-8000-0000000000ee', jobConditionReason: 'unknown', activeDeadlineSeconds: 'unknown',
    deadlineExceeded: 'unknown', podLookup: 'terminated', containerReason: exitCode === 0 ? 'Completed' : 'OOMKilled', exitCode,
    finishedAt: '2026-10-28T00:00:00Z', oomKilled: exitCode !== 0 });
  appendRunLedgerEntry({ runId, event: 'pod-child-run', data: { job, childRunId: 'child-old', attempt: 1 } }, runLedgerDir(dir));
  appendRunLedgerEntry({ runId, event: 'pod-child-evidence', data: { job, childRunId: 'child-old',
    childEvidence: { podLogTail: ['old attempt'] }, podTermination: termination(137) } }, runLedgerDir(dir));
  appendRunLedgerEntry({ runId, event: 'pod-launch-finished', data: { job, run: 'child-old', attempt: 1,
    failureClassification: 'stale-classification', terminationReason: 'stale-reason' } }, runLedgerDir(dir));
  appendRunLedgerEntry({ runId, event: 'pod-child-run', data: { job, childRunId: 'child-current', attempt: 2 } }, runLedgerDir(dir));
  appendRunLedgerEntry({ runId, event: 'pod-child-evidence', data: { job, childRunId: 'child-current',
    childEvidence: { podLogTail: [`child final: child-error ${secret}`] }, podTermination: termination(0) } }, runLedgerDir(dir));
  appendRunLedgerEntry({ runId, event: 'pod-launch-finished', data: { job, run: 'child-current', attempt: 2,
    failureClassification: 'child-error', terminationReason: `BackoffLimitExceeded ${secret}` } }, runLedgerDir(dir));

  recordClassifiedHarnessPodExit(runId, 'pod-failure', 0, { output: 'parent output' });

  expect(readRunExits(dir)).toMatchObject([{ runId, reason: 'pod-failure', status: 0, terminalEvidence: {
    job, childRunId: 'child-current', attempt: 2, childOutputTail: [`child final: child-error ${secret.slice(0, 4)}***`],
    containerExitCode: 0, parentVerdict: 'pod-failure', failureClassification: 'child-error',
    terminationReason: `BackoffLimitExceeded ${secret.slice(0, 4)}***`,
  } }]);
  const incidentFiles = readdirSync(join(dir, 'incidents'));
  expect(incidentFiles).toHaveLength(1);
  expect(incidentFiles[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/u);
  const persisted = readFileSync(join(dir, 'incidents', incidentFiles[0]!), 'utf8');
  expect(persisted).not.toContain(secret);
});

test('POD-TERMINAL-EVIDENCE-JOIN sim separates provider credential skip from malformed shard identity', () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  const at = '2026-10-28T00:00:00Z';
  const seedChild = (parentRunId: string, childRunId: string, job: string, shardFailure: string | null,
    status: 'crashed' | 'pr-opened', options: { priorShardFailure?: boolean; sameAttemptPriorShardFailure?: boolean; providerSkip?: boolean } = {}) => {
    const attempt = 1;
    if (options.priorShardFailure) {
      appendRunLedgerEntry({ runId: childRunId, timestamp: '2026-10-27T23:59:50Z', event: 'run-status', data: { stage: 'crashed', runStatus: 'failed', failureKind: 'crashed' } }, runLedgerDir(dir));
      appendRunLedgerEntry({ runId: childRunId, timestamp: '2026-10-27T23:59:51Z', event: 'shard-sibling-query',
        shardIdentityReadFailure: 'malformed-structure', data: { status: 'failed', reason: 'read-failed' } }, runLedgerDir(dir));
    }
    appendRunLedgerEntry({ runId: parentRunId, timestamp: at, event: 'pod-child-run', data: { job, childRunId, attempt } }, runLedgerDir(dir));
    appendRunLedgerEntry({ runId: parentRunId, timestamp: '2026-10-28T00:00:01Z', event: 'pod-child-evidence', data: { job, childRunId,
      childEvidence: { error: 'openrouter unavailable: configure apiKey via `elanous setup`', podLogTail: ['bounded child tail'] },
      podTermination: { job, path: 'result-marker', observedAt: at, jobLookup: 'ok', jobUid: 'job-uid',
        jobConditionReason: 'unknown', activeDeadlineSeconds: 'unknown', deadlineExceeded: 'unknown', podLookup: 'terminated',
        containerReason: 'Error', exitCode: status === 'crashed' ? 1 : 0, finishedAt: at, oomKilled: false } } }, runLedgerDir(dir));
    appendRunLedgerEntry({ runId: parentRunId, timestamp: '2026-10-28T00:00:02Z', event: 'pod-launch-finished', data: { job, run: childRunId, attempt,
      phase: status === 'crashed' ? 'failed' : 'complete', podExitClass: status === 'crashed' ? 'child-error' : null,
      childFailureStage: status === 'crashed' ? 'error' : null } }, runLedgerDir(dir));
    if (options.providerSkip !== false) appendRunLedgerEntry({ runId: childRunId, timestamp: '2026-10-28T00:00:00.500Z', event: 'goal-elaboration-skipped', data: { outcome: 'skipped', reason: 'provider-failed',
      error: 'openrouter unavailable: configure apiKey via `elanous setup`', runId: childRunId } }, runLedgerDir(dir));
    appendRunLedgerEntry({ runId: childRunId, timestamp: '2026-10-28T00:00:00.600Z', event: 'run-status', data: { stage: status, runStatus: status === 'crashed' ? 'failed' : 'completed',
      failureKind: status === 'crashed' ? 'crashed' : undefined, runId: childRunId } }, runLedgerDir(dir));
    if (options.sameAttemptPriorShardFailure) appendRunLedgerEntry({ runId: childRunId, timestamp: '2026-10-28T00:00:00.650Z', event: 'shard-sibling-query',
      shardIdentityReadFailure: 'malformed-structure', data: { status: 'failed', reason: 'read-failed' } }, runLedgerDir(dir));
    appendRunLedgerEntry({ runId: childRunId, timestamp: '2026-10-28T00:00:00.700Z', event: 'shard-sibling-query', data: {
      status: shardFailure === 'unknown' ? 'failed' : 'skipped', reason: shardFailure === 'unknown' ? 'unknown' : 'not-sharded',
      ...(shardFailure === 'unknown' ? { shardIdentityReadFailure: 'unknown' } : {}),
    }, ...(shardFailure && shardFailure !== 'unknown' ? { shardIdentityReadFailure: shardFailure } : {}) }, runLedgerDir(dir));
    recordClassifiedHarnessPodExit(parentRunId, 'pod-failure', status === 'crashed' ? 1 : 0, { output: 'simulated parent verdict' });
  };

  seedChild('parent-shard-corrupt', 'child-shard-corrupt', 'job-shard-corrupt', 'malformed-structure', 'crashed');
  seedChild('parent-shard-unknown', 'child-shard-unknown', 'job-shard-unknown', 'unknown', 'crashed');
  seedChild('parent-key-skip-only', 'child-key-skip-only', 'job-key-skip-only', null, 'pr-opened', { priorShardFailure: true, sameAttemptPriorShardFailure: true });
  seedChild('parent-provider-unknown', 'child-provider-unknown', 'job-provider-unknown', null, 'pr-opened', { providerSkip: false });

  const exits = Object.fromEntries(readRunExits(dir).map((exit) => [exit.runId, exit]));
  expect(exits['parent-shard-corrupt']).toMatchObject({ terminalEvidence: { childFailureStage: 'error', failureClassification: 'child-error',
    childRunStatus: { stage: 'crashed', status: 'failed', failureKind: 'crashed' },
    shardIdentityReadFailure: 'malformed-structure', providerFailure: 'credential-not-configured' } });
  expect(exits['parent-shard-unknown']?.terminalEvidence?.shardIdentityReadFailure).toBe('unknown');
  expect(exits['parent-key-skip-only']).toMatchObject({ terminalEvidence: { childFailureStage: 'unknown',
    childRunStatus: { stage: 'pr-opened', status: 'completed', failureKind: 'unknown' },
    shardIdentityReadFailure: 'none', providerFailure: 'credential-not-configured' } });
  expect(exits['parent-provider-unknown']?.terminalEvidence).toMatchObject({ providerFailure: 'unknown' });
});

test('POD-TERMINAL-EVIDENCE-JOIN joins shard identity written by the production child observer', () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  const observeChild = (parentRunId: string, job: string, childRunId: string, attempt: number,
    identity: { pieceTotal: number; shardIdentityReadFailure?: 'malformed-structure' | 'invalid-values' }, finalize = true) => {
    const start = new Date(Date.now() - 1_000).toISOString();
    appendRunLedgerEntry({ runId: parentRunId, timestamp: start, event: 'pod-child-run', data: { job, childRunId, attempt } }, runLedgerDir(dir));
    const observe = makeRunObserver(childRunId, undefined, () => {}, (entry) => appendRunLedgerEntry(entry, runLedgerDir(dir)), identity);
    observe('shard-sibling-query', { status: identity.shardIdentityReadFailure ? 'failed' : 'skipped',
      reason: identity.shardIdentityReadFailure ?? 'not-sharded' });
    appendRunLedgerEntry({ runId: parentRunId, timestamp: new Date(Date.now() + 60_000).toISOString(), event: 'pod-launch-finished',
      data: { job, run: childRunId, attempt } }, runLedgerDir(dir));
    if (finalize) recordClassifiedHarnessPodExit(parentRunId, 'pod-failure', 1, { output: 'simulated parent verdict' });
  };

  observeChild('parent-real-shard-failure', 'job-real-shard-failure', 'child-real-shard-failure', 1,
    { pieceTotal: 1, shardIdentityReadFailure: 'malformed-structure' });
  const malformed = readRunExits(dir).find((exit) => exit.runId === 'parent-real-shard-failure');
  expect(malformed?.terminalEvidence?.shardIdentityReadFailure).toBe('malformed-structure');

  // A later current-attempt no-sharding observation is authoritative even when the same child id has old shard facts.
  observeChild('parent-real-not-sharded', 'job-real-not-sharded', 'child-real-shared', 2,
    { pieceTotal: 1, shardIdentityReadFailure: 'malformed-structure' }, false);
  const second = makeRunObserver('child-real-shared', undefined, () => {}, (entry) => appendRunLedgerEntry(entry, runLedgerDir(dir)), { pieceTotal: 1 });
  second('shard-sibling-query', { status: 'skipped', reason: 'not-sharded' });
  appendRunLedgerEntry({ runId: 'parent-real-not-sharded', timestamp: new Date(Date.now() + 60_000).toISOString(), event: 'pod-launch-finished',
    data: { job: 'job-real-not-sharded', run: 'child-real-shared', attempt: 2 } }, runLedgerDir(dir));
  recordClassifiedHarnessPodExit('parent-real-not-sharded', 'pod-failure', 1, { output: 'simulated parent verdict' });
  const notSharded = readRunExits(dir).find((exit) => exit.runId === 'parent-real-not-sharded');
  expect(notSharded?.terminalEvidence?.shardIdentityReadFailure).toBe('none');
});

test('incident ignores earlier Pod evidence after the current attempt has no child JSON', () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  appendRunLedgerEntry({ runId: 'run-evidence-mask', event: 'pod-child-run', data: {
    job: 'old', childRunId: 'run-old' } }, runLedgerDir(dir));
  appendRunLedgerEntry({ runId: 'run-evidence-mask', event: 'pod-child-evidence', data: {
    job: 'old', childRunId: 'run-old', childEvidence: { scopeEscape: true } } }, runLedgerDir(dir));
  appendRunLedgerEntry({ runId: 'run-evidence-mask', event: 'pod-child-run', data: {
    job: 'new', childRunId: 'run-new' } }, runLedgerDir(dir));
  appendRunLedgerEntry({ runId: 'run-evidence-mask', event: 'pod-child-evidence', data: {
    job: 'new', childRunId: 'run-new', childEvidence: null } }, runLedgerDir(dir));
  recordClassifiedHarnessPodExit('run-evidence-mask', 'pod-failure', 1, { output: 'current failure' });
  expect(readRunExits(dir)).toMatchObject([{ runId: 'run-evidence-mask', reason: 'pod-failure', terminalEvidence: {
    job: 'new', childRunId: 'run-new', attempt: 'unknown', childOutputTail: 'unknown',
    containerExitCode: 'unknown', parentVerdict: 'pod-failure',
  } }]);
  expect(readRunExits(dir)[0]?.childEvidence).toBeUndefined();
});

test('incident rejects a malformed persisted scope flag', () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  appendRunLedgerEntry({ runId: 'run-evidence-malformed', event: 'pod-child-run', data: {
    job: 'current', childRunId: 'run-current' } }, runLedgerDir(dir));
  appendRunLedgerEntry({ runId: 'run-evidence-malformed', event: 'pod-child-evidence', data: {
    job: 'current', childRunId: 'run-current', childEvidence: { scopeEscape: 'false' } } }, runLedgerDir(dir));
  recordClassifiedHarnessPodExit('run-evidence-malformed', 'pod-failure', 1, { output: 'current failure' });
  expect(readRunExits(dir)).toMatchObject([{ runId: 'run-evidence-malformed', reason: 'pod-failure' }]);
  expect(readRunExits(dir)[0]?.childEvidence).toBeUndefined();
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

test('findIncidentPrecedents returns only recorded same-reason exits before the current one, newest first', () => {
  const dir = root();
  const at = Date.parse('2026-10-02T13:49:07.000Z');
  recordRunExit({ ...row('run-old', 'oom', at - 90 * 60_000) }, dir);
  recordRunExit({ ...row('run-mid', 'oom', at - 30 * 60_000), lastLines: ['boom'] }, dir);
  recordRunExit({ ...row('run-new', 'oom', at + 5 * 60_000) }, dir); // 현재 이후 — 선례 아님
  recordRunExit({ ...row('run-other', 'signal', at - 10 * 60_000) }, dir); // 다른 reason — 선례 아님
  const precedents = findIncidentPrecedents({ reason: 'oom', at: new Date(at).toISOString(), runId: 'run-current' }, dir);
  expect(precedents.map((p) => p.runId)).toEqual(['run-mid', 'run-old']);
  expect(precedents[0]).toMatchObject({ runId: 'run-mid', reason: 'oom', status: 143, signal: 'SIGTERM', lastLines: ['boom'] });
  expect(precedents[1]!.lastLines).toBeUndefined();
  // 현재 runId 자신은 제외된다
  const self = findIncidentPrecedents({ reason: 'oom', at: new Date(at).toISOString(), runId: 'run-old' }, dir);
  expect(self.map((p) => p.runId)).toEqual(['run-mid']);
  // limit 절약
  expect(findIncidentPrecedents({ reason: 'oom', at: new Date(at).toISOString() }, dir, { limit: 1 })).toHaveLength(1);
  // 기록 없는 reason 은 «기록 없음» — 빈 배열(지어내기 금지)
  expect(findIncidentPrecedents({ reason: 'no-record', at: new Date(at).toISOString() }, dir)).toEqual([]);
  // 없는 원장 디렉터리도 빈 배열
  expect(findIncidentPrecedents({ reason: 'oom', at: new Date(at).toISOString() }, join(dir, 'missing'))).toEqual([]);
  // invalid at — 빈 배열
  expect(findIncidentPrecedents({ reason: 'oom', at: 'not-a-date' }, dir)).toEqual([]);
});

// ── INCIDENT-REASON-FROM-LASTLINES ──
test('classifyIncidentReasonFromLastLines: 10-22 운영 unknown 사고의 lastLines 꼴을 사유로 나눈다 · 안 맞으면 null', () => {
  expect(classifyIncidentReasonFromLastLines(['  ❌ failed · 대상 경로: src/dashboard/index.ts — pod-deadline-exceeded'])).toBe('pod-deadline-exceeded');
  expect(classifyIncidentReasonFromLastLines(['  ❌ blocked · 대상 경로: src/x.ts — DEPENDENCY_NEEDS_HUMAN'])).toBe('dependency-needs-human');
  expect(classifyIncidentReasonFromLastLines(['  ❌ failed · c [error] — pod-job-failed: Job si-task-1 failed (BackoffLimitExceeded)'])).toBe('pod-backoff-limit');
  expect(classifyIncidentReasonFromLastLines(['  ❌ failed · d — pod-job-failed: Job si-task-2 failed — childError=no-result'])).toBe('pod-child-no-result');
  expect(classifyIncidentReasonFromLastLines(['  ❌ failed · e [aborted] — pod-job-failed: Job si-task-3 failed — '])).toBe('pod-job-failed');
  expect(classifyIncidentReasonFromLastLines(['[supervisor] 정지(needs-human)'])).toBe('needs-human');
  expect(classifyIncidentReasonFromLastLines(['goal-elaboration needs-human: goal-elaboration-ungrounded-path (attempts: 2) · ungrounded path: src/nowhere.ts'])).toBe('goal-elaboration-ungrounded-path');
  expect(classifyIncidentReasonFromLastLines(['quoted goal-elaboration-ungrounded-path in unrelated error'])).toBeNull();
  expect(classifyIncidentReasonFromLastLines(['그냥 끝났다'])).toBeNull();
  expect(classifyIncidentReasonFromLastLines(undefined)).toBeNull();
});

test('INCIDENT-REASON-FROM-LASTLINES: 충돌 꼬리는 첫 매치로 확정하지 않고 unknown을 보존한다', () => {
  // 앞 조각 실패(근본) ⊕ 뒤 조각 의존 막힘(증상) — 두 사유가 서로 다른 사건을 말한다 = 충돌
  const rootAndSymptom = ['  ❌ failed · a [needs-human] — GOAL_DONE_BOUNDARY_MISSING', '  ❌ blocked · b — DEPENDENCY_NEEDS_HUMAN'];
  expect(classifyIncidentReasonFromLastLines(rootAndSymptom)).toBeNull();
  // 줄 순서를 뒤집어도 같다 — 표 순서(첫 매치 우선순위)가 사유를 정하지 않는다
  expect(classifyIncidentReasonFromLastLines([...rootAndSymptom].reverse())).toBeNull();
  expect(classifyIncidentReasonFromLastLines(['  ❌ failed · c — pod-deadline-exceeded', '  ❌ blocked · d — [needs-human]'])).toBeNull();
  // 한 줄 안에서 서로 다른 사유가 부딪혀도 충돌이다
  expect(classifyIncidentReasonFromLastLines(['pod-deadline-exceeded · DEPENDENCY_NEEDS_HUMAN'])).toBeNull();
  // 빈 꼬리·무증거는 unknown 유지
  expect(classifyIncidentReasonFromLastLines([])).toBeNull();
  expect(classifyIncidentReasonFromLastLines([''])).toBeNull();
});

test('INCIDENT-REASON-FROM-LASTLINES: ux-sim device 표지는 사유가 아니라 조각 표지로 정규화한다', () => {
  // device 조각 표지만 있는 꼬리 — 사유를 지어내지 않고, 조각 표지는 살린다
  const deviceOnly = ['  ❌ failed · 대상 경로: src/ux-sim/hq-seats-device.ts — DEVICE-FIRST'];
  expect(classifyIncidentReasonFromLastLines(deviceOnly)).toBeNull();
  const dir = root();
  recordRunExit({ ...row('run-device', 'unknown', Date.now()), lastLines: deviceOnly }, dir);
  const device = readRunExits(dir).find((exit) => exit.runId === 'run-device')!;
  expect(device).toMatchObject({ reason: 'unknown', slice: 'device' });
  expect(device.recordedReason).toBeUndefined();
});

test('readRunExits: reason unknown 만 lastLines 로 다시 분류(원문은 recordedReason) · 기록된 구체 reason 은 그대로 · 장치 조각 표지', () => {
  const root = mkdtempSync(join(tmpdir(), 'incident-reason-'));
  try {
    mkdirSync(join(root, 'incidents'), { recursive: true });
    const rows = [
      { runId: 'run-a', reason: 'unknown', status: 1, signal: null, at: '2026-10-22T08:00:00.000Z', lastLines: ['  ❌ failed · 대상 경로: src/ux-sim/hq-seats-device.ts — pod-job-failed: Job si-task-x failed (BackoffLimitExceeded'] },
      { runId: 'run-b', reason: 'pod-failure', status: 1, signal: null, at: '2026-10-22T08:01:00.000Z', lastLines: ['— DEPENDENCY_NEEDS_HUMAN'] },
      { runId: 'run-c', reason: 'unknown', status: 1, signal: null, at: '2026-10-22T08:02:00.000Z', lastLines: ['아무 실마리 없음'] },
      { runId: 'run-d', reason: 'unknown', status: 1, signal: null, at: '2026-10-22T08:03:00.000Z', lastLines: ['goal-elaboration needs-human: goal-elaboration-ungrounded-path (attempts: 2) · ungrounded path: src/nowhere.ts'] },
      { runId: 'run-e', reason: 'unknown', status: 1, signal: null, at: '2026-10-22T08:04:00.000Z', lastLines: ['  ❌ failed · a [needs-human] — GOAL_DONE_BOUNDARY_MISSING', '  ❌ blocked · b — DEPENDENCY_NEEDS_HUMAN'] },
    ];
    writeFileSync(join(root, 'incidents', '2026-10-22.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const exits = readRunExits(root);
    const a = exits.find((e) => e.runId === 'run-a')!;
    expect(a.reason).toBe('pod-backoff-limit');
    expect(a.recordedReason).toBe('unknown');
    expect(a.reasonSource).toBe('lastLines');
    expect(a.slice).toBe('device');
    const b = exits.find((e) => e.runId === 'run-b')!;
    expect(b.reason).toBe('pod-failure'); // 구체 reason 은 덮지 않는다
    expect(b.reasonSource).toBeUndefined();
    const c = exits.find((e) => e.runId === 'run-c')!;
    expect(c.reason).toBe('unknown'); // 추측 0
    expect(c.recordedReason).toBeUndefined();
    const d = exits.find((e) => e.runId === 'run-d')!;
    expect(d).toMatchObject({ reason: 'goal-elaboration-ungrounded-path', recordedReason: 'unknown', reasonSource: 'lastLines' });
    const e = exits.find((e) => e.runId === 'run-e')!;
    expect(e.reason).toBe('unknown'); // 충돌 꼬리 — 첫 매치로 확정하지 않는다
    expect(e.recordedReason).toBeUndefined();
    expect(e.reasonSource).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readRunExits: reclassified result equals classifyIncidentReasonFromLastLines and keeps recordedReason unknown · recordRunExit 는 사유 원문만 저장', () => {
  const dir = root();
  const at = Date.parse('2026-10-22T08:00:00Z');
  const runALines = ['  ❌ failed · 대상 경로: src/ux-sim/hq-seats-device.ts — pod-job-failed: Job si-task-x failed (BackoffLimitExceeded)'];
  recordRunExit({ ...row('run-a', 'unknown', at), lastLines: runALines }, dir);
  const mixedLines = ['  ❌ blocked · b — DEPENDENCY_NEEDS_HUMAN', '  ❌ failed · c — error code: pod-deadline-exceeded'];
  recordRunExit({ ...row('run-mixed', 'unknown', at + 1), lastLines: mixedLines }, dir);
  const exits = readRunExits(dir);
  const a = exits.find((e) => e.runId === 'run-a')!;
  // base 분류기와 같은 근본 사유('pod-backoff-limit') — 'ux-sim-device' 같은 쓰기 사유는 없다
  expect(a.reason).toBe('pod-backoff-limit');
  expect(a.reason).toBe(classifyIncidentReasonFromLastLines(runALines) ?? 'unmatched');
  expect(a.recordedReason).toBe('unknown');
  expect(a.reasonSource).toBe('lastLines');
  expect(a.slice).toBe('device');
  const mixed = exits.find((e) => e.runId === 'run-mixed')!;
  // 줄마다 다른 사유(증상 DEPENDENCY_NEEDS_HUMAN ⊕ 근본 pod-deadline-exceeded) — 충돌은 unknown 보존
  expect(mixed.reason).toBe('unknown');
  expect(classifyIncidentReasonFromLastLines(mixedLines)).toBeNull();
  expect(mixed.reason).not.toBe('needs-human');
  expect(mixed.recordedReason).toBeUndefined();
  expect(mixed.reasonSource).toBeUndefined();
});

