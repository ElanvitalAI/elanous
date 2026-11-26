import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAllIn } from './burst-allin.js';
import { readSynthetic } from './burst-live.js';

const deps = (closed: string[], failAt = -1) => {
  let clock = Date.parse('2026-11-26T11:00:00Z');
  return { spawn: async (i: number) => { if (i === failAt) throw new Error('els down'); return `pane${i}`; }, close: async (id: string) => { closed.push(id); },
    sleep: async (ms: number) => { clock += ms; }, now: () => new Date(clock), log: () => {} };
};

describe('burst all-in (test universe)', () => {
  test('opens hands, steps review and pregate, exits early and closes every tab it opened', async () => {
    const tu = mkdtempSync(join(tmpdir(), 'bb-'));
    const closed: string[] = [];
    const { state, receipt } = await runAllIn({ seatState: tu, phrase: '자원 다 투입', hands: 3, speed: 1 }, deps(closed));
    expect(closed).toEqual(['pane0', 'pane1', 'pane2']);
    expect(state.status).toBe('exited');
    expect(receipt.trigger).toBe('CEO «자원 다 투입»');
    expect(receipt.launched).toBe(7);
    expect(receipt.closed).toBe(7);
    expect(receipt.costUsd).toBe(0);
    expect(receipt.reason).toBe('early exit: forecast caught up');
    expect(state.launches.filter((l) => l.lane === 'review').length).toBe(2);
    expect(state.launches.every((l) => l.host === 'mshq')).toBe(true);
    expect(readSynthetic(tu)?.forecastOk).toBe(true);
    expect(readFileSync(join(tu, 'OP', 'pulse', 'burst-receipts.jsonl'), 'utf8').trim().split('\n').length).toBe(1);
  });
  test('a failed spawn still closes the tabs already opened and files an aborted receipt', async () => {
    const tu = mkdtempSync(join(tmpdir(), 'bb-'));
    const closed: string[] = [];
    await expect(runAllIn({ seatState: tu, phrase: 'all resources', hands: 3, speed: 1 }, deps(closed, 2))).rejects.toThrow('els down');
    expect(closed).toEqual(['pane0', 'pane1']);
    const r = JSON.parse(readFileSync(join(tu, 'OP', 'pulse', 'burst-receipts.jsonl'), 'utf8'));
    expect(r.reason).toBe('aborted: els down');
  });
});
