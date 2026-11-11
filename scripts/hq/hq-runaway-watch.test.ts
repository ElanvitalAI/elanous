import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HQ_RUNAWAY_LOAD_THRESHOLD, parseHqLoad, runHqRunawayWatch } from './hq-runaway-watch.js';

test('HQ load watch records high and recovery once while keeping command arguments out of its ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-runaway-'));
  const spacedExecutable = join(root, 'My App.app', 'Contents', 'MacOS', 'My Worker');
  mkdirSync(join(root, 'My App.app', 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(spacedExecutable, '');
  const sample = parseHqLoad(`load averages: ${HQ_RUNAWAY_LOAD_THRESHOLD}.5 20.0 10.0`,
    '200 96.0 /usr/bin/bun\n201 95.0 /usr/bin/bun --secret=/tmp/never-record\n' +
    '202 30.0 /Applications/My App.app/Contents/MacOS/Worker\n203 10.0 /usr/bin/bun secret-token\n' +
    `204 9.0 /usr/bin/bun /tmp/secret-token\n205 8.0 ${spacedExecutable}\n` +
    '206 7.0 /Applications/My App.app/Contents/MacOS/Worker secret-token');
  const now = () => new Date('2026-11-11T00:00:00.000Z');
  try {
    expect(sample.processes[0]).toMatchObject({ pid: 200, cpuPercent: 96, executable: 'bun' });
    expect(sample.processes[1]).toMatchObject({ pid: 202, executable: 'Worker' });
    expect(sample.processes[2]).toMatchObject({ pid: 205, executable: 'My Worker' });
    expect(sample.processes.map(item => item.pid)).toEqual([200, 202, 205]);
    const high = runHqRunawayWatch(root, { now, measure: () => sample });
    expect(high).toMatchObject({ status: 'high', event: { event: 'hq-load-high', threshold: HQ_RUNAWAY_LOAD_THRESHOLD } });
    expect(runHqRunawayWatch(root, { now, measure: () => sample }).event).toBeNull();
    const recovered = runHqRunawayWatch(root, { now, measure: () => ({ ...sample, load1: HQ_RUNAWAY_LOAD_THRESHOLD - 1 }) });
    expect(recovered.event?.event).toBe('hq-load-recovered');
    const ledger = readFileSync(join(root, 'hq-runaway-watch.events.jsonl'), 'utf8');
    expect(ledger.trim().split('\n')).toHaveLength(2);
    expect(ledger).not.toContain('never-record');
    expect(ledger).not.toContain('--secret');
    expect(ledger).not.toContain('secret-token');
    chmodSync(join(root, 'hq-runaway-watch.events.jsonl'), 0o644);
    runHqRunawayWatch(root, { now, measure: () => sample });
    expect(statSync(join(root, 'hq-runaway-watch.events.jsonl')).mode & 0o777).toBe(0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HQ load watch retains a valid last event without its newline', () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-runaway-tail-newline-'));
  const now = () => new Date('2026-11-11T00:00:00.000Z');
  const measure = () => ({ load1: HQ_RUNAWAY_LOAD_THRESHOLD + 1, processes: [] });
  try {
    runHqRunawayWatch(root, { now, measure });
    const ledger = join(root, 'hq-runaway-watch.events.jsonl');
    truncateSync(ledger, statSync(ledger).size - 1);
    expect(runHqRunawayWatch(root, { now, measure }).event).toBeNull();
    const text = readFileSync(ledger, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n')).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HQ load watch fails closed on unmeasured load and preserves prior state', () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-runaway-'));
  try {
    expect(() => parseHqLoad('uptime unavailable', '')).toThrow('measurement unavailable');
    expect(() => runHqRunawayWatch(root, { measure: () => ({ load1: Number.NaN, processes: [] }) }))
      .toThrow('invalid HQ load sample');
    expect(() => readFileSync(join(root, 'hq-runaway-watch.state.json'), 'utf8')).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HQ load watch recovers a committed event when state replacement was interrupted', () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-runaway-interrupted-'));
  const now = () => new Date('2026-11-11T00:00:00.000Z');
  const measure = () => ({ load1: HQ_RUNAWAY_LOAD_THRESHOLD + 1, processes: [] });
  try {
    expect(() => runHqRunawayWatch(root, { now, measure,
      afterEventAppended: () => { throw new Error('interrupted before state write'); } })).toThrow('interrupted');
    appendFileSync(join(root, 'hq-runaway-watch.events.jsonl'), '{"event":"hq-load-rec');
    expect(runHqRunawayWatch(root, { now, measure }).event).toBeNull();
    expect(readFileSync(join(root, 'hq-runaway-watch.events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, 'hq-runaway-watch.state.json'), 'utf8')).high).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('load measurement is serialized before a later normal sample', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-runaway-ordered-'));
  const modulePath = join(import.meta.dir, 'hq-runaway-watch.ts');
  const marker = join(root, 'high-measure-started');
  const child = (load: number, pauseMs: number) => new Promise<number | null>((resolve, reject) => {
    const code = `import { writeFileSync } from 'node:fs';
import { runHqRunawayWatch } from ${JSON.stringify(modulePath)};
runHqRunawayWatch(${JSON.stringify(root)}, { now: () => new Date('2026-11-11T00:00:00.000Z'),
  measure: () => { if (${pauseMs} > 0) writeFileSync(${JSON.stringify(marker)}, 'started');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${pauseMs});
    return { load1: ${load}, processes: [] }; } });`;
    const worker = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
    worker.once('error', reject);
    worker.once('exit', resolve);
  });
  try {
    const high = child(HQ_RUNAWAY_LOAD_THRESHOLD + 1, 150);
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(marker)).toBe(true);
    const normal = child(HQ_RUNAWAY_LOAD_THRESHOLD - 1, 0);
    expect(await Promise.all([high, normal])).toEqual([0, 0]);
    const events = readFileSync(join(root, 'hq-runaway-watch.events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => event.event)).toEqual(['hq-load-high', 'hq-load-recovered']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('concurrent HQ load watches serialize and record one transition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-runaway-concurrent-'));
  const modulePath = join(import.meta.dir, 'hq-runaway-watch.ts');
  const code = `import { runHqRunawayWatch } from ${JSON.stringify(modulePath)};
runHqRunawayWatch(${JSON.stringify(root)}, { now: () => new Date('2026-11-11T00:00:00.000Z'),
  measure: () => ({ load1: 41, processes: [] }) });`;
  const child = () => new Promise<number | null>((resolve, reject) => {
    const childProcess = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
    childProcess.once('error', reject);
    childProcess.once('exit', resolve);
  });
  try {
    expect(await Promise.all([child(), child(), child()])).toEqual([0, 0, 0]);
    expect(readFileSync(join(root, 'hq-runaway-watch.events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
