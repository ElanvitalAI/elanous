import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueL8ShadowQueue, statusL8ShadowQueue, type L8ShadowEnqueueObservation, type L8ShadowQueueDeps, type L8ShadowQueueState } from './l8-merge-queue.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(views: Record<number, { files?: { path: string }[] }>) {
  const cwd = mkdtempSync(join(tmpdir(), 'l8-queue-overlap-'));
  roots.push(cwd);
  const observed: L8ShadowEnqueueObservation[] = [];
  const calls: string[][] = [];
  let locked = false;
  const deps: L8ShadowQueueDeps = {
    acquire: async () => {
      expect(locked).toBe(false);
      locked = true;
      return () => { locked = false; };
    },
    observeEnqueue: (entry) => {
      expect(locked).toBe(true);
      observed.push(entry);
    },
    command: (bin, args) => {
      expect(locked).toBe(true);
      calls.push([bin, ...args]);
      if (bin === 'git') return { status: 0, stdout: cwd, stderr: '' };
      if (bin === 'gh') {
        const number = Number(args[2]);
        const view = views[number];
        if (!view) throw new Error(`unexpected PR #${number}`);
        return { status: 0, stdout: JSON.stringify({
          headRefOid: number.toString(16).padStart(40, '0'), baseRefName: 'main',
          state: 'OPEN', isDraft: false, isCrossRepository: false, ...view,
        }), stderr: '' };
      }
      throw new Error(`unexpected command: ${bin} ${args.join(' ')}`);
    },
  };
  const ledger = (): L8ShadowQueueState => JSON.parse(readFileSync(join(cwd, 'elanous-l8-shadow-queue.json'), 'utf8'));
  return { cwd, observed, calls, deps, ledger, get locked() { return locked; } };
}

test('overlapping paths are recorded before enqueue, sorted and deduplicated, with two observations', async () => {
  const f = fixture({
    11: { files: [{ path: 'src/b.ts' }, { path: 'src/a.ts' }, { path: 'src/b.ts' }] },
    12: { files: [{ path: 'src/c.ts' }, { path: 'src/b.ts' }] },
  });
  await enqueueL8ShadowQueue(f.cwd, 11, f.deps);
  await enqueueL8ShadowQueue(f.cwd, 12, f.deps);
  expect(f.ledger().pending).toMatchObject([
    { number: 11, files: ['src/a.ts', 'src/b.ts'], overlapsWith: [], overlapsUnknownWith: [] },
    { number: 12, files: ['src/b.ts', 'src/c.ts'], overlapsWith: [11], overlapsUnknownWith: [] },
  ]);
  expect(f.observed).toHaveLength(2);
  expect(f.observed[0]).toMatchObject({ number: 11, fileCount: 2, filesUnmeasured: false, pendingAfter: 1 });
  expect(f.observed[1]).toMatchObject({ number: 12, overlapsWith: [11], pendingAfter: 2, fileCount: 2, filesUnmeasured: false });
  expect(f.calls.filter(([bin]) => bin === 'gh')).toEqual([
    ['gh', 'pr', 'view', '11', '--json', 'headRefOid,baseRefName,state,isDraft,isCrossRepository,files'],
    ['gh', 'pr', 'view', '12', '--json', 'headRefOid,baseRefName,state,isDraft,isCrossRepository,files'],
  ]);
  expect(f.locked).toBe(false);
});

test('nonoverlapping files produce an empty overlap list', async () => {
  const f = fixture({ 11: { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] }, 12: { files: [{ path: 'src/c.ts' }] } });
  await enqueueL8ShadowQueue(f.cwd, 11, f.deps);
  await enqueueL8ShadowQueue(f.cwd, 12, f.deps);
  expect(f.ledger().pending[1]).toMatchObject({ number: 12, files: ['src/c.ts'], overlapsWith: [], overlapsUnknownWith: [] });
  expect(f.observed[1]).toMatchObject({ overlapsWith: [], overlapsUnknownWith: [], pendingAfter: 2 });
});

test('missing files are unmeasured and distinguish unknown overlap from no overlap', async () => {
  const f = fixture({ 21: {}, 22: { files: [{ path: 'src/x.ts' }] } });
  await enqueueL8ShadowQueue(f.cwd, 21, f.deps);
  await enqueueL8ShadowQueue(f.cwd, 22, f.deps);
  const [first, second] = f.ledger().pending;
  expect(first).toMatchObject({ number: 21, filesUnmeasured: true, overlapsWith: [], overlapsUnknownWith: [] });
  expect(first).not.toHaveProperty('files');
  expect(second).toMatchObject({ number: 22, files: ['src/x.ts'], overlapsWith: [], overlapsUnknownWith: [21] });
  expect(f.observed).toHaveLength(2);
  expect(f.observed[0]).toMatchObject({ number: 21, fileCount: null, filesUnmeasured: true });
  expect(f.observed[1]).toMatchObject({ number: 22, overlapsWith: [], overlapsUnknownWith: [21] });
});

test('100 gh files cannot be treated as a complete changed-file list', async () => {
  const f = fixture({ 31: { files: Array.from({ length: 100 }, (_, index) => ({ path: `src/${index}.ts` })) }, 32: { files: [{ path: 'src/x.ts' }] } });
  await enqueueL8ShadowQueue(f.cwd, 31, f.deps);
  await enqueueL8ShadowQueue(f.cwd, 32, f.deps);
  expect(f.ledger().pending[0]).toMatchObject({ number: 31, filesUnmeasured: true });
  expect(f.ledger().pending[0]).not.toHaveProperty('files');
  expect(f.ledger().pending[1]).toMatchObject({ overlapsWith: [], overlapsUnknownWith: [31] });
  expect(f.observed[0]).toMatchObject({ fileCount: null, filesUnmeasured: true });
});

test('a legacy item without files remains readable and unknown; status preserves the previous public shape', async () => {
  const f = fixture({ 42: { files: [{ path: 'src/x.ts' }] } });
  const legacy = { number: 41, head: 'a'.repeat(40) };
  writeFileSync(join(f.cwd, 'elanous-l8-shadow-queue.json'), JSON.stringify({ pending: [legacy], verdicts: [] }));
  expect(await statusL8ShadowQueue(f.cwd, f.deps)).toEqual({ pending: [legacy], verdicts: [] });
  expect(await enqueueL8ShadowQueue(f.cwd, 42, f.deps)).toEqual({ pending: [legacy, { number: 42, head: (42).toString(16).padStart(40, '0') }], verdicts: [] });
  expect(f.ledger().pending).toMatchObject([legacy, { number: 42, overlapsWith: [], overlapsUnknownWith: [41] }]);
  expect(f.observed).toMatchObject([{ number: 42, overlapsWith: [], overlapsUnknownWith: [41] }]);
});

test('an unmeasured new PR leaves all older overlaps unknown rather than guessing', async () => {
  const f = fixture({ 51: { files: [{ path: 'src/a.ts' }] }, 52: {} });
  await enqueueL8ShadowQueue(f.cwd, 51, f.deps);
  await enqueueL8ShadowQueue(f.cwd, 52, f.deps);
  expect(f.ledger().pending[1]).toMatchObject({ filesUnmeasured: true, overlapsWith: [], overlapsUnknownWith: [51] });
});

test('unavailable observation store rolls back only the new item and retry preserves pending order', async () => {
  const f = fixture({ 61: { files: [{ path: 'src/a.ts' }] }, 62: { files: [{ path: 'src/a.ts' }] } });
  await enqueueL8ShadowQueue(f.cwd, 61, f.deps);
  await expect(enqueueL8ShadowQueue(f.cwd, 62, { ...f.deps, observeEnqueue: () => {
    throw new Error('merge-queue observation store unavailable');
  } })).rejects.toThrow('merge-queue observation store unavailable');
  expect(f.ledger().pending.map(({ number }) => number)).toEqual([61]);
  expect(f.observed).toHaveLength(1);
  await enqueueL8ShadowQueue(f.cwd, 62, f.deps);
  expect(f.ledger().pending.map(({ number }) => number)).toEqual([61, 62]);
  expect(f.ledger().pending[1]).toMatchObject({ overlapsWith: [61] });
  expect(f.observed).toHaveLength(2);
  expect(f.observed[1]).toMatchObject({ number: 62, overlapsWith: [61], pendingAfter: 2 });
  expect(f.locked).toBe(false);
});

test('observation write rejection rolls back its item, allowing retry without duplication', async () => {
  const f = fixture({ 71: { files: [{ path: 'src/x.ts' }] } });
  await expect(enqueueL8ShadowQueue(f.cwd, 71, { ...f.deps, observeEnqueue: async () => {
    throw new Error('observation write failed');
  } })).rejects.toThrow('observation write failed');
  expect(f.ledger().pending).toEqual([]);
  await enqueueL8ShadowQueue(f.cwd, 71, f.deps);
  expect(f.ledger().pending).toHaveLength(1);
  expect(f.observed).toHaveLength(1);
  expect(f.observed[0]).toMatchObject({ number: 71, pendingAfter: 1 });
});
