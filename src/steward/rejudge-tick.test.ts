import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejudgeTick, REJUDGE_TICK_EVENT, type RejudgeRun } from './rejudge-tick.js';

function harness(config: { rejudgeEveryMinutes?: number; rejudgeMaxLoad?: number } | undefined, opts: { load?: number; run?: RejudgeRun; now?: string; stamp?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rejudge-tick-'));
  const stampPath = join(dir, 'steward', 'rejudge-tick.json');
  const pendingPath = join(dir, 'steward', 'resync-pending.json');
  if (opts.stamp) { mkdirSync(join(dir, 'steward'), { recursive: true }); writeFileSync(stampPath, JSON.stringify({ startedAt: opts.stamp })); }
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  let runs = 0;
  const deps = {
    now: () => new Date(opts.now ?? '2026-10-12T02:00:00Z'),
    config: () => config,
    load: () => opts.load ?? 1,
    stampPath,
    pendingPath,
    run: async () => { runs++; return opts.run ?? { code: 0, stdout: '[{"card":"a","decision":"pr-not-open"},{"card":"b","decision":"pr-not-open"},{"card":"b","decision":"regate-requested"}]\n', stderr: '', timedOut: false }; },
    log: (event: string, data: Record<string, unknown>) => { logs.push({ event, data }); },
  };
  return { dir, stampPath, pendingPath, logs, deps, runs: () => runs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('off by default: no interval configured → disabled, nothing runs, one observation line', async () => {
  const h = harness(undefined);
  try {
    const result = await rejudgeTick(h.deps);
    expect(result.decision).toBe('disabled');
    expect(h.runs()).toBe(0);
    expect(existsSync(h.stampPath)).toBe(false);
    expect(h.logs.map(row => [row.event, row.data.decision])).toEqual([[REJUDGE_TICK_EVENT, 'disabled']]);
  } finally { h.cleanup(); }
});

test('0 minutes is off too', async () => {
  const h = harness({ rejudgeEveryMinutes: 0 });
  try { expect((await rejudgeTick(h.deps)).decision).toBe('disabled'); expect(h.runs()).toBe(0); } finally { h.cleanup(); }
});

test('due with no stamp: runs `tasks rejudge --all`, stamps the start and summarizes the decisions', async () => {
  const h = harness({ rejudgeEveryMinutes: 30 });
  try {
    const result = await rejudgeTick(h.deps);
    expect(h.runs()).toBe(1);
    expect(result).toMatchObject({ decision: 'ran', everyMinutes: 30, rc: 0, cards: 2, decisions: { 'pr-not-open': 2, 'regate-requested': 1 } });
    expect(JSON.parse(readFileSync(h.stampPath, 'utf8'))).toEqual({ startedAt: '2026-10-12T02:00:00.000Z' });
    expect(h.logs.at(-1)?.data.decision).toBe('ran');
  } finally { h.cleanup(); }
});

test('not due inside the interval; due again at interval minus jitter (a 15-minute tick at 29:30 still fires)', async () => {
  const early = harness({ rejudgeEveryMinutes: 30 }, { stamp: '2026-10-12T01:45:00Z' });
  const late = harness({ rejudgeEveryMinutes: 30 }, { stamp: '2026-10-12T01:30:30Z' });
  try {
    expect((await rejudgeTick(early.deps)).decision).toBe('not-due');
    expect(early.runs()).toBe(0);
    expect((await rejudgeTick(late.deps)).decision).toBe('ran');
    expect(late.runs()).toBe(1);
  } finally { early.cleanup(); late.cleanup(); }
});

test('a newly saved resync head forces rejudge inside its interval, while disabled and load guards still apply', async () => {
  const h = harness({ rejudgeEveryMinutes: 30 }, { stamp: '2026-10-12T01:45:00Z' });
  try {
    writeFileSync(h.pendingPath, JSON.stringify({ savedAt: '2026-10-12T01:46:00Z' }));
    expect((await rejudgeTick(h.deps)).decision).toBe('ran');
    expect(h.runs()).toBe(1);
    expect((await rejudgeTick(h.deps)).decision).toBe('not-due');
    expect(h.runs()).toBe(1);
  } finally { h.cleanup(); }
  const busy = harness({ rejudgeEveryMinutes: 30 }, { stamp: '2026-10-12T01:45:00Z', load: 61 });
  try {
    writeFileSync(busy.pendingPath, JSON.stringify({ savedAt: '2026-10-12T01:46:00Z' }));
    expect((await rejudgeTick(busy.deps)).decision).toBe('load-skip');
    expect(busy.runs()).toBe(0);
  } finally { busy.cleanup(); }
  const off = harness(undefined, { stamp: '2026-10-12T01:45:00Z' });
  try {
    writeFileSync(off.pendingPath, JSON.stringify({ savedAt: '2026-10-12T01:46:00Z' }));
    expect((await rejudgeTick(off.deps)).decision).toBe('disabled');
    expect(off.runs()).toBe(0);
  } finally { off.cleanup(); }
});

test('load guard: above the max load it skips without stamping, so the next tick retries', async () => {
  const h = harness({ rejudgeEveryMinutes: 30 }, { load: 61 });
  try {
    const result = await rejudgeTick(h.deps);
    expect(result).toMatchObject({ decision: 'load-skip', load: 61, maxLoad: 60 });
    expect(h.runs()).toBe(0);
    expect(existsSync(h.stampPath)).toBe(false);
  } finally { h.cleanup(); }
  const custom = harness({ rejudgeEveryMinutes: 30, rejudgeMaxLoad: 100 }, { load: 61 });
  try { expect((await rejudgeTick(custom.deps)).decision).toBe('ran'); } finally { custom.cleanup(); }
});

test('nonzero exit / timeout / no JSON line → failed with a reason, never throws', async () => {
  for (const run of [
    { code: 1, stdout: '[{"card":"a","decision":"rejudge-threw"}]\n', stderr: 'boom', timedOut: false },
    { code: null, stdout: '', stderr: '', timedOut: true },
    { code: 0, stdout: 'not json\n', stderr: '', timedOut: false },
  ]) {
    const h = harness({ rejudgeEveryMinutes: 30 }, { run });
    try {
      const result = await rejudgeTick(h.deps);
      expect(result.decision).toBe('failed');
      expect(typeof result.reason).toBe('string');
    } finally { h.cleanup(); }
  }
});

test('a config read that throws is a failed tick, not a crash', async () => {
  const h = harness({ rejudgeEveryMinutes: 30 });
  try {
    const result = await rejudgeTick({ ...h.deps, config: () => { throw new Error('config unreadable'); } });
    expect(result).toMatchObject({ decision: 'failed', reason: 'config unreadable' });
    expect(h.runs()).toBe(0);
  } finally { h.cleanup(); }
});

test('user-config carries taskAgent.rejudgeEveryMinutes / rejudgeMaxLoad and drops non-numbers', async () => {
  const { reloadUserConfig } = await import('../user-config.js');
  const dir = mkdtempSync(join(tmpdir(), 'rejudge-config-'));
  const path = join(dir, 'config.json');
  try {
    writeFileSync(path, JSON.stringify({ taskAgent: { rejudgeEveryMinutes: 30, rejudgeMaxLoad: 80 } }));
    expect(reloadUserConfig(path).taskAgent).toEqual({ rejudgeEveryMinutes: 30, rejudgeMaxLoad: 80 });
    writeFileSync(path, JSON.stringify({ taskAgent: { liveMoves: ['review'], rejudgeEveryMinutes: '30', rejudgeMaxLoad: -1 } }));
    expect(reloadUserConfig(path).taskAgent).toEqual({ liveMoves: ['review'] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
