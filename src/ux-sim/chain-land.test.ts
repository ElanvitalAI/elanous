import { describe, expect, test } from 'bun:test';
import { simulateChainLand, type ChainGateOutcome } from './chain-land.js';


describe('SIM-CHAIN-LAND production queue chain', () => {
  test('production enqueue and runL8ShadowQueue attribute a failed integrated gate and persist every verdict', async () => {
    const result = await simulateChainLand({
      prNumbers: [101, 102, 103],
      gateOutcomes: ['fail', 'pass', 'fail', 'pass', 'fail'],
    });
    expect(result.enqueued).toEqual([101, 102, 103]);
    expect(result.pending).toEqual([]);
    expect(result.verdicts.map(({ number, verdict }) => ({ number, verdict }))).toEqual([
      { number: 101, verdict: 'pass' }, { number: 102, verdict: 'pass' }, { number: 103, verdict: 'fail' },
    ]);
    expect(result.disposition).toMatchObject({ number: 101, verdict: 'pass' });
    const firstVerdict = result.verdicts[0];
    const disposition = result.disposition;
    if (!firstVerdict || !disposition) throw new Error('production disposition was not returned');
    expect(firstVerdict).toEqual(disposition);
    expect(result.verdicts.every((entry) => entry.detail?.includes('merge train shadow'))).toBe(true);
    expect(result.gateRuns.length).toBeGreaterThan(0);
    expect(result.gateRuns.every((entry) => entry.host === 'node-b')).toBe(true);
    expect(result.ghCalls.length).toBeGreaterThan(0);
    expect(result.ghCalls.every((entry) => entry.name === 'gh' && entry.argv[0] === 'pr' && entry.argv[1] === 'view')).toBe(true);
    expect(result.integrationCalls).toBeGreaterThan(0);
  }, 30_000);

  test('unmeasured host result reaches production runL8ShadowQueue and persists as unmeasured', async () => {
    const result = await simulateChainLand({
      prNumbers: [201, 202],
      gateOutcomes: ['unmeasured', 'pass'],
    });
    expect(result.verdicts.map(({ number, verdict }) => ({ number, verdict }))).toEqual([
      { number: 201, verdict: 'unmeasured' }, { number: 202, verdict: 'unmeasured' },
    ]);
    expect(result.disposition).toMatchObject({ number: 201, verdict: 'unmeasured' });
    const firstVerdict = result.verdicts[0];
    const disposition = result.disposition;
    if (!firstVerdict || !disposition) throw new Error('production disposition was not returned');
    expect(firstVerdict).toEqual(disposition);
    expect(result.gateRuns.map(({ host }) => host)).toEqual(['node-b']);
    expect(result.pending).toEqual([]);
  }, 30_000);

  test('a real stale queue lock is rejected by runL8ShadowQueue before git integration or gate execution', async () => {
    const result = await simulateChainLand({ prNumbers: [301], gateOutcomes: [], staleLock: true });
    expect(result).toMatchObject({
      lock: 'stale', enqueued: [301], pending: [301], gateRuns: [], verdicts: [], integrationCalls: 0,
    });
    expect(result.disposition).toBeNull();
    expect(result.ghCalls.length).toBeGreaterThan(0);
  }, 30_000);
});
