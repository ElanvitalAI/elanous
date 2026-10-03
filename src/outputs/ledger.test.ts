import { afterEach, expect, setSystemTime, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { debug } from '../debug/log.js';
import { ExecRequestRunner } from '../exec-requests/runner.js';
import { ExecRequestStore } from '../exec-requests/store.js';
import { readFieldReelStatus, scheduleFieldReel } from '../field/field-reel.js';
import { listOutputs, recordOutput } from './ledger.js';
import { writeDraft, draftPath, type FeedDraft } from '../../scripts/field-feed/lib.js';

const roots: string[] = [];
afterEach(() => {
  setSystemTime();
  resetElanousConfigDir();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'output-ledger-'));
  roots.push(root);
  setElanousConfigDir(root);
  return root;
}
function monthFile(root: string, date = new Date()): string {
  const month = new Date(date.getTime() + 9 * 3600e3).toISOString().slice(0, 7);
  return join(root, 'outputs', `outputs-${month}.jsonl`);
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await Bun.sleep(10); }
  throw new Error('output did not complete');
}
function reelFile(dir: string): string {
  const file = join(dir, 'reel', 'reel-9x16.mp4');
  mkdirSync(join(dir, 'reel'), { recursive: true });
  const rendered = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1',
    '-frames:v', '1', '-c:v', 'mpeg4', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], { maxBuffer: 1024 * 1024 });
  if (rendered.status !== 0) throw new Error(`video fixture failed: ${rendered.stderr.toString()}`);
  writeFileSync(file, rendered.stdout);
  return file;
}

test('append-only ledger deduplicates by source/id/location, filters and lists newest first', () => {
  const root = fixture();
  setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
  const older = { source: 'exec' as const, sourceId: 'one', kind: 'report' as const, title: '첫째', url: '/a', at: '2026-10-01T00:00:00.000Z' };
  recordOutput(older);
  recordOutput({ ...older, title: '재시도', kind: 'file' });
  recordOutput({ ...older, url: '/b', title: '둘째', at: '2026-10-02T00:00:00.000Z' });
  recordOutput({ source: 'field-reel', sourceId: 'one', kind: 'video', title: '행사', path: '/a', at: '2026-10-03T00:00:00.000Z' });
  expect(listOutputs().map(entry => entry.title)).toEqual(['행사', '둘째', '첫째']);
  expect(listOutputs({ source: 'exec', since: '2026-10-02T00:00:00.000Z', limit: 1 }).map(entry => entry.url)).toEqual(['/b']);
  expect(readFileSync(monthFile(root), 'utf8').trim().split('\n')).toHaveLength(3);
});

test('the KST month boundary rotates a September UTC write into October', () => {
  const root = fixture();
  setSystemTime(new Date('2026-09-30T14:59:00.000Z'));
  recordOutput({ source: 'exec', sourceId: 'before', kind: 'report', title: 'before', url: '/before' }, root);
  setSystemTime(new Date('2026-09-30T15:00:00.000Z'));
  recordOutput({ source: 'exec', sourceId: 'after', kind: 'report', title: 'after', url: '/after' }, root);
  expect(readFileSync(join(root, 'outputs', 'outputs-2026-09.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(readFileSync(join(root, 'outputs', 'outputs-2026-10.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(listOutputs({}, root).map(entry => entry.sourceId)).toEqual(['after', 'before']);
});

test('KST month rotation reads old ledgers and only the current month for deduplication', () => {
  const root = fixture();
  setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
  const dir = join(root, 'outputs');
  mkdirSync(dir);
  const entry = (sourceId: string, at: string) => ({ source: 'exec', sourceId, kind: 'report', title: sourceId, url: `/${sourceId}`, at });
  const legacy = join(dir, 'outputs.jsonl');
  const september = join(dir, 'outputs-2026-09.jsonl');
  writeFileSync(legacy, [entry('august', '2026-08-20T00:00:00.000Z'), entry('legacy', '2026-09-01T00:00:00.000Z')].map(value => JSON.stringify(value)).join('\n') + '\n');
  writeFileSync(september, JSON.stringify(entry('september', '2026-09-30T14:00:00.000Z')) + '\n');
  const oct = monthFile(root);
  expect(oct).toBe(join(dir, 'outputs-2026-10.jsonl'));
  const reads = spyOn(fs, 'readFileSync');
  try {
    recordOutput({ source: 'exec', sourceId: 'first', kind: 'report', title: 'first', url: '/first' }, root);
    recordOutput({ source: 'exec', sourceId: 'second', kind: 'report', title: 'second', url: '/second' }, root);
    recordOutput({ source: 'exec', sourceId: 'first', kind: 'report', title: 'duplicate', url: '/first' }, root);
    expect(reads.mock.calls.map(call => call[0])).toEqual([oct, oct, oct]);
    setSystemTime(new Date('2026-10-02T12:00:00.000Z'));
    const folder = join(root, 'field', 'festival');
    const draft = { kind: 'feed-draft', version: 1, revision: 1, updatedBy: 'graph', event: { title: 'festival', date: '' } } as FeedDraft;
    writeDraft(folder, draft);
    writeDraft(folder, draft);
    writeDraft(folder, { ...draft, revision: 2, updatedBy: 'human', event: { ...draft.event, title: 'edited' } });
    expect(readFileSync(oct, 'utf8').trim().split('\n')).toHaveLength(3);
    expect(listOutputs({ source: 'field-feed' }, root)).toMatchObject([{ sourceId: 'festival', title: 'festival', path: draftPath(folder) }]);
    expect(readFileSync(legacy, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readdirSync(dir).filter(name => /^outputs-.*\.jsonl$/.test(name)).sort()).toEqual(['outputs-2026-09.jsonl', 'outputs-2026-10.jsonl']);
    expect(listOutputs({ limit: 10 }, root).map(e => e.sourceId)).toEqual(['festival', 'first', 'second', 'september', 'legacy', 'august']);
    expect(listOutputs({ since: '2026-10-01' }, root).map(e => e.sourceId)).toEqual(['festival', 'first', 'second']);
    const log = spyOn(debug, 'log');
    try {
      reads.mockClear();
      expect(listOutputs({ limit: 2 }, root).map(e => e.sourceId)).toEqual(['festival', 'first']);
      expect(reads.mock.calls.map(call => call[0])).toEqual([oct, september, legacy]);
      expect(log.mock.calls.some(call => call[0] === 'outputs.ledger' && call[1] === 'rotated-read'
        && (call[2] as { months: number; rows: number }).months === 2
        && (call[2] as { months: number; rows: number }).rows === 6)).toBe(true);
      reads.mockClear();
      listOutputs({ since: '2026-10-01' }, root);
      expect(reads.mock.calls.map(call => call[0])).toEqual([oct, september, legacy]);
    } finally { log.mockRestore(); }
  } finally { reads.mockRestore(); }
});

test('a large month returns every row without exhausting the function argument limit', () => {
  const root = fixture();
  const dir = join(root, 'outputs');
  mkdirSync(dir);
  const count = 500_000;
  const rows = Array.from({ length: count }, (_, i) => JSON.stringify({
    source: 'exec', sourceId: `row-${i}`, kind: 'report', title: `row-${i}`, url: `/row-${i}`,
    at: '2026-10-01T00:00:00.000Z',
  }));
  writeFileSync(join(dir, 'outputs-2026-10.jsonl'), rows.join('\n') + '\n');
  const entries = listOutputs({}, root);
  expect(entries).toHaveLength(count);
  expect(entries[0]?.sourceId).toBe('row-0');
  expect(entries.at(-1)?.sourceId).toBe(`row-${count - 1}`);
});

test('an earlier recorded month can contain the newest at, even with a limit or since filter', () => {
  const root = fixture();
  setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
  const dir = join(root, 'outputs');
  mkdirSync(dir);
  const entry = (sourceId: string, at: string) => ({ source: 'exec' as const, sourceId, kind: 'report' as const, title: sourceId, url: `/${sourceId}`, at });
  writeFileSync(join(dir, 'outputs-2026-09.jsonl'), JSON.stringify(entry('late-september', '2026-10-04T00:00:00.000Z')) + '\n');
  writeFileSync(join(dir, 'outputs-2026-08.jsonl'), JSON.stringify(entry('late-august', '2026-10-05T00:00:00.000Z')) + '\n');
  recordOutput(entry('october', '2026-10-03T00:00:00.000Z'), root);
  expect(listOutputs({ limit: 1 }, root).map(e => e.sourceId)).toEqual(['late-august']);
  expect(listOutputs({ since: '2026-10-04' }, root).map(e => e.sourceId)).toEqual(['late-august', 'late-september']);
});

test('two processes racing to write the same output append only one line', async () => {
  const root = fixture();
  const script = `import { recordOutput } from ${JSON.stringify(join(import.meta.dir, 'ledger.ts'))};
    recordOutput({ source: 'exec', sourceId: 'same', kind: 'report', title: 'race', url: '/same' }, process.argv[1]);`;
  const children = Array.from({ length: 12 }, () => spawn('bun', ['-e', script, root], { stdio: 'ignore' }));
  const codes = await Promise.all(children.map(child => new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  })));
  expect(codes).toEqual(Array(12).fill(0));
  expect(listOutputs({}, root)).toHaveLength(1);
  expect(readFileSync(monthFile(root), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(readdirSync(join(root, 'outputs')).sort()).toEqual([monthFile(root).split('/').at(-1)!, `${monthFile(root).split('/').at(-1)}.lock`]);
});

test('two processes discovering a stale owner keep one lock inode and append once', async () => {
  const root = fixture();
  const dir = join(root, 'outputs');
  mkdirSync(dir);
  writeFileSync(`${monthFile(root)}.lock`, '99999999');
  const script = `import { recordOutput } from ${JSON.stringify(join(import.meta.dir, 'ledger.ts'))};
    recordOutput({ source: 'exec', sourceId: 'stale', kind: 'report', title: 'race', url: '/same' }, process.argv[1]);`;
  const children = [spawn('bun', ['-e', script, root], { stdio: 'ignore' }), spawn('bun', ['-e', script, root], { stdio: 'ignore' })];
  const codes = await Promise.all(children.map(child => new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('exit', resolve);
  })));
  expect(codes).toEqual([0, 0]);
  expect(listOutputs({}, root)).toHaveLength(1);
  expect(readFileSync(monthFile(root), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(readFileSync(`${monthFile(root)}.lock`, 'utf8')).toBe('99999999');
});

test('a second process waits for the live writer before checking and appending', async () => {
  const root = fixture();
  const dir = join(root, 'outputs');
  mkdirSync(dir);
  const lock = `${monthFile(root)}.lock`;
  writeFileSync(lock, '99999999'); // A former owner's inode must remain the synchronization point.
  const holder = spawn('bun', ['-e', `import { openSync, closeSync } from 'node:fs';
    import { dlopen, FFIType } from 'bun:ffi';
    const flock = dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6',
      { flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int } }).symbols.flock;
    const fd = openSync(process.argv[1], 'r+'); flock(fd, 2);
    process.stdout.write('locked\\n'); await new Promise(resolve => process.stdin.once('data', resolve));
    flock(fd, 8); closeSync(fd);`, lock], { stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject);
    holder.stdout!.once('data', () => resolve());
  });
  const script = `import { recordOutput } from ${JSON.stringify(join(import.meta.dir, 'ledger.ts'))};
    recordOutput({ source: 'exec', sourceId: 'same', kind: 'report', title: 'race', url: '/same' }, process.argv[1]);`;
  const child = spawn('bun', ['-e', script, root], { stdio: 'ignore' });
  try {
    await Bun.sleep(150);
    expect(readdirSync(dir)).toEqual([`${monthFile(root).split('/').at(-1)}.lock`]);
    writeFileSync(monthFile(root), JSON.stringify({ source: 'exec', sourceId: 'same', kind: 'report', title: 'original', url: '/same', at: '2026-10-01T00:00:00.000Z' }) + '\n');
    holder.stdin!.write('release\n');
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(code).toBe(0);
    expect(listOutputs({}, root).map(entry => entry.title)).toEqual(['original']);
  } finally { holder.kill(); child.kill(); }
});

test('corrupt JSONL line does not hide valid entries or prevent later writes', () => {
  const root = fixture();
  const log = spyOn(debug, 'log');
  try {
    const file = monthFile(root);
    mkdirSync(join(root, 'outputs'));
    writeFileSync(file, [
      JSON.stringify({ source: 'exec', sourceId: 'old', title: 'old', kind: 'report', url: '/old', at: '2026-10-01T00:00:00.000Z' }),
      '{broken',
      JSON.stringify({ source: 'field-reel', sourceId: 'reel', title: 'reel', kind: 'video', path: '/reel', at: '2026-10-02T00:00:00.000Z' }),
      '',
    ].join('\n'));
    expect(listOutputs({}, root).map(entry => entry.sourceId)).toEqual(['reel', 'old']);
    recordOutput({ source: 'exec', sourceId: 'new', kind: 'file', title: 'new', url: '/new' }, root);
    recordOutput({ source: 'exec', sourceId: 'old', kind: 'file', title: 'duplicate', url: '/old' }, root);
    expect(listOutputs({}, root).map(entry => entry.sourceId)).toEqual(['new', 'reel', 'old']);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(4);
    expect(log.mock.calls.some(call => call[0] === 'outputs.ledger' && call[1] === 'invalid-line' && (call[2] as { line: number }).line === 2)).toBe(true);
  } finally { log.mockRestore(); }
});

test('parseable but incomplete entries are isolated while valid neighbors and new writes survive', () => {
  const root = fixture();
  const dir = join(root, 'outputs');
  mkdirSync(dir);
  const file = monthFile(root);
  const valid = { source: 'exec', sourceId: 'same', kind: 'report', title: 'valid', url: '/same', at: '2026-10-01T00:00:00.000Z' };
  const broken = [
    { ...valid, source: 'other' }, { ...valid, sourceId: undefined },
    { ...valid, kind: undefined }, { ...valid, kind: 'unknown' },
    { ...valid, title: undefined }, { ...valid, url: undefined },
    { ...valid, url: 42 }, { ...valid, at: undefined },
  ];
  writeFileSync(file, [JSON.stringify(valid), ...broken.map(entry => JSON.stringify(entry)), JSON.stringify({ ...valid, sourceId: 'last', url: '/last', at: '2026-10-02T00:00:00.000Z' })].join('\n'));
  expect(listOutputs({}, root).map(entry => entry.sourceId)).toEqual(['last', 'same']);
  recordOutput({ source: 'exec', sourceId: 'fresh', kind: 'file', title: 'fresh', url: '/fresh' }, root);
  expect(listOutputs({}, root).map(entry => entry.sourceId)).toEqual(['fresh', 'last', 'same']);
});

test('delegated graph results (including replay) and successful reel share one ledger; failed reel contributes none', async () => {
  const root = fixture();
  const store = new ExecRequestStore(root);
  const runner = new ExecRequestRunner({ root, store,
    graphs: async () => [{ id: 'draft', title: 'Draft', description: '', path: '/fake.yaml' }],
    plan: async () => [{ seat: 'CMO', title: '행사 자료', graphId: 'draft', inputs: {}, output: 'slides' }],
    run: (async (_path, opts) => {
      const runId = opts?.runId ?? '';
      const dir = join(root, 'graph-runs', 'draft', runId);
      mkdirSync(dir, { recursive: true });
      const files = ['one.md', 'two.md'].map(name => { const file = join(dir, name); writeFileSync(file, name); return file; });
      const state = { graphId: 'draft', runId, status: 'done' as const, path: [], executed: 1, dryRun: false,
        statePath: join(root, 'graph-runs', 'draft', `${runId}.json`),
        nodes: [{ nodeId: 'produce', ok: true, exit: 0, executed: true,
          output: JSON.stringify({ artifacts: files.map((file, i) => ({ file, title: `산출 ${i + 1}` })) }) }] };
      writeFileSync(state.statePath, JSON.stringify(state));
      return state;
    }) satisfies typeof import('../graph-runner/runner.js').runGraph,
  });
  const request = runner.submit('행사 자료 만들어줘');
  await until(() => store.get(request.id)?.status === 'done');
  expect(store.get(request.id)?.results).toHaveLength(2);
  const replay = store.get(request.id)!;
  replay.status = 'running'; replay.seats[0]!.status = 'running'; replay.results = [];
  store.save(replay);
  expect(runner.get(request.id)?.results).toHaveLength(2);
  const event = join(root, 'field', 'event-one');
  mkdirSync(event, { recursive: true });
  writeFileSync(join(event, 'title.txt'), '가을 행사\n현장');
  scheduleFieldReel(event, { quietMs: 1, runner: async dir => ({ ok: true, file: reelFile(dir), seconds: 1 }), startFeed: () => ({ started: false }) });
  await until(() => readFieldReelStatus(event)?.state === 'done');
  const failed = join(root, 'field', 'event-two');
  mkdirSync(failed, { recursive: true });
  scheduleFieldReel(failed, { quietMs: 1, runner: async () => ({ ok: false, seconds: 0, error: 'renderer failed' }), startFeed: () => ({ started: false }) });
  await until(() => readFieldReelStatus(failed)?.state === 'failed');
  const entries = listOutputs();
  expect(entries).toHaveLength(3);
  expect(entries.filter(entry => entry.source === 'exec').sort((a, b) => a.title.localeCompare(b.title))).toMatchObject([
    { sourceId: request.id, kind: 'slides', seat: 'CMO', title: '산출 1' },
    { sourceId: request.id, kind: 'slides', seat: 'CMO', title: '산출 2' },
  ]);
  expect(entries.filter(entry => entry.source === 'field-reel')).toMatchObject([
    { sourceId: 'event-one', kind: 'video', title: '가을 행사', path: join(event, 'reel', 'reel-9x16.mp4') },
  ]);
});

test('recordOutput never throws on a failed monthly write and logs write-failed', () => {
  const root = fixture();
  mkdirSync(monthFile(root), { recursive: true });
  const log = spyOn(debug, 'log');
  try {
    expect(() => recordOutput({ source: 'exec', sourceId: 'failed', kind: 'report', title: 'failed', url: '/failed' }, root)).not.toThrow();
    expect(log.mock.calls.some(call => call[0] === 'outputs.ledger' && call[1] === 'write-failed'
      && (call[2] as { source: string }).source === 'exec')).toBe(true);
  } finally { log.mockRestore(); }
});

test('unwritable ledger logs write-failed without failing delegated work or rendering', async () => {
  const root = fixture();
  mkdirSync(monthFile(root), { recursive: true });
  const log = spyOn(debug, 'log');
  try {
    const store = new ExecRequestStore(root);
    const runner = new ExecRequestRunner({ root, store, graphs: async () => [],
      plan: async () => [{ seat: 'CMO', title: '상황', graphId: '', inputs: {}, output: 'answer' }],
      answer: async () => ({ title: '상황 보고', text: '완료' }),
    });
    const request = runner.submit('상황 알려줘');
    await until(() => store.get(request.id)?.status === 'done');
    expect(store.get(request.id)?.results).toHaveLength(1);
    const event = join(root, 'field', 'success');
    mkdirSync(event, { recursive: true });
    scheduleFieldReel(event, { quietMs: 1, runner: async dir => ({ ok: true, file: reelFile(dir), seconds: 1 }), startFeed: () => ({ started: false }) });
    await until(() => readFieldReelStatus(event)?.state === 'done');
    expect(log.mock.calls.filter(call => call[0] === 'outputs.ledger' && call[1] === 'write-failed').map(call => (call[2] as { source: string }).source)).toEqual(['exec', 'field-reel']);
  } finally { log.mockRestore(); }
});
