import { expect, test } from 'bun:test';
import { formatTrainThroughputText, summarizeTrainThroughputFiles } from './train-throughput.js';

test('reads only the named logs and summary files and preserves unknown outcomes', () => {
  const files: Record<string, string> = {
    'aws1.log': '11-02 14:40:00 [aws1] manager assigned stage=group prs=1,2 base=abc run=run-a slot=1\n11-02 14:48:00 [aws1] manager done stage=group run=run-a rc=2 · BATCH REFUSED: always-ratchet bundle missing',
    'summary.json': JSON.stringify({ events: [{ eventType: 'pr-landed', host: 'aws1', at: '2026-11-02T05:00:00Z' }] }),
  };
  const result = summarizeTrainThroughputFiles(['aws1.log'], ['summary.json'], '2026-11-02', path => files[path]!, () => new Date('2026-11-02T00:00:00Z'));
  expect(result.hosts.aws1).toMatchObject({ assigned: 1, assignedPrs: 2, completed: 1, rejected: 1, rejectedByReason: { ratchet: 1 }, landed: 1 });
});

test('connects a hyphenated host summary directory by manifest identity', () => {
  const summaryPath = '/train-artifacts/batch-aws-prod-run-a/summary.json';
  const logPath = '/train-artifacts/train-auto-loop-aws-prod.log';
  const files: Record<string, string> = {
    [summaryPath]: JSON.stringify({ verdict: 'failed', exitCode: 1, typecheck: { status: 'failed' } }),
    '/train-artifacts/batch-aws-prod-run-a/manifest.json': JSON.stringify({ host: 'aws-prod', base: 'base40', members: [{ pr: '9', head: 'head9' }] }),
    [logPath]: '11-02 14:00:00 [aws-prod] manager assigned stage=group prs=9 base=base40 run=run-a slot=1\n11-02 14:10:00 [aws-prod] manager done stage=group run=run-a rc=2 · BATCH REFUSED: gate verdict not pass',
  };
  const result = summarizeTrainThroughputFiles([logPath], [summaryPath], '2026-11-02', path => files[path]!, () => new Date('2026-11-02T00:00:00Z'), path => path === '/train-artifacts/batch-aws-prod-run-a/manifest.json');
  expect(result.hosts['aws-prod']?.rejectedByReason.typecheck).toBe(1);
  expect(result.hosts['aws-prod']?.assigned).toBe(1);
});

test('plain CLI output includes the hourly assignments and outcomes', () => {
  const files: Record<string, string> = { 'aws2.log': [
    '11-02 14:58:00 [aws2] manager assigned stage=express prs=7 base=abc run=run-c slot=1',
    '11-02 15:03:00 [aws2] manager done stage=express run=run-c rc=2 · BATCH REFUSED: authorization must exactly match selected PRs',
  ].join('\n') };
  const result = summarizeTrainThroughputFiles(['aws2.log'], [], '2026-11-02', path => files[path]!, () => new Date('2026-11-02T00:00:00Z'));
  const output = formatTrainThroughputText(result);
  expect(output).toContain('시간별(KST)');
  expect(output).toContain('2026-11-02T14:00+09:00\t1\t0\t0\t0\t미측정\t미측정');
  expect(output).toContain('authorization=1');
  expect(output).toContain('2026-11-02T15:00+09:00\t0\t1\t0\t1\t미측정\t300');
});


test('installed command rejects a normalized impossible calendar date', async () => {
  const { spawnSync } = await import('node:child_process');
  const command = spawnSync(process.execPath, ['bin/elanous.mjs', 'train', 'throughput', '--date', '2026-02-30'], { cwd: process.cwd(), encoding: 'utf8' });
  expect(command.status).toBe(2);
  expect(command.stderr).toContain('날짜는 YYYY-MM-DD 형식이어야 합니다.');
});

test('installed command prints hourly rows from an explicitly named log', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'train-throughput-cli-'));
  try {
    const log = join(dir, 'train-auto-loop.log');
    writeFileSync(log, [
      '11-02 14:58:00 [aws2] manager assigned stage=express prs=7 base=abc run=cli-run slot=1',
      '11-02 15:03:00 [aws2] manager done stage=express run=cli-run rc=2 · BATCH REFUSED: authorization mismatch',
    ].join('\n'));
    const command = spawnSync(process.execPath, ['bin/elanous.mjs', 'train', 'throughput', '--date', '2026-11-02', '--log', log], { cwd: process.cwd(), encoding: 'utf8' });
    expect(command.status).toBe(0);
    expect(command.stdout).toContain('2026-11-02T14:00+09:00\t1\t0\t0\t0');
    expect(command.stdout).toContain('2026-11-02T15:00+09:00\t0\t1\t0\t1\t미측정\t300');
    expect(command.stdout).toContain('aws2\t1\t1\t1\t0\t1\t0');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('marks malformed manifests as incomplete instead of presenting a complete summary', () => {
  const summary = '/artifacts/batch-aws-prod-run/summary.json';
  const manifest = '/artifacts/batch-aws-prod-run/manifest.json';
  const files: Record<string, string> = { [summary]: JSON.stringify({ verdict: 'failed', exitCode: 1 }) };
  const result = summarizeTrainThroughputFiles([], [summary], '2026-11-02', path => path === manifest ? '{ invalid' : files[path]!,
    () => new Date('2026-11-02T00:00:00Z'), path => path === manifest);
  expect(result.sourceIncomplete).toBe(true);
  expect(formatTrainThroughputText(result)).toContain('수치가 불완전합니다');
});
