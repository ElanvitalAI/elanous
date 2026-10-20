import { describe, expect, it } from 'bun:test';
import type { RunLedgerEntry } from '../self-implement/run-ledger.js';
import {
  collectClaudePtyMaturitySample,
  judgeClaudePtyMaturity,
  type ClaudePtyMaturitySample,
} from './claude-pty-maturity.js';

const NOW_MS = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

function claudePtyRuns(count: number, options: {
  missingFieldAt?: number;
  olderThanTwoDaysAt?: number;
  includeOtherProvider?: boolean;
  scrambleRunIds?: boolean;
} = {}): Map<string, RunLedgerEntry[]> {
  const runs = Array.from({ length: count }, (_, index) => {
    const runIdNumber = options.scrambleRunIds ? ((index * 7) % count) + 1 : index + 1;
    const runId = `run-${String(runIdNumber).padStart(8, '0')}`;
    const timestamp = new Date(NOW_MS - (options.olderThanTwoDaysAt === index ? 3 * DAY_MS : index * 1_000)).toISOString();
    const fields = {
      childProvider: 'claude-pty',
      claudePtyUnknownScreens: index === 0 ? 1 : 0,
      ...(options.missingFieldAt === index ? {} : { humanInterventions: 0 }),
    };
    const entries: RunLedgerEntry[] = [
      {
        runId,
        timestamp,
        event: 'run-origin',
        data: fields,
      },
      ...(index < 8 ? [{
        runId,
        timestamp,
        event: 'merged',
        data: { merged: true },
      } satisfies RunLedgerEntry] : []),
    ];
    return [`${runId}.jsonl`, entries] as const;
  });
  if (options.includeOtherProvider) {
    const runId = 'run-other-provider';
    runs.push([`${runId}.jsonl`, [{
      runId,
      timestamp: new Date(NOW_MS).toISOString(),
      event: 'run-origin',
      data: { childProvider: 'openai-codex' },
    }]]);
  }
  return new Map(runs);
}

function depsFor(runs: Map<string, RunLedgerEntry[]>) {
  return {
    nowMs: NOW_MS,
    dir: '/unused-ledger-fixture',
    list: () => [...runs.keys()],
    load: (runId: string) => runs.get(`${runId}.jsonl`) ?? null,
  };
}

describe('collectClaudePtyMaturitySample', () => {
  it('returns a sample judged too-few-samples for nine Claude PTY runs', () => {
    const sample = collectClaudePtyMaturitySample(depsFor(claudePtyRuns(9)));

    expect(sample?.runCount).toBe(9);
    expect(judgeClaudePtyMaturity(sample)).toEqual({ mature: false, why: 'too-few-samples' });
  });

  it('returns the unchanged sums for ten readable runs using the default limit', () => {
    const sample = collectClaudePtyMaturitySample(depsFor(claudePtyRuns(10)));
    const expected: ClaudePtyMaturitySample = {
      runCount: 10,
      completedCount: 8,
      unknownScreenCount: 1,
      interventionCount: 0,
    };

    expect(sample).toEqual(expected);
    expect(judgeClaudePtyMaturity(sample)).toEqual({ mature: true });
  });

  it('selects the latest ten runs across time and excludes other providers', () => {
    const sample = collectClaudePtyMaturitySample(depsFor(claudePtyRuns(10, {
      olderThanTwoDaysAt: 9,
      includeOtherProvider: true,
    })));

    expect(sample).toEqual({
      runCount: 10,
      completedCount: 8,
      unknownScreenCount: 1,
      interventionCount: 0,
    });
  });

  it('selects only the latest ten when the ledger has more than ten Claude PTY runs', () => {
    const runs = claudePtyRuns(12, { missingFieldAt: 10, scrambleRunIds: true });
    const newestFirst = [...runs.entries()].sort(([, left], [, right]) =>
      String(right[0]?.timestamp ?? '').localeCompare(String(left[0]?.timestamp ?? '')));
    const eleventhNewest = newestFirst[10]![1];
    eleventhNewest[0] = {
      ...eleventhNewest[0]!,
      data: { ...eleventhNewest[0]!.data, claudePtyUnknownScreens: 3 },
    };
    const oldest = newestFirst[11]![1];
    oldest[0] = {
      ...oldest[0]!,
      data: { ...oldest[0]!.data, claudePtyUnknownScreens: 4, humanInterventions: 2 },
    };
    const sample = collectClaudePtyMaturitySample(depsFor(new Map([...runs].reverse())));

    // Listed oldest-first with scrambled IDs: both older runs have unique counts, and the 11th is unreadable.
    expect(sample).toEqual({
      runCount: 10,
      completedCount: 8,
      unknownScreenCount: 1,
      interventionCount: 0,
    });
  });

  it('returns null and judges sample-unreadable when a selected run lacks a ledger field', () => {
    const sample = collectClaudePtyMaturitySample(depsFor(claudePtyRuns(10, { missingFieldAt: 4 })));

    expect(sample).toBeNull();
    expect(judgeClaudePtyMaturity(sample)).toEqual({ mature: false, why: 'sample-unreadable' });
  });
});
