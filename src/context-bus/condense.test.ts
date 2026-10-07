import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dlopen, FFIType } from 'bun:ffi';
import { listMemories, saveMemory, buildMemoryInjection } from '../memory.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DecisionEntry } from '../decisions/decision-ledger.js';
import type { CoordEvent } from './coord-events.js';
import { applyCondensedCards, runContextCondense } from './condense.js';
import type { MemoryItem } from './long-term-memory.js';
import { condenseContextDay, condenseContextWindowWithReport, type MemorySource } from './long-term-memory.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });
const now = new Date('2026-10-04T00:30:00.000Z');
const event = (id: number, at: string, seat: string, summary: string, url?: string): CoordEvent => ({
  id: `fake-${id}`, at, kind: '보고', text: summary, summary,
  refs: { seat, recipients: [], all: false, kind: '보고', slot: null, deadline: null, url: url ?? `https://example.test/${id}` },
});

function fakeDeps() {
  const events = [
    event(1, '2026-10-03T01:00:00.000Z', 'TC', 'alpha/release/off'),
    event(2, '2026-10-03T01:30:00.000Z', 'TC', 'alpha/release/on'),
    event(3, '2026-10-03T03:00:00.000Z', 'UX', 'alpha/release/off'),
    event(4, '2026-10-02T23:59:59.000Z', 'MK', 'alpha/ignored/on'),
    event(5, '2026-10-04T00:30:00.000Z', 'MK', 'alpha/future/on'),
  ];
  const decisions = [{ id: 'D-20261003-01', title: 'alpha release', status: 'decided',
    decidedAt: '2026-10-03T02:00:00.000Z', raisedBy: { agent: 'TC', track: 'TC' },
    choice: 'a', options: [{ key: 'a', label: 'on', consequence: 'go' }], scqa: { s: 's', c: 'c' },
  } as DecisionEntry];
  return { events: () => events.slice().reverse(), decisions: () => decisions,
    summarize: async (source: MemorySource) => {
      const [project, topic, value] = source.kind === 'decision' ? ['alpha', 'release', 'on'] : source.text.split('/');
      return { project: project!, topic: topic!, summary: `${topic} is ${value}`,
        claim: { key: topic!, value: value! } };
    } };
}

test('24h dry-run folds a newer topic version, joins ledger decisions and flags one conflicting candidate without writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-condense-')); dirs.push(root);
  const report = await runContextCondense({ hours: 24, now, root }, fakeDeps());
  expect(report.since).toBe('2026-10-03T00:30:00.000Z');
  expect(report.cards).toHaveLength(2);
  expect(report.conflicts).toBe(1);
  expect(report.folded).toBe(0);
  expect(report.skipped).toEqual({});
  expect(report.droppedHarnessChild).toBe(0);
  expect(report.markdown).toContain('Funnel: read 4 (OP 0 · TC 3 · MK 0 · UX 1) → sources 4 (OP 0 · TC 3 · MK 0 · UX 1) → summarized 4 (OP 0 · TC 3 · MK 0 · UX 1) → cards 2 (OP 0 · TC 1 · MK 0 · UX 1)');
  expect(JSON.parse(JSON.stringify(report)).funnel).toEqual(report.funnel);
  expect(report.markdown).toContain('Skipped: {} · Dropped harness-child: 0');
  const withoutDecision = await runContextCondense({ hours: 24, now, root }, { ...fakeDeps(), decisions: () => [] });
  expect(withoutDecision.cards.find(card => card.seat === 'TC')).toMatchObject({
    source: 'https://example.test/2', summary: 'release is on', updatedAt: '2026-10-03T01:30:00.000Z',
  });
  expect(report.cards.find(card => card.seat === 'TC')).toMatchObject({
    project: 'alpha', topic: 'release', summary: 'release is on',
    source: 'elanous://decisions/D-20261003-01', updatedAt: '2026-10-03T02:00:00.000Z',
  });
  expect(report.cards.find(card => card.seat === 'TC')?.conflict).toBeUndefined();
  expect(report.cards.find(card => card.seat === 'UX')).toMatchObject({
    topic: 'release', source: 'https://example.test/3',
    conflict: { owner: 'OP', sources: ['elanous://decisions/D-20261003-01', 'https://example.test/3'] },
  });
  expect(report.markdown).toContain('충돌 (OP): elanous://decisions/D-20261003-01 ↔ https://example.test/3');
  expect(readdirSync(root)).toEqual([]);
});

test('dry-run Markdown and JSON expose no-claim skips without dropping a claimless decision', async () => {
  const decision = { id: 'D-channel', title: '착지 경로', status: 'decided',
    decidedAt: '2026-10-03T03:00:00.000Z', raisedBy: { agent: 'OP', track: 'OP' },
    choice: 'a', options: [{ key: 'a', label: '유지', consequence: '유지' }],
    scqa: { s: '착지', c: '경로 선택' } } as DecisionEntry;
  const report = await runContextCondense({ hours: 24, now, apply: false }, {
    events: () => [event(8, '2026-10-03T02:00:00.000Z', 'MK', 'MK가 OP · TC · 보고 · K10을 언급함')],
    decisions: () => [decision],
    summarize: async source => ({ project: 'alpha', topic: source.text, summary: source.text }),
  });
  expect(report.cards).toHaveLength(1);
  expect(report.cards[0]?.source).toBe('elanous://decisions/D-channel');
  expect(report.skipped).toEqual({ 'no-claim': 1 });
  expect(JSON.parse(JSON.stringify(report)).skipped).toEqual({ 'no-claim': 1 });
  expect(report.markdown).toContain('Skipped: {"no-claim":1} · Dropped harness-child: 0');
});

test('dry-run Markdown reports dropped harness-child count separately from folded and skipped', async () => {
  const child = { ...event(6, '2026-10-03T04:00:00.000Z', 'harness-child', 'Harness child loop exhausted without completion (0m 0s).'),
    kind: 'finished' };
  const report = await runContextCondense({ hours: 24, now }, {
    events: () => [child], decisions: () => [], summarize: async () => {
      throw new Error('dropped source must not be summarized');
    },
  });
  expect(report).toMatchObject({ cards: [], skipped: {}, folded: 0, droppedHarnessChild: 1 });
  expect(report.markdown).toContain('Skipped: {} · Dropped harness-child: 1');
});

test('UTC daily condensation still uses midnight boundaries after rolling-window extraction', async () => {
  const deps = fakeDeps();
  const cards = await condenseContextDay('2026-10-03', [], deps, now);
  expect(cards).toHaveLength(2);
  expect(cards.find(card => card.seat === 'MK')).toBeUndefined();
  expect(cards.find(card => card.seat === 'UX')?.conflict?.owner).toBe('OP');
});

test('--apply writes two project/seat memories, retires an older version, and raises one OP conflict card', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-condense-')); dirs.push(root);
  const memoryDir = join(root, 'elanous', 'memory');
  const old = saveMemory({ type: 'project', name: 'alpha · TC · release', description: 'release is off',
    body: 'release is off', pinned: true,
    contextCard: { project: 'alpha', seat: 'TC', topic: 'release', source: 'https://example.test/old',
      updatedAt: '2026-10-02T01:00:00.000Z', status: 'active' } }, memoryDir);
  const deps = { ...fakeDeps(), events: () => [event(2, '2026-10-03T01:30:00.000Z', 'TC', 'alpha/release/on'),
    event(6, '2026-10-03T04:00:00.000Z', 'MK', 'beta/launch/on'),
    event(3, '2026-10-03T03:00:00.000Z', 'UX', 'alpha/release/off')] };
  const report = await runContextCondense({ hours: 24, now, root, apply: true }, deps);
  expect(report.applied).toMatchObject({ written: 2, retired: 1 });
  expect(report.applied?.decisions).toHaveLength(1);
  const all = listMemories({}, memoryDir);
  expect(all).toHaveLength(3);
  expect(all.find(e => e.id === old.id)?.contextCard?.status).toBe('retired');
  expect(readFileSync(join(memoryDir, old.filename), 'utf8')).toContain('release is off');
  expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')).not.toContain(old.filename);
  expect(all.filter(e => e.contextCard?.status === 'active').map(e => [e.contextCard?.project, e.contextCard?.seat]).sort())
    .toEqual([['alpha', 'TC'], ['beta', 'MK']]);
  expect(all.find(e => e.contextCard?.source === 'elanous://decisions/D-20261003-01')?.contextCard?.updatedAt)
    .toBe('2026-10-03T02:00:00.000Z');
  expect(buildMemoryInjection('alpha release change', {}, memoryDir).injectedIds).not.toContain(old.id);
  const ledger = new DecisionLedger({ stateDir: root });
  expect(ledger.list()).toMatchObject([{ id: report.applied?.decisions[0], raisedBy: { track: 'OP' }, status: 'open' }]);
  expect(ledger.list()[0]?.refs).toContain('https://example.test/3');
  expect(ledger.list()[0]?.scqa.s).toContain('2026-10-03T03:00:00.000Z');
  expect(existsSync(join(root, 'context-memory'))).toBe(false);
  const again = await runContextCondense({ hours: 24, now, root, apply: true }, deps);
  expect(again.applied).toMatchObject({ written: 0, retired: 0, decisions: report.applied?.decisions });
  expect(ledger.list()).toHaveLength(1);
});

test('apply retires only active context cards older than 30 days, even without new candidates', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-condense-')); dirs.push(root);
  const dir = join(root, 'elanous', 'memory');
  const aged = saveMemory({ type: 'project', name: 'A', description: 'old summary', body: 'old summary',
    priority: 7, pinned: true, contextCard: { project: 'alpha', seat: 'MK', topic: 'old',
      source: 'https://example.test/aged', updatedAt: '2026-09-05T00:00:00.000Z', status: 'active' } }, dir);
  const recent = saveMemory({ type: 'project', name: 'B', description: 'recent summary', body: 'recent summary',
    contextCard: { project: 'beta', seat: 'TC', topic: 'recent',
      source: 'https://example.test/recent', updatedAt: '2026-09-07T00:00:00.000Z', status: 'active' } }, dir);
  const ordinary = saveMemory({ type: 'project', name: 'C', description: 'ordinary', body: 'ordinary' }, dir);
  const offsetRecent = saveMemory({ type: 'project', name: 'offset recent', description: 'offset recent', body: 'offset recent',
    pinned: true, contextCard: { project: 'gamma', seat: 'UX', topic: 'offset',
      source: 'https://example.test/offset', updatedAt: '2026-09-05T23:00:00-07:00', status: 'active' } }, dir);
  const agedBodyBefore = listMemories({}, dir).find(entry => entry.id === aged.id)?.body;
  const ordinaryBefore = readFileSync(join(dir, ordinary.filename));
  const recentBefore = readFileSync(join(dir, recent.filename));
  const offsetRecentBefore = readFileSync(join(dir, offsetRecent.filename));
  const store = { list: () => listMemories({}, dir), save: (input: Parameters<typeof saveMemory>[0]) => saveMemory(input, dir),
    raise: () => { throw new Error('unexpected conflict'); }, withLock: <T>(action: () => T) => action() };
  const at = new Date('2026-10-06T00:00:00.000Z');
  expect(applyCondensedCards([], store, at)).toEqual({ written: 0, retired: 1, decisions: [] });
  const entries = store.list();
  expect(entries.find(entry => entry.id === aged.id)).toMatchObject({ name: 'A', description: 'old summary',
    body: agedBodyBefore, priority: 7, pinned: false, contextCard: { status: 'retired',
      updatedAt: '2026-09-05T00:00:00.000Z', source: 'https://example.test/aged' } });
  expect(entries.find(entry => entry.id === recent.id)?.contextCard?.status).toBe('active');
  expect(readFileSync(join(dir, recent.filename))).toEqual(recentBefore);
  expect(readFileSync(join(dir, offsetRecent.filename))).toEqual(offsetRecentBefore);
  expect(entries.find(entry => entry.id === offsetRecent.id)).toMatchObject({ pinned: true, contextCard: { status: 'active' } });
  expect(readFileSync(join(dir, ordinary.filename))).toEqual(ordinaryBefore);
  expect(applyCondensedCards([], store, at)).toEqual({ written: 0, retired: 0, decisions: [] });
});

test('--apply forwards the window clock to age retirement when there are no candidate cards', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-condense-')); dirs.push(root);
  const dir = join(root, 'elanous', 'memory');
  const aged = saveMemory({ type: 'project', name: 'A', description: 'old', body: 'old',
    contextCard: { project: 'alpha', seat: 'MK', topic: 'old', source: 'https://example.test/aged',
      updatedAt: '2026-09-05T00:00:00.000Z', status: 'active' } }, dir);
  const at = new Date('2026-10-06T00:00:00.000Z');
  const deps = { events: () => [], decisions: () => [], summarize: async () => {
    throw new Error('no source to summarize');
  } };
  const dry = await runContextCondense({ hours: 24, now: at, root }, deps);
  expect(dry.applied).toBeUndefined();
  expect(listMemories({}, dir).find(entry => entry.id === aged.id)?.contextCard?.status).toBe('active');
  const applied = await runContextCondense({ hours: 24, now: at, root, apply: true }, deps);
  expect(applied.applied).toEqual({ written: 0, retired: 1, decisions: [] });
  expect(listMemories({}, dir).find(entry => entry.id === aged.id)?.contextCard?.status).toBe('retired');
});

test('a failed retirement is repaired on retry even when the candidate was already saved', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-condense-')); dirs.push(root);
  const dir = join(root, 'elanous', 'memory');
  const old = saveMemory({ type: 'project', name: 'alpha · TC · release', description: 'old', body: 'old',
    contextCard: { project: 'alpha', seat: 'TC', topic: 'release', source: 'https://example.test/old',
      updatedAt: '2026-10-02T01:00:00.000Z', status: 'active' } }, dir);
  const card: MemoryItem = { project: 'alpha', seat: 'TC', topic: 'release', summary: 'new',
    source: 'https://example.test/new', updatedAt: '2026-10-03T01:00:00.000Z', status: 'active' };
  let failRetirement = true;
  const store = {
    list: () => listMemories({}, dir),
    save: (input: Parameters<typeof saveMemory>[0]) => {
      if (input.id === old.id && failRetirement) { failRetirement = false; throw new Error('retirement write failed'); }
      return saveMemory(input, dir);
    },
    raise: () => { throw new Error('unexpected conflict'); },
    withLock: <T>(action: () => T) => action(),
  };
  expect(() => applyCondensedCards([card], store)).toThrow('retirement write failed');
  expect(listMemories({}, dir).filter(e => e.contextCard?.status === 'active')).toHaveLength(2);
  expect(applyCondensedCards([card], store)).toMatchObject({ written: 0, retired: 1, decisions: [] });
  const entries = listMemories({}, dir);
  expect(entries).toHaveLength(2);
  expect(entries.find(e => e.id === old.id)?.contextCard?.status).toBe('retired');
  expect(entries.filter(e => e.contextCard?.status === 'active').map(e => e.contextCard?.source))
    .toEqual(['https://example.test/new']);
});

test('concurrent apply calls to the same memory directory leave exactly one active winner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-condense-')); dirs.push(root);
  const dir = join(root, 'elanous', 'memory');
  const old = saveMemory({ type: 'project', name: 'alpha · TC · release', description: 'old', body: 'old',
    contextCard: { project: 'alpha', seat: 'TC', topic: 'release', source: 'https://example.test/old',
      updatedAt: '2026-10-02T01:00:00.000Z', status: 'active' } }, dir);
  const store = {
    list: () => listMemories({}, dir),
    save: (input: Parameters<typeof saveMemory>[0]) => saveMemory(input, dir),
    raise: () => { throw new Error('unexpected conflict'); },
    withLock: <T>(action: () => T) => action(),
  };
  const card = (source: string, updatedAt: string): MemoryItem => ({ project: 'alpha', seat: 'TC', topic: 'release',
    summary: source, source, updatedAt, status: 'active' });
  const first = card('https://example.test/first', '2026-10-03T01:00:00.000Z');
  const second = card('https://example.test/second', '2026-10-03T02:00:00.000Z');
  const results = await Promise.all([
    Promise.resolve().then(() => applyCondensedCards([first], store)),
    Promise.resolve().then(() => applyCondensedCards([second], store)),
  ]);
  expect(results.reduce((sum, result) => sum + result.written, 0)).toBe(2);
  const entries = listMemories({}, dir);
  expect(entries).toHaveLength(3);
  expect(entries.find(e => e.id === old.id)?.contextCard?.status).toBe('retired');
  expect(entries.filter(e => e.contextCard?.status === 'active').map(e => e.contextCard?.source))
    .toEqual(['https://example.test/second']);
});

test('two independent --apply processes serialize writes to the same topic', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-condense-')); dirs.push(root);
  const dir = join(root, 'elanous', 'memory');
  const old = saveMemory({ type: 'project', name: 'alpha · TC · release', description: 'old', body: 'old',
    contextCard: { project: 'alpha', seat: 'TC', topic: 'release', source: 'https://example.test/old',
      updatedAt: '2026-10-02T01:00:00.000Z', status: 'active' } }, dir);
  const lockPath = join(dir, '.context-condense.lock');
  const fd = openSync(lockPath, 'a+', 0o600);
  const lib = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  const flock = lib.symbols.flock as (fd: number, op: number) => number;
  const runner = resolve(import.meta.dir, 'condense.ts');
  const cliScript = `import { runContextCondense } from ${JSON.stringify(runner)};
    const root = process.argv[1], at = process.argv[2];
    const events = () => [{ id: at, at, kind: '보고', text: 'alpha/release/on', summary: 'alpha/release/on',
      refs: { seat: 'TC', recipients: [], all: false, kind: '보고', slot: null, deadline: null, url: 'https://example.test/' + at } }];
    const summarize = async () => ({ project: 'alpha', topic: 'release', summary: 'new',
      claim: { key: 'release', value: 'on' } });
    const result = await runContextCondense({ hours: 24, now: new Date('2026-10-04T00:30:00.000Z'), root, apply: true },
      { summarize, events, decisions: () => [] });
    console.log(JSON.stringify(result.applied));`;
  const start = (at: string) => Bun.spawn([process.execPath, '-e', cliScript, root, at],
    { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
  try {
    expect(flock(fd, 2 | 4)).toBe(0);
    const a = start('2026-10-03T01:00:00.000Z');
    const b = start('2026-10-03T02:00:00.000Z');
    await Bun.sleep(250);
    expect(listMemories({}, dir)).toHaveLength(1);
    expect(flock(fd, 8)).toBe(0);
    const [codeA, codeB] = await Promise.all([a.exited, b.exited]);
    expect([codeA, codeB]).toEqual([0, 0]);
    const entries = listMemories({}, dir);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.length).toBeLessThanOrEqual(3);
    expect(entries.find(e => e.id === old.id)?.contextCard?.status).toBe('retired');
    expect(entries.filter(e => e.contextCard?.status === 'active').map(e => e.contextCard?.source))
      .toEqual(['https://example.test/2026-10-03T02:00:00.000Z']);
  } finally {
    flock(fd, 8);
    closeSync(fd);
    lib.close();
  }
});

test('older candidate cannot replace newer persisted topic and different seats stay separate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-condense-')); dirs.push(root);
  const dir = join(root, 'elanous', 'memory');
  const newest = saveMemory({ type: 'project', name: 'alpha · TC · release', description: 'newer', body: 'newer',
    contextCard: { project: 'alpha', seat: 'TC', topic: 'release', source: 'https://example.test/newer',
      updatedAt: '2026-10-03T23:00:00.000Z', status: 'active' } }, dir);
  const report = await runContextCondense({ hours: 24, now, root, apply: true }, {
    ...fakeDeps(), decisions: () => [], events: () => [event(2, '2026-10-03T01:30:00.000Z', 'TC', 'alpha/release/on'),
      event(7, '2026-10-03T04:00:00.000Z', 'MK', 'alpha/release/on')],
  });
  expect(report.applied).toMatchObject({ written: 1, retired: 0, decisions: [] });
  expect(listMemories({}, dir).find(e => e.id === newest.id)?.contextCard?.status).toBe('active');
  expect(listMemories({}, dir).filter(e => e.contextCard?.status === 'active').map(e => e.contextCard?.seat).sort())
    .toEqual(['MK', 'TC']);
});

test('dry-run leaves an already populated memory and decision ledger byte-for-byte unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-condense-')); dirs.push(root);
  const dir = join(root, 'elanous', 'memory');
  saveMemory({ type: 'project', name: 'alpha · TC · release', description: 'old', body: 'old',
    contextCard: { project: 'alpha', seat: 'TC', topic: 'release', source: 'https://example.test/old',
      updatedAt: '2026-10-02T01:00:00.000Z', status: 'active' } }, dir);
  const ledger = new DecisionLedger({ stateDir: root, now: () => now,
    resolveVersion: () => ({ dev: '0.1.0', released: '0.1.0', codename: null }) });
  ledger.raise({ title: 'existing decision', category: 'scope', scqa: { s: 'existing state', c: 'needs choice' },
    options: [{ key: 'a', label: 'Keep', consequence: 'preserve' }, { key: 'b', label: 'Change', consequence: 'update' }],
    recommendation: { skipped: true, reason: 'await OP' }, raisedBy: { agent: 'OP', track: 'OP' } });
  const decisionBefore = readFileSync(ledger.path);
  const files = readdirSync(dir);
  const before = files.map(name => readFileSync(join(dir, name)));
  const report = await runContextCondense({ hours: 24, now, root, apply: false }, fakeDeps());
  expect(report.applied).toBeUndefined();
  expect(readdirSync(dir)).toEqual(files);
  expect(files.map(name => readFileSync(join(dir, name)))).toEqual(before);
  expect(readFileSync(ledger.path)).toEqual(decisionBefore);
});

test('reads a populated context-bus journal without mutating its bytes', async () => {
  const state = mkdtempSync(join(tmpdir(), 'context-condense-journal-')); dirs.push(state);
  const journal = join(state, 'surface_events.db');
  const db = new Database(journal, { create: true });
  db.run(`CREATE TABLE events (id TEXT, ts TEXT, text TEXT, summary TEXT, kind TEXT, refs TEXT, surface TEXT, direction TEXT)`);
  db.run(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['journal-1', '2026-10-03T01:30:00.000Z',
    'alpha/release/on', 'alpha/release/on', '보고', JSON.stringify({ seat: 'TC', url: 'https://example.test/journal' }),
    'coord:channel', 'outbound']);
  db.close();
  const before = readFileSync(journal);
  const prior = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = state;
    const { summarize } = fakeDeps();
    const report = await runContextCondense({ hours: 24, now, root: state }, { summarize, decisions: () => [] });
    expect(report.cards).toMatchObject([{ source: 'https://example.test/journal', seat: 'TC',
      summary: 'release is on', updatedAt: '2026-10-03T01:30:00.000Z' }]);
    expect(report.funnel.read).toEqual({ total: 1, bySeat: { TC: 1 }, bySurface: { 'coord:channel': 1 } });
    const direct = await condenseContextWindowWithReport(report.since, report.until, [],
      { summarize, decisions: () => [] }, now);
    expect(direct.funnel.read).toEqual(report.funnel.read);
    expect(readFileSync(journal)).toEqual(before);
    expect(readdirSync(state)).toEqual(['surface_events.db']);
  } finally {
    if (prior === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = prior;
  }
});

test('real isolated CLI drops harness-child lifecycle counts without writing', () => {
  const root = resolve(import.meta.dir, '../..');
  const state = mkdtempSync(join(root, 'context-condense-cli-')); dirs.push(state);
  const journal = join(state, 'surface_events.db');
  const db = new Database(journal, { create: true });
  db.run(`CREATE TABLE events (id TEXT, ts TEXT, text TEXT, summary TEXT, kind TEXT, refs TEXT, surface TEXT, direction TEXT)`);
  const at = new Date(Date.now() - 60_000).toISOString();
  db.run(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['started', at, 'start', 'start',
    'started', JSON.stringify({ seat: 'harness-child', source: 'elanous://harness/run-123/pty-456' }),
    'context:external', 'outbound']);
  db.run(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['finished', new Date(Date.parse(at) + 10_000).toISOString(),
    'done', 'Harness child finished: success', 'finished',
    JSON.stringify({ seat: 'harness-child', source: 'elanous://harness/run-123/pty-456' }), 'context:external', 'outbound']);
  db.run(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['missing-seat', at, 'report', 'report', '보고',
    JSON.stringify({ url: 'https://example.test/missing-seat' }), 'coord:channel', 'outbound']);
  db.close();
  const before = readFileSync(journal);
  const output = spawnSync(process.execPath,
    ['bin/elanous.mjs', `--test=${state}`, 'context', 'condense', '--since', '24h', '--dry-run', '--json'],
    { cwd: root, encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, ELANOUS_STATE_DIR: state, NODE_ENV: 'test' } });
  expect(output.status).toBe(0);
  const json = JSON.parse(output.stdout.split('\n')[0]!);
  expect(json).toMatchObject({ conflicts: 0, skipped: { 'no-seat': 1 }, folded: 0, droppedHarnessChild: 2 });
  expect(json.cards).toEqual([]);
  expect(json.funnel.read).toEqual({ total: 3, bySeat: { 'harness-child': 2, '(unknown)': 1 },
    bySurface: { 'context:external': 2, 'coord:channel': 1 } });
  expect(json.funnel.sources.droppedHarnessChild).toEqual({ total: 2, bySeat: { 'harness-child': 2 } });
  expect(output.stdout.trim().split('\n')).toHaveLength(1);
  expect(json).toHaveProperty('since');
  expect(json).toHaveProperty('until');
  expect(json).not.toHaveProperty('applied');
  expect(readdirSync(state)).toEqual(['surface_events.db']);
  expect(readFileSync(journal)).toEqual(before);
}, 120_000);

test('real isolated CLI previews an empty window without mutating an existing journal or creating candidate files', () => {
  const root = resolve(import.meta.dir, '../..');
  const state = mkdtempSync(join(root, 'context-condense-cli-')); dirs.push(state);
  const journal = join(state, 'surface_events.db');
  const db = new Database(journal, { create: true });
  db.run(`CREATE TABLE events (id TEXT, ts TEXT, text TEXT, summary TEXT, kind TEXT, refs TEXT, surface TEXT, direction TEXT)`);
  db.run(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['journal-1', '2020-01-01T00:00:00.000Z', 'fixture',
    'fixture', '보고', JSON.stringify({ seat: 'TC', url: 'https://example.test/journal' }), 'coord:channel', 'outbound']);
  db.close();
  const before = readFileSync(journal);
  const args = ['bin/elanous.mjs', `--test=${state}`, 'context', 'condense', '--since', '24h', '--dry-run'];
  const output = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, ELANOUS_STATE_DIR: state, NODE_ENV: 'test' } });
  expect(output.status).toBe(0);
  const [json, ...markdown] = output.stdout.split('\n');
  expect(JSON.parse(json!)).toMatchObject({ cards: [], conflicts: 0, skipped: {}, folded: 0 });
  expect(markdown.join('\n')).toContain('# Long-term context memory candidates');
  expect(markdown.join('\n')).toContain('Funnel: read 0 (OP 0 · TC 0 · MK 0 · UX 0) → sources 0');
  expect(readdirSync(state)).toEqual(['surface_events.db']);
  expect(readFileSync(journal)).toEqual(before);
  const bad = spawnSync(process.execPath, [...args, '--apply'], { cwd: root, encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, ELANOUS_STATE_DIR: state, NODE_ENV: 'test' } });
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain('--apply and --dry-run cannot be combined');
  expect(readdirSync(state)).not.toContain('context-memory');
  expect(readFileSync(journal)).toEqual(before);
  const applied = spawnSync(process.execPath, ['bin/elanous.mjs', `--test=${state}`, 'context', 'condense', '--since', '24h', '--apply'],
    { cwd: root, encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, ELANOUS_STATE_DIR: state, NODE_ENV: 'test' } });
  expect(applied.status).toBe(0);
  expect(JSON.parse(applied.stdout.split('\n')[0]!)).toMatchObject({ cards: [], conflicts: 0,
    applied: { written: 0, retired: 0, decisions: [] } });
  expect(readdirSync(state)).toEqual(['surface_events.db']);
  expect(readFileSync(journal)).toEqual(before);
}, 300_000);
