import { test, expect } from 'bun:test';
import { debug } from '../debug/log.js';
import { orchestrateSelfDev } from './orchestrate.js';

test('checkpoint progress records mixed terminal counts and an intermediate remaining count', async () => {
  const rows: Record<string, unknown>[] = [];
  let resolveIntermediate!: () => void;
  const intermediateCheckpoint = new Promise<void>((resolve) => { resolveIntermediate = resolve; });
  const off = debug.registerSink({ name: 'orchestrate-progress-proof', emit: (record) => {
    if (record.category === 'self-dev.orchestrate' && record.event === 'progress') {
      const data = record.data as Record<string, unknown>;
      rows.push(data);
      if (data.remaining === 1) resolveIntermediate();
    }
  } });
  try {
    let finishSecond!: (value: { exitCode: number; output: string; disposition: { stage: string; ok: false; failureClassification: 'report-deficit' } }) => void;
    let markSecondStarted!: () => void;
    let launches = 0;
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const run = orchestrateSelfDev({ concurrency: 1,
      goals: [{ id: 'one', feature: 'one', openPr: true }, { id: 'two', feature: 'two' }],
      spawn: (input) => ++launches === 1
        ? ({ address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '', disposition: {
          stage: 'merged', ok: true, prUrl: 'https://x/pr/1', prNumber: 1, merged: true,
        } }) })
        : ({ address: input.spaceId, done: new Promise((resolve) => { finishSecond = resolve; markSecondStarted(); }) }),
    });
    await secondStarted;
    await intermediateCheckpoint;
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ total: 2, done: 1, landed: 1, remaining: 1 })]));
    finishSecond({ exitCode: 1, output: '', disposition: { stage: 'aborted', ok: false, failureClassification: 'report-deficit' } });
    await run;
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ total: 2, done: 1, failed: 1, landed: 1, remaining: 0 })]));
  } finally { off(); }
}, 20_000);
