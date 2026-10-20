import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { parse } from 'yaml';
import { publishRelease, type ReleaseManifest, type Runner } from '../cli/release-cli.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { setSchedule } from '../release-loop/release-schedule.js';
import { decideReleaseDayPhase, runReleaseDayShadow, selectReleaseDaySchedules } from './release-day.js';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });
const at = (iso: string) => new Date(iso);
const schedule = {
  version: '0.2.28', cutAt: '2026-10-13T22:00:00.000Z', landBy: '2026-10-13T21:40:00.000Z',
  publishAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-13T13:39:53.438Z', updatedBy: 'OP',
};

test('release-day phases follow the schedule and wait for actual publication before green', () => {
  expect(decideReleaseDayPhase(schedule, at('2026-10-13T21:29:59Z'), null).phase).toBe('none');
  expect(decideReleaseDayPhase(schedule, at('2026-10-13T21:30:00Z'), null)).toMatchObject({ phase: 'gate-mode', dueAt: '2026-10-13T21:30:00.000Z' });
  expect(decideReleaseDayPhase(schedule, at('2026-10-13T21:40:00Z'), null)).toMatchObject({ phase: 'carry-p0', dueAt: schedule.landBy });
  expect(decideReleaseDayPhase({ ...schedule, landBy: '2026-10-13T21:20:00Z' }, at('2026-10-13T21:20:00Z'), null).phase).toBe('carry-p0');
  expect(selectReleaseDaySchedules([{ ...schedule, landBy: '2026-10-13T21:20:00Z' }], at('2026-10-13T21:20:00Z'),
    () => ({ publication: { kind: 'unpublished' }, greenObserved: false })).map(row => row.version)).toEqual([schedule.version]);
  expect(decideReleaseDayPhase(schedule, at('2026-10-13T22:00:00Z'), null)).toMatchObject({ phase: 'cut-run', dueAt: schedule.cutAt });
  expect(decideReleaseDayPhase(schedule, at('2026-10-14T00:05:00Z'), null).phase).toBe('cut-run');
  expect(decideReleaseDayPhase(schedule, at('2026-10-14T00:03:59Z'), '2026-10-14T00:04:00Z').phase).toBe('cut-run');
  expect(decideReleaseDayPhase(schedule, at('2026-10-14T00:04:00Z'), '2026-10-14T00:04:00Z'))
    .toMatchObject({ phase: 'green-back', dueAt: '2026-10-14T00:04:00Z' });
  const delayedPublish = { ...schedule, publishAt: '2026-10-14T00:10:00Z' };
  expect(decideReleaseDayPhase(delayedPublish, at('2026-10-14T00:09:59Z'), '2026-10-14T00:04:00Z').phase).toBe('cut-run');
  expect(decideReleaseDayPhase(delayedPublish, at('2026-10-14T00:10:00Z'), '2026-10-14T00:04:00Z'))
    .toMatchObject({ phase: 'green-back', dueAt: delayedPublish.publishAt });
});

test('each tick rereads changed schedule and records each version/phase only once in the isolated shadow ledger', () => {
  root = mkdtempSync(join(tmpdir(), 'release-day-shadow-'));
  setSchedule('0.2.28', { cutAt: '2026-10-14T07:00+09:00', landBy: '2026-10-14T06:40+09:00', publishAt: '2026-10-14T09:00+09:00' }, 'OP', root);
  let now = at('2026-10-13T21:30:00Z');
  const logs: Array<Record<string, unknown>> = [];
  const deps = { now: () => now, releaseRoot: root, stateRoot: root, log: (_event: string, data: Record<string, unknown>) => logs.push(data) };
  expect(runReleaseDayShadow(deps)[0]).toMatchObject({ phase: 'gate-mode', recorded: true });
  expect(runReleaseDayShadow(deps)[0]).toMatchObject({ phase: 'gate-mode', recorded: false });
  now = at('2026-10-13T21:40:00Z');
  expect(runReleaseDayShadow(deps)[0]).toMatchObject({ phase: 'carry-p0', recorded: true });
  // A reschedule is read on the next tick, without editing a per-release cron entry.
  setSchedule('0.2.28', { cutAt: '2026-10-14T07:30+09:00', landBy: '2026-10-14T07:10+09:00', publishAt: '2026-10-14T09:30+09:00' }, 'OP', root);
  expect(runReleaseDayShadow(deps)[0]).toMatchObject({ phase: 'none', recorded: false });
  now = at('2026-10-13T22:30:00Z');
  expect(runReleaseDayShadow(deps)[0]).toMatchObject({ phase: 'cut-run', recorded: true });
  now = at('2026-10-14T00:30:00Z');
  expect(runReleaseDayShadow(deps)[0]).toMatchObject({ phase: 'cut-run', recorded: false });
  const db = new Database(join(root, 'steward', 'release-day-shadow.sqlite'));
  try {
    expect(db.query('SELECT phase, due_at, observed_at FROM phase_observations ORDER BY observed_at').all()).toEqual([
      { phase: 'gate-mode', due_at: '2026-10-13T21:30:00.000Z', observed_at: '2026-10-13T21:30:00.000Z' },
      { phase: 'carry-p0', due_at: '2026-10-13T21:40:00.000Z', observed_at: '2026-10-13T21:40:00.000Z' },
      { phase: 'cut-run', due_at: '2026-10-13T22:30:00.000Z', observed_at: '2026-10-13T22:30:00.000Z' },
    ]);
  } finally { db.close(); }
  expect(logs.at(-1)).toMatchObject({ phase: 'cut-run', recorded: false, mode: 'shadow' });
});

test('a next gate and a delayed prior green can both be observed, and the graph only runs the shadow recipe', () => {
  const old = { ...schedule, version: '0.2.27', cutAt: '2026-10-12T22:00:00Z' };
  const state = (version: string) => ({ publication: version === '0.2.27'
    ? { kind: 'published' as const, at: '2026-10-13T21:25:00Z' } : { kind: 'unpublished' as const }, greenObserved: false });
  expect(selectReleaseDaySchedules([old, schedule], at('2026-10-13T21:30:00Z'), state).map(row => row.version)).toEqual(['0.2.28', '0.2.27']);
  expect(selectReleaseDaySchedules([old], at('2026-10-15T12:00:00Z'), () => ({ publication: { kind: 'published', at: '2026-10-12T23:00:00Z' }, greenObserved: false })).map(row => row.version)).toEqual(['0.2.27']);
  const graph = parse(readFileSync(join(import.meta.dir, '../../graphs/steward/release-day.yaml'), 'utf8')) as {
    graph_id: string; loop: { trigger: { cron: string } }; nodes: Array<{ node_id: string; recipe?: string }>;
  };
  const recipes = parse(readFileSync(join(import.meta.dir, '../../graphs/steward/recipes.yaml'), 'utf8')) as Record<string, { command: string }>;
  expect(graph.graph_id).toBe('steward-release-day');
  expect(graph.loop.trigger.cron).toBe('*/5 * * * *');
  expect(graph.nodes[0]).toMatchObject({ node_id: 'release-day', recipe: 'cmd:steward-release-day' });
  expect(recipes['steward-release-day']?.command).toContain('src/steward/release-day.ts');
  expect(existsSync(join(import.meta.dir, '../../graphs/steward/release-day.yaml'))).toBe(true);
});

test('publication delayed beyond twelve hours still produces green, alongside the next release gate', () => {
  root = mkdtempSync(join(tmpdir(), 'release-day-overlap-'));
  const prior = { ...schedule, version: '0.2.28', cutAt: '2026-10-13T00:00:00Z', landBy: '2026-10-12T23:40:00Z' };
  const next = { ...schedule, version: '0.2.29', cutAt: '2026-10-15T00:30:00Z', landBy: '2026-10-15T00:10:00Z' };
  let now = at('2026-10-13T00:00:00Z');
  let published: string | null = null;
  const deps = { now: () => now, stateRoot: root, releaseRoot: root, schedules: () => [prior, next],
    publishedAt: (version: string) => version === prior.version ? published : null, log: () => {} };
  expect(runReleaseDayShadow(deps)).toContainEqual(expect.objectContaining({ version: prior.version, phase: 'cut-run', recorded: true }));
  now = at('2026-10-15T00:00:00Z');
  expect(runReleaseDayShadow(deps).map(row => [row.version, row.phase])).toEqual([[next.version, 'gate-mode'], [prior.version, 'cut-run']]);
  published = '2026-10-15T00:02:00Z';
  now = at('2026-10-15T00:05:00Z');
  expect(runReleaseDayShadow(deps).map(row => [row.version, row.phase, row.recorded])).toEqual([
    [next.version, 'gate-mode', false], [prior.version, 'green-back', true],
  ]);
  expect(runReleaseDayShadow(deps).find(row => row.version === prior.version)).toBeUndefined();
});

test('two unfinished releases remain visible after the next cut, and a late first tick sees published green', () => {
  root = mkdtempSync(join(tmpdir(), 'release-day-late-first-'));
  const prior = { ...schedule, version: '0.2.28', cutAt: '2026-10-13T00:00:00Z' };
  const next = { ...schedule, version: '0.2.29', cutAt: '2026-10-14T00:00:00Z' };
  let published: string | null = null;
  const deps = { now: () => at('2026-10-15T00:00:00Z'), stateRoot: root, releaseRoot: root,
    schedules: () => [prior, next], publishedAt: (version: string) => version === prior.version ? published : null, log: () => {} };
  expect(runReleaseDayShadow(deps).map(row => [row.version, row.phase, row.recorded])).toEqual([
    [prior.version, 'cut-run', true], [next.version, 'cut-run', true],
  ]);
  published = '2026-10-14T00:05:00Z';
  expect(runReleaseDayShadow(deps).find(row => row.version === prior.version)).toMatchObject({ phase: 'green-back', recorded: true });
  const freshRoot = mkdtempSync(join(tmpdir(), 'release-day-first-after-publish-'));
  try {
    expect(runReleaseDayShadow({ ...deps, stateRoot: freshRoot }).find(row => row.version === prior.version)).toMatchObject({ phase: 'green-back', recorded: true });
  } finally { rmSync(freshRoot, { recursive: true, force: true }); }
});

test('a first tick after two completed releases records both green phases once', () => {
  root = mkdtempSync(join(tmpdir(), 'release-day-two-published-'));
  const first = { ...schedule, version: '0.2.28', cutAt: '2026-10-13T00:00:00Z' };
  const second = { ...schedule, version: '0.2.29', cutAt: '2026-10-14T00:00:00Z' };
  const deps = { now: () => at('2026-10-16T00:00:00Z'), stateRoot: root, releaseRoot: root,
    schedules: () => [first, second],
    publishedAt: (version: string) => version === first.version ? '2026-10-13T01:00:00Z' : '2026-10-14T02:00:00Z', log: () => {} };
  expect(runReleaseDayShadow(deps).map(row => [row.version, row.phase, row.recorded])).toEqual([
    [first.version, 'green-back', true], [second.version, 'green-back', true],
  ]);
  expect(runReleaseDayShadow(deps)).toEqual([]);
});

test('a damaged release record is unmeasured, never a cut-run, while an absent record is unpublished', () => {
  root = mkdtempSync(join(tmpdir(), 'release-day-unmeasured-'));
  const dir = join(root, 'release', schedule.version);
  mkdirSync(dir, { recursive: true });
  const record = join(dir, 'release.json');
  const events: Array<[string, Record<string, unknown>]> = [];
  const deps = { now: () => at('2026-10-13T22:00:00Z'), stateRoot: root, releaseRoot: root,
    schedules: () => [schedule], log: (event: string, data: Record<string, unknown>) => events.push([event, data]) };
  for (const body of ['{bad json', JSON.stringify({ version: '0.2.27', publishedAt: '2026-10-13T22:01:00Z' }),
    JSON.stringify({ version: schedule.version }),
    JSON.stringify({ version: schedule.version, publishedAt: 'invalid' })]) {
    writeFileSync(record, body);
    expect(runReleaseDayShadow(deps)[0]).toMatchObject({ phase: 'unmeasured', recorded: false });
    expect(events.at(-1)?.[0]).toBe('unmeasured');
  }
  const db = new Database(join(root, 'steward', 'release-day-shadow.sqlite'));
  try { expect(db.query('SELECT COUNT(*) AS n FROM phase_observations').get()).toEqual({ n: 0 }); }
  finally { db.close(); }
  unlinkSync(record);
  mkdirSync(record);
  expect(runReleaseDayShadow(deps)[0]).toMatchObject({ phase: 'unmeasured', reason: 'release-record-read-failed', recorded: false });
  rmSync(record, { recursive: true });
  expect(runReleaseDayShadow(deps)[0]).toMatchObject({ phase: 'cut-run', recorded: true });
  writeFileSync(record, JSON.stringify({ version: schedule.version, publishedAt: '2026-10-14T00:04:00Z' }));
  expect(runReleaseDayShadow({ ...deps, now: () => at('2026-10-14T00:05:00Z') })[0]).toMatchObject({ phase: 'green-back', recorded: true });
  expect(events.at(-1)?.[0]).toBe('decision');
  expect(events.at(-1)?.[1]).toMatchObject({ phase: 'green-back', recorded: true });
});

test('the actual publish path creates the record that opens green-back on the next shadow tick', async () => {
  root = mkdtempSync(join(tmpdir(), 'release-day-publish-path-'));
  const version = '0.2.98';
  const prepared = join(root, 'prepared');
  const dist = join(prepared, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'SHA256SUMS'), '');
  const notesFile = join(prepared, 'notes.md');
  writeFileSync(notesFile, '# Isolated release\n');
  const manifest: ReleaseManifest = {
    version, tag: `v${version}`, prerelease: false, publicRepo: 'ElanvitalAI/elanous', sourceRef: 'origin/main',
    sourceCommit: 'a'.repeat(40), publicCommit: 'b'.repeat(40), publicDir: prepared, distDir: dist,
    files: [], webUi: true, e2e: { ran: false }, preparedAt: new Date().toISOString(),
  };
  writeFileSync(join(prepared, 'release.json'), JSON.stringify(manifest));
  const cutAt = new Date(Date.now() - 60 * 60_000).toISOString();
  setSchedule(version, { cutAt, landBy: new Date(Date.parse(cutAt) - 20 * 60_000).toISOString(),
    publishAt: new Date().toISOString() }, 'test', root);
  const events: Array<[string, Record<string, unknown>]> = [];
  const shadow = () => runReleaseDayShadow({ now: () => new Date(), releaseRoot: root, stateRoot: root,
    log: (event, data) => events.push([event, data]) });
  const fakeRunner: Runner = (command, args) => {
    if (command === 'gh' && args[1] === 'view') return { status: 1, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'show-ref') return { status: 1, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${manifest.sourceCommit}\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  setElanousConfigDir(root);
  try {
    expect(shadow()[0]).toMatchObject({ version, phase: 'cut-run', recorded: true });
    const result = await publishRelease({ dir: prepared, notesFile, yes: true, repoRoot: root,
      instanceRoot: root, ledgerRoot: root, log: () => {} }, fakeRunner);
    expect(result.published).toBe(true);
    const record = join(root, 'release', version, 'release.json');
    const publishedAt = (JSON.parse(readFileSync(record, 'utf8')) as ReleaseManifest & { publishedAt: string }).publishedAt;
    expect(Number.isFinite(Date.parse(publishedAt))).toBe(true);
    expect(shadow()[0]).toMatchObject({ version, phase: 'green-back', dueAt: publishedAt, recorded: true });
    const db = new Database(join(root, 'steward', 'release-day-shadow.sqlite'));
    try {
      expect(db.query('SELECT phase FROM phase_observations WHERE version = ? ORDER BY observed_at').all(version))
        .toEqual([{ phase: 'cut-run' }, { phase: 'green-back' }]);
    } finally { db.close(); }
    expect(events.at(-1)).toMatchObject(['decision', { version, phase: 'green-back', publishedAt, recorded: true }]);
  } finally { resetElanousConfigDir(); }
});
