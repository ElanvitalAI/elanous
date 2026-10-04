import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerFreezeCommands } from '../cli/freeze-cli.js';
import { awaitLandingMergesDrained, beginLandingMerge, disableLandingFreeze, enableLandingFreeze, inFlightLandingMerges, landingFreezePath, readLandingFreeze } from './landing-freeze.js';

const at = new Date('2026-10-04T06:00:00Z');

test('landing-freeze.json records reason, start, end and actor; expires automatically and off removes it', () => {
  const root = mkdtempSync(join(tmpdir(), 'landing-freeze-'));
  try {
    const state = enableLandingFreeze({ reason: 'drill', until: '2026-10-04T07:00:00+00:00', by: 'MK' }, root, at);
    expect(JSON.parse(readFileSync(landingFreezePath(root), 'utf8'))).toEqual(state);
    expect(state).toEqual({ reason: 'drill', startedAt: at.toISOString(), until: '2026-10-04T07:00:00.000Z', by: 'MK' });
    expect(readLandingFreeze(root, new Date('2026-10-04T06:59:59Z'))).toEqual(state);
    expect(readLandingFreeze(root, new Date('2026-10-04T07:00:00Z'))).toBeNull();
    expect(existsSync(landingFreezePath(root))).toBe(true); // expired reads as off; only `freeze off` removes the file
    enableLandingFreeze({ by: 'OP' }, root, at);
    disableLandingFreeze(root);
    expect(readLandingFreeze(root)).toBeNull();
    expect(() => enableLandingFreeze({ until: '2026-10-04T05:00:00Z' }, root, at)).toThrow('--until must be a future ISO timestamp with timezone');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('freeze status --json reads the isolated state folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'landing-freeze-cli-'));
  const before = process.env.ELANOUS_STATE_DIR;
  const lines: string[] = [];
  const originalLog = console.log;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    console.log = (...args) => { lines.push(args.join(' ')); };
    const cli = new Command();
    registerFreezeCommands(cli);
    await cli.parseAsync(['freeze', 'on', '--reason', 'drill', '--until', '2099-01-01T00:00:00Z'], { from: 'user' });
    await cli.parseAsync(['freeze', 'status', '--json'], { from: 'user' });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ frozen: true, freeze: { reason: 'drill', until: '2099-01-01T00:00:00.000Z' } });
    await cli.parseAsync(['freeze', 'off'], { from: 'user' });
    await cli.parseAsync(['freeze', 'status', '--json'], { from: 'user' });
    expect(JSON.parse(lines.at(-1)!)).toEqual({ frozen: false, freeze: null, pendingMerges: 0 });
    expect(lines.some((line) => line.includes('보류 병합 이어 하기'))).toBe(true);
  } finally {
    console.log = originalLog;
    if (before === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = before;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a merge that passed its freeze check makes `freeze on` wait; a merge starting after `freeze on` sees the freeze', async () => {
  const root = mkdtempSync(join(tmpdir(), 'landing-freeze-race-'));
  try {
    const inFlight = beginLandingMerge(root, at);
    expect(inFlight.frozen).toBeNull();
    expect(inFlightLandingMerges(root)).toBe(1);
    enableLandingFreeze({ reason: 'drill', by: 'OP' }, root, at);
    const late = beginLandingMerge(root, at);
    expect(late.frozen).toMatchObject({ reason: 'drill' });
    expect(inFlightLandingMerges(root)).toBe(1);
    let polls = 0;
    const waited = await awaitLandingMergesDrained(root, { timeoutMs: 60_000, pollMs: 1, sleep: async () => { polls++; if (polls === 3) inFlight.end(); } });
    expect(waited).toEqual({ drained: true, pending: 0 });
    expect(polls).toBe(3);
    const stuck = beginLandingMerge(join(root, 'other'), at);
    expect(await awaitLandingMergesDrained(join(root, 'other'), { timeoutMs: 0, sleep: async () => {} })).toEqual({ drained: false, pending: 1 });
    stuck.end();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('freeze on rejects a non-finite or out-of-range --wait-seconds before writing the freeze', async () => {
  const root = mkdtempSync(join(tmpdir(), 'landing-freeze-wait-'));
  const before = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    for (const bad of ['Infinity', '-1', '1.5', '86401', 'abc']) {
      const cli = new Command();
      registerFreezeCommands(cli);
      await expect(cli.parseAsync(['freeze', 'on', '--wait-seconds', bad], { from: 'user' })).rejects.toThrow('--wait-seconds');
      expect(existsSync(landingFreezePath(root))).toBe(false);
    }
  } finally {
    if (before === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = before;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a freeze removed while it is being read reads as off, not as an error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'landing-freeze-race-read-'));
  try {
    // Another process switches the freeze on and off as fast as it can while this one keeps reading it.
    const flapper = Bun.spawn([process.execPath, '-e', `
      const m = await import(${JSON.stringify(join(import.meta.dir, 'landing-freeze.ts'))});
      const end = Date.now() + 1500;
      while (Date.now() < end) { m.enableLandingFreeze({ reason: 'flap', by: 'OP' }, ${JSON.stringify(root)}); m.disableLandingFreeze(${JSON.stringify(root)}); }
    `]);
    let reads = 0, frozenSeen = 0;
    const end = Date.now() + 1200;
    while (Date.now() < end) {
      const state = readLandingFreeze(root);
      reads++;
      if (state) frozenSeen++;
      await Promise.resolve();
    }
    expect(await flapper.exited).toBe(0);
    expect(reads).toBeGreaterThan(100);
    expect(frozenSeen).toBeLessThanOrEqual(reads);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
