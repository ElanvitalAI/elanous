import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { readFailureInbox, recordFailureEvent } from './heal-intake.js';

const dirs: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'heal-intake-'));
  dirs.push(path);
  return path;
}
afterEach(() => {
  resetElanousConfigDir();
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

const base = { source: 'release-run' as const, kind: 'graph-run', ref: 'release/run-1', summary: 'failed node', at: '2026-10-04T13:00:00.000Z' };

test('record writes one JSON line under the selected state root and logs the folded verdict', () => {
  const dir = root();
  expect(recordFailureEvent(base, dir)).toEqual({ folded: false });
  expect(readFileSync(join(dir, 'heal', 'inbox.jsonl'), 'utf8')).toBe(`${JSON.stringify(base)}\n`);
  expect(readFailureInbox({}, dir)).toEqual([base]);
  expect(debug.events(100).filter(entry => entry.category === 'heal.intake' && entry.event === 'recorded').at(-1))
    .toMatchObject({ data: { source: base.source, kind: base.kind, ref: base.ref, folded: false } });
});

test('default inbox follows the selected instance state root', () => {
  const dir = root();
  setElanousConfigDir(dir);
  expect(recordFailureEvent(base)).toEqual({ folded: false });
  expect(readFailureInbox()).toEqual([base]);
  expect(readFileSync(join(dir, 'heal', 'inbox.jsonl'), 'utf8')).toBe(`${JSON.stringify(base)}\n`);
});

test('same source+ref folds inside one hour; other source and exactly one hour apart remain separate', () => {
  const dir = root();
  recordFailureEvent(base, dir);
  expect(recordFailureEvent({ ...base, kind: 'different', summary: 'repeated', at: '2026-10-04T13:59:59.999Z' }, dir)).toEqual({ folded: true });
  expect(recordFailureEvent({ ...base, source: 'cron' }, dir)).toEqual({ folded: false });
  expect(recordFailureEvent({ ...base, at: '2026-10-04T14:00:00.000Z' }, dir)).toEqual({ folded: false });
  expect(readFailureInbox({}, dir)).toHaveLength(3);
  expect(debug.events(100).filter(entry => entry.category === 'heal.intake' && entry.event === 'recorded').some(entry =>
    (entry.data as { folded?: boolean }).folded === true)).toBe(true);
});

test('since reads inclusive timestamps without changing the stored lines', () => {
  const dir = root();
  expect(readFailureInbox({}, dir)).toEqual([]);
  recordFailureEvent(base, dir);
  recordFailureEvent({ ...base, ref: 'release/run-2', at: '2026-10-04T14:00:00.000Z' }, dir);
  const before = readFileSync(join(dir, 'heal', 'inbox.jsonl'), 'utf8');
  expect(readFailureInbox({ since: '2026-10-04T14:00:00.000Z' }, dir).map(row => row.ref)).toEqual(['release/run-2']);
  expect(readFailureInbox({ since: '2026-10-05T00:00:00.000Z' }, dir)).toEqual([]);
  expect(readFileSync(join(dir, 'heal', 'inbox.jsonl'), 'utf8')).toBe(before);
});

test('parallel processes acquire the file lock before deciding to append or fold', async () => {
  const dir = root();
  const modulePath = join(import.meta.dir, 'heal-intake.ts');
  const jobs = Array.from({ length: 12 }, (_, i) => {
    const child = Bun.spawn([process.execPath, '-e', `import { recordFailureEvent } from ${JSON.stringify(modulePath)}; recordFailureEvent(JSON.parse(process.argv[1]), process.argv[2]);`,
      JSON.stringify({ ...base, ref: i < 6 ? base.ref : `release/run-${i}` }), dir], { stdout: 'pipe', stderr: 'pipe' });
    return child;
  });
  const results = await Promise.all(jobs.map(async child => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })));
  expect(results).toEqual(Array.from({ length: 12 }, () => ({ code: 0, stderr: '' })));
  const lines = readFileSync(join(dir, 'heal', 'inbox.jsonl'), 'utf8').trimEnd().split('\n');
  expect(lines).toHaveLength(7);
  expect(lines.map(line => JSON.parse(line) as typeof base).filter(row => row.ref === base.ref)).toHaveLength(1);
  expect(readFailureInbox({}, dir)).toHaveLength(7);
});
