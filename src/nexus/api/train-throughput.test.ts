import { expect, test } from 'bun:test';
import { buildTrainThroughput, isValidTrainDate, parseTrainThroughputLogs, trainIdentityFromBatchDirectory } from './train-throughput.js';

const stamp = (time: string) => `11-02 ${time}:00 [aws2]`;

test('uses strict calendar dates and manifest identity for hyphenated train hosts and run ids', () => {
  expect(isValidTrainDate('2026-11-02')).toBe(true);
  expect(isValidTrainDate('2026-02-30')).toBe(false);
  expect(isValidTrainDate('2026-2-03')).toBe(false);
  expect(trainIdentityFromBatchDirectory('batch-aws-prod-run-prod-123', { host: 'aws-prod' }))
    .toEqual({ host: 'aws-prod', runId: 'run-prod-123' });
  expect(trainIdentityFromBatchDirectory('batch-aws-run-a', { host: 'aws-prod' })).toBeUndefined();
});

test('joins assigned and done by host plus run, reports elapsed time and never counts gate success as landing', () => {
  const events = parseTrainThroughputLogs([
    `${stamp('14:40')} manager assigned stage=group prs=1,2 base=abc run=run-a slot=2`,
    `${stamp('14:45')} manager done stage=group run=run-a rc=2 · BATCH REFUSED: authorization must exactly match selected PRs`,
    `${stamp('14:50')} manager assigned stage=express prs=3 base=abc run=run-b slot=1`,
    `${stamp('14:52')} manager done stage=express run=run-b rc=0 · {"schema":"elanous.memory.v1","eventType":"batch-gate","key":{"pr":"3"}}`,
  ], { date: '2026-11-02', anchorDate: '2026-11-02', timezoneOffsetMinutes: 540 });
  const result = buildTrainThroughput(events);
  expect(result.hosts.aws2).toMatchObject({ assigned: 2, completed: 2, succeeded: 1, rejected: 1, rejectedByReason: { authorization: 1 }, landed: null });
  expect(result.hosts.aws2.averageWaitSeconds).toBe(210);
  expect(result.attempts[0]).not.toHaveProperty('detail');
});

test('connects a completion after midnight to the prior-day assignment', () => {
  const events = parseTrainThroughputLogs([
    '11-02 23:58:00 [aws2] manager assigned stage=group prs=9 base=abc run=night-run slot=1',
    '11-03 00:03:00 [aws2] manager done stage=group run=night-run rc=2 · BATCH REFUSED: lock owner changed',
  ], { date: '2026-11-02', anchorDate: '2026-11-02', timezoneOffsetMinutes: 540 });
  expect(events).toMatchObject([{ assignedAt: '2026-11-02T23:58:00+09:00', finishedAt: '2026-11-03T00:03:00+09:00' }]);
  expect(buildTrainThroughput(events, undefined, '2026-11-02').hours['2026-11-02T23:00+09:00']).toMatchObject({ assigned: 1, completed: 0, unmeasured: 0 });
  const nextDay = parseTrainThroughputLogs([
    '11-02 23:58:00 [aws2] manager assigned stage=group prs=9 base=abc run=night-run slot=1',
    '11-03 00:03:00 [aws2] manager done stage=group run=night-run rc=2 · BATCH REFUSED: lock owner changed',
  ], { date: '2026-11-03', anchorDate: '2026-11-03' });
  expect(buildTrainThroughput(nextDay, undefined, '2026-11-03').hours['2026-11-03T00:00+09:00']).toMatchObject({ assigned: 0, completed: 1, rejectedByReason: { 'lock-owner': 1 }, averageWaitSeconds: 300 });
});

test('combines independent rejection signals and deduplicates the same category', () => {
  const attempt = parseTrainThroughputLogs([
    `${stamp('14:40')} manager assigned stage=group prs=1 base=abc run=run-a slot=1`,
    `${stamp('14:48')} manager done stage=group run=run-a rc=2 · BATCH REFUSED: authorization mismatch · typecheck bundle failed`,
  ], { date: '2026-11-02', anchorDate: '2026-11-02' });
  const summary = [{ eventType: 'train-rejection', host: 'aws2', runId: 'run-a', reason: 'typecheck' }];
  const result = buildTrainThroughput(attempt, summary);
  expect(result.hosts.aws2?.rejectedByReason).toMatchObject({ typecheck: 1, authorization: 1 });
});

test('uses summary landed events and buckets attempts by assignment hour', () => {
  const events = parseTrainThroughputLogs([
    `${stamp('14:58')} manager assigned stage=express prs=7 base=abc run=run-c slot=1`,
    `${stamp('15:03')} manager done stage=express run=run-c rc=0 · pass`,
  ], { date: '2026-11-02', anchorDate: '2026-11-02', timezoneOffsetMinutes: 540 });
  const result = buildTrainThroughput(events, [{ eventType: 'pr-landed', host: 'aws2', at: '2026-11-02T06:04:00.000Z', pr: 7 }], '2026-11-02');
  expect(result.hours['2026-11-02T14:00+09:00']?.assigned).toBe(1);
  expect(result.hours['2026-11-02T15:00+09:00']?.landed).toBe(1);
  expect(result.hosts.aws2.landed).toBe(1);
});


test('buckets assignment and completion on their own dates across midnight', () => {
  const lines = [
    '11-02 23:58:00 [aws2] manager assigned stage=group prs=9 base=abc run=night-run slot=1',
    '11-03 00:03:00 [aws2] manager done stage=group run=night-run rc=2 · BATCH REFUSED: lock owner changed',
  ];
  const dayOne = parseTrainThroughputLogs(lines, { date: '2026-11-02', anchorDate: '2026-11-02' });
  const dayTwo = parseTrainThroughputLogs(lines, { date: '2026-11-03', anchorDate: '2026-11-03' });
  expect(buildTrainThroughput(dayOne, undefined, '2026-11-02').hours['2026-11-02T23:00+09:00']).toMatchObject({ assigned: 1, completed: 0, unmeasured: 0 });
  expect(buildTrainThroughput(dayTwo, undefined, '2026-11-03').hours['2026-11-03T00:00+09:00']).toMatchObject({ assigned: 0, completed: 1, rejected: 1, rejectedByReason: { 'lock-owner': 1 }, averageWaitSeconds: 300 });
});

test('connects completion across multiple calendar days', () => {
  const lines = [
    '10-31 23:58:00 [aws2] manager assigned stage=group prs=9 base=abc run=long-run slot=1',
    '11-03 00:03:00 [aws2] manager done stage=group run=long-run rc=2 · BATCH REFUSED: lock owner changed',
  ];
  const events = parseTrainThroughputLogs(lines, { date: '2026-11-03', anchorDate: '2026-11-03' });
  expect(events).toMatchObject([{ assignedAt: '2026-10-31T23:58:00+09:00', finishedAt: '2026-11-03T00:03:00+09:00' }]);
  expect(buildTrainThroughput(events, undefined, '2026-11-03').hours['2026-11-03T00:00+09:00']).toMatchObject({ completed: 1, rejected: 1, averageWaitSeconds: 173100 });
});

test('uses file modification date plus log chronology to distinguish repeated month-day rows across years', () => {
  const lines = [
    '11-02 09:00:00 [aws2] manager assigned stage=group prs=1 base=abc run=old-year slot=1',
    '11-02 09:05:00 [aws2] manager done stage=group run=old-year rc=0 · completed',
    '12-31 23:55:00 [aws2] manager assigned stage=group prs=2 base=abc run=year-end slot=1',
    '01-01 00:05:00 [aws2] manager done stage=group run=year-end rc=0 · completed',
    '11-02 14:40:00 [aws2] manager assigned stage=group prs=3 base=abc run=current-year slot=1',
    '11-02 14:48:00 [aws2] manager done stage=group run=current-year rc=0 · completed',
  ];
  const events = parseTrainThroughputLogs(lines, { date: '2025-11-02', anchorDate: '2026-11-03' });
  expect(events.map(event => event.runId)).toEqual(['old-year']);
  expect(events[0]).toMatchObject({ assignedAt: '2025-11-02T09:00:00+09:00', finishedAt: '2025-11-02T09:05:00+09:00' });
});

test('counts non-refusal process exits as execution failures, not train rejections', () => {
  const attempts = parseTrainThroughputLogs([
    '11-02 14:40:00 [aws2] manager assigned stage=group prs=9 base=abc run=crashed slot=1',
    '11-02 14:41:00 [aws2] manager done stage=group run=crashed rc=137 · process terminated',
  ], { date: '2026-11-02', anchorDate: '2026-11-02' });
  expect(buildTrainThroughput(attempts).hosts.aws2).toMatchObject({ completed: 1, rejected: 0, failed: 1, rejectedByReason: { other: 0 } });
});
