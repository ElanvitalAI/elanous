// CURRENT-RELEASE-ONE-SOURCE (대표 11-28) — the one current-board record, its flip in the release graph tick, the readers
// and `release current`. Literal expectations only; every disk write goes to a temp root (config dir override = ledger root).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { activeBoardVersion, readBoardPointer, resolveCurrentVersion } from '../ops-dashboard/current-version.js';
import { checklistVersion } from '../cli/release-checklist-read-cli.js';
import { currentBoardReport, renderCurrentBoard } from '../cli/release-current-cli.js';
import { announceBoardFlip, boardHistoryPath, boardRecordPath, flipBoardAfterPublish, nextBoardVersion, readBoardRecord, setBoard } from './current-board.js';
import { createRun, loadRun, markDone, readLedger, tickRelease, type ExecDeps, type StepDef } from './release-graph-exec.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'current-board-')); });
afterEach(() => { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); });
const NOW = new Date('2026-11-27T21:01:30.000Z');

describe('the record', () => {
  test('first flip after publishing 0.3.38 → 0.3.39 · same target again = already · an older publish is refused · history = 1 line', () => {
    const a = flipBoardAfterPublish({ published: '0.3.38', by: 'release-graph:0.3.38', now: NOW, ledgerRoot: root });
    expect(a).toEqual({ kind: 'flipped', record: { current: '0.3.39', previous: '0.3.38', flippedAt: '2026-11-27T21:01:30.000Z', by: 'release-graph:0.3.38', cause: 'published 0.3.38', seq: 1 } });
    expect(flipBoardAfterPublish({ published: '0.3.38', by: 'B', ledgerRoot: root }).kind).toBe('already');
    const old = flipBoardAfterPublish({ published: '0.3.37', by: 'C', ledgerRoot: root });
    expect(old).toMatchObject({ kind: 'refused', reason: 'board is already 0.3.39 — a flip never moves it back to 0.3.38' });
    expect(readBoardRecord(root)?.current).toBe('0.3.39');
    expect(readFileSync(boardHistoryPath(root), 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  });

  test('hand set may go back (reason kept) · seq counts every write', () => {
    flipBoardAfterPublish({ published: '0.3.38', by: 'G', ledgerRoot: root, now: NOW });
    const back = setBoard({ to: '0.3.38', by: 'OP', cause: 'flip was early', ledgerRoot: root, now: NOW });
    expect(back).toMatchObject({ kind: 'flipped', record: { current: '0.3.38', previous: '0.3.39', by: 'OP', cause: 'flip was early', seq: 2 } });
    expect(() => setBoard({ to: '0.3.38-dev.0', by: 'OP', cause: 'x', ledgerRoot: root })).toThrow('not an x.y.z version: 0.3.38-dev.0');
    expect(() => setBoard({ to: '0.3.40', by: ' ', cause: 'x', ledgerRoot: root })).toThrow('--by and --cause are required');
  });

  test('next patch literal · non-bare refused · a corrupt or missing record reads null', () => {
    expect([nextBoardVersion('0.3.38'), nextBoardVersion('0.3.99'), nextBoardVersion('1.0.0')]).toEqual(['0.3.39', '0.3.100', '1.0.1']);
    expect(() => nextBoardVersion('0.3.39-dev.0')).toThrow('not an x.y.z version');
    expect(readBoardRecord(root)).toBe(null);
    mkdirSync(join(root, 'release'), { recursive: true });
    writeFileSync(boardRecordPath(root), '{ torn');
    expect(readBoardRecord(root)).toBe(null);
  });

  test('announce: a failing bus never stops the fact (fail-open per sink)', () => {
    const rec = flipBoardAfterPublish({ published: '0.3.38', by: 'G', ledgerRoot: root, now: NOW });
    if (rec.kind !== 'flipped') throw new Error('expected a flip');
    const facts: string[] = [];
    const out = announceBoardFlip(rec.record, { stateRoot: root, busPost: () => { throw new Error('bus: write lock busy'); }, fact: (r) => { facts.push(`${r.previous}->${r.current}`); return true; } });
    expect(out).toEqual({ bus: 'failed: Error: bus: write lock busy', fact: 'recorded' });
    expect(facts).toEqual(['0.3.38->0.3.39']);
  });
});

describe('readers', () => {
  const config = (v: string | null) => writeFileSync(join(root, 'config.json'), `${JSON.stringify({ release: { graph: { mode: 'live', ...(v ? { version: v } : {}) } } })}\n`);

  test('record 0.3.39 wins over release.graph.version 0.3.38 and the package · every door says 0.3.39', () => {
    setElanousConfigDir(root, 'programmatic'); config('0.3.38');
    expect(activeBoardVersion(undefined, () => '0.3.37')).toBe('0.3.38');
    flipBoardAfterPublish({ published: '0.3.38', by: 'G', ledgerRoot: root });
    expect(activeBoardVersion(undefined, () => '0.3.37')).toBe('0.3.39');
    expect(readBoardPointer()).toBe('0.3.39');
    expect(checklistVersion(undefined, {})).toBe('0.3.39');
    expect(resolveCurrentVersion({ hqRoot: join(root, 'hq'), ledgerRoot: root })).toMatchObject({ version: '0.3.39', source: 'board', published: false });
    expect(resolveCurrentVersion({ hqRoot: join(root, 'hq'), ledgerRoot: root, boardVersion: null })).toMatchObject({ version: '0.3.38', source: 'graph' });
  });

  test('no record and no graph target → pointer null (guards skip) · board falls back to the package', () => {
    setElanousConfigDir(root, 'programmatic'); config(null);
    expect(readBoardPointer()).toBe(null);
    expect(activeBoardVersion(undefined, () => '0.3.37')).toBe('0.3.37');
  });
});

describe('release current report', () => {
  test('lagging board: published current · package ahead · graph newer · stale plan → four warnings, literal', () => {
    const r = currentBoardReport({ ledgerRoot: '/L', record: () => ({ current: '0.3.38', previous: '0.3.37', flippedAt: 'T', by: 'G', cause: 'published 0.3.37', seq: 4 }),
      graphVersion: () => '0.3.39', packageVersion: () => '0.3.39', published: (v) => v === '0.3.38', planVersion: () => '0.3.37' });
    expect(r.current).toBe('0.3.38'); expect(r.source).toBe('board');
    expect(r.checks.map(c => c.level)).toEqual(['warn', 'warn', 'warn', 'warn']);
    expect(r.checks[0]!.what.startsWith('current board 0.3.38 is already published')).toBe(true);
  });

  test('healthy right after a flip: graph/package behind are notes, no warnings', () => {
    const r = currentBoardReport({ ledgerRoot: '/L', record: () => ({ current: '0.3.39', previous: '0.3.38', flippedAt: '2026-11-27T21:01:30.000Z', by: 'release-graph:0.3.38', cause: 'published 0.3.38 (graph)', seq: 1 }),
      graphVersion: () => '0.3.38', packageVersion: () => '0.3.38', published: () => false, planVersion: () => null });
    expect(r.checks.map(c => c.level)).toEqual(['note', 'note']);
    expect(renderCurrentBoard(r).split('\n')[0]).toBe('현재 판 (current board) = 0.3.39 · source board');
    expect(renderCurrentBoard(r).split('\n').at(-1)).toBe('  ✓ no live config/state disagrees with the board');
  });

  test('no record → warn and the legacy source is named', () => {
    const r = currentBoardReport({ ledgerRoot: '/L', record: () => null, graphVersion: () => '0.3.38', packageVersion: () => '0.3.38', published: () => false, planVersion: () => null });
    expect(r.source).toBe('graph');
    expect(r.checks).toEqual([{ level: 'warn', what: 'no current-board record (/L/release/current-board.json) — readers fall back to release.graph.version 0.3.38' }]);
  });
});

describe('release graph tick — the board-flip step', () => {
  const V = '0.3.38';
  const CLOCK = { rehearsalAt: '2026-11-27T13:00:00.000Z', cutAt: '2026-11-27T19:00:00.000Z', publishAt: '2026-11-27T21:00:00.000Z' };
  const OPTS = { seatState: '/hq/seat-state', uid: 501, cli: 'elanous', repo: '/r', instanceRoot: '/i' };
  const PRE = ['cli-fresh', 'notes', 'roster', 'schedule', 'cut', 'cut-push', 'pregate', 'prebuild', 'prepare', 'rehearsal', 'go', 'notes-public'];
  let mail: string[]; let started: string[]; let now: Date;
  const deps = (flipBoard?: ExecDeps['flipBoard'], exits: Record<string, number> = {}): ExecDeps => ({
    now: () => now, stateRoot: root, mode: () => 'live',
    probes: { now: () => now, watch: async () => null, mtimeMs: () => null, readJson: () => ({}), readLines: () => [], cells: async () => [], idleSeats: async () => [],
      landedCount: async () => 0, handsUpCount: async () => 0, publishedVersions: async () => [], installedVersion: async () => null },
    detect: async (_v: string, _s: StepDef) => null,
    start: (step, _c, log, rc) => { started.push(step.id); writeFileSync(log, 'x\n'); writeFileSync(rc, `${exits[step.id] ?? 0}\n`); return 1; },
    alive: () => false, post: (_to, _k, body) => { mail.push(body); return `msg#${mail.length}`; }, planOptions: OPTS,
    ...(flipBoard ? { flipBoard } : {}),
  });
  beforeEach(() => {
    mail = []; started = []; now = new Date('2026-11-27T12:00:00.000Z');
    createRun(root, { version: V, quick: true, clock: CLOCK, notesFile: '/h/n.md', prepDir: '/h/p' }, now);
    for (const id of PRE) markDone(root, V, id, 'T', 'pre', now, OPTS);
  });
  const publish = async (d: ExecDeps) => {
    now = new Date('2026-11-27T21:00:10.000Z'); await tickRelease(V, d);
    now = new Date('2026-11-27T21:01:00.000Z'); await tickRelease(V, d);
  };
  const writer: ExecDeps['flipBoard'] = (published, i) => {
    const r = flipBoardAfterPublish({ published, by: i.by, cause: i.cause, now: i.now, ledgerRoot: root });
    return { kind: r.kind, current: r.record.current, previous: r.record.previous };
  };

  test('publish done → flip in the same tick, before npm starts · a dev-bump failure leaves the board alone', async () => {
    await publish(deps(writer, { 'dev-bump': 1 }));
    const rows = readLedger(root, V).map(r => `${r.kind}:${r.step ?? ''}`);
    expect(rows.indexOf('board-flip:board-flip')).toBeLessThan(rows.indexOf('started:npm'));
    expect(rows.indexOf('board-flip:board-flip')).toBeGreaterThan(rows.indexOf('step-done:publish'));
    expect(loadRun(root, V)!.steps['board-flip']).toMatchObject({ status: 'done', by: 'graph', ref: 'board 0.3.38 → 0.3.39 (flipped)' });
    expect(readBoardRecord(root)).toMatchObject({ current: '0.3.39', previous: '0.3.38', by: 'release-graph:0.3.38', cause: 'published 0.3.38 (graph)', seq: 1 });
    now = new Date('2026-11-27T21:03:00.000Z'); await tickRelease(V, deps(writer, { 'dev-bump': 1 }));
    expect(loadRun(root, V)!.steps['dev-bump']!.by).toBe('graph(soft-fail)');
    expect(readBoardRecord(root)?.current).toBe('0.3.39');
    expect(started.includes('board-flip')).toBe(false);
  });

  test('publish fails → no flip, no record', async () => {
    await publish(deps(writer, { publish: 1 }));
    expect(loadRun(root, V)!.hardStop?.step).toBe('publish');
    expect(loadRun(root, V)!.steps['board-flip']!.status).toBe('pending');
    expect(existsSync(boardRecordPath(root))).toBe(false);
  });

  test('write fails → pending + one card, retried next tick', async () => {
    let fails = 2;
    const flaky: ExecDeps['flipBoard'] = (p, i) => { if (fails-- > 0) throw new Error('EIO'); return writer!(p, i); };
    await publish(deps(flaky));
    expect(loadRun(root, V)!.steps['board-flip']!.status).toBe('pending');
    now = new Date('2026-11-27T21:02:00.000Z'); await tickRelease(V, deps(flaky));
    now = new Date('2026-11-27T21:03:00.000Z'); await tickRelease(V, deps(flaky));
    expect(loadRun(root, V)!.steps['board-flip']!.status).toBe('done');
    expect(mail.filter(b => b.includes('current board flip failed'))).toHaveLength(1);
    expect(readBoardRecord(root)?.current).toBe('0.3.39');
  });

  test('no writer wired → done with a warning, nothing written', async () => {
    await publish(deps(undefined));
    expect(loadRun(root, V)!.steps['board-flip']).toMatchObject({ status: 'done', by: 'graph(unwired)', warnings: ['no board writer wired'] });
    expect(existsSync(boardRecordPath(root))).toBe(false);
  });
});
