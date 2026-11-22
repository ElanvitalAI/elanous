import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import * as featureStore from '../release-loop/feature-store.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalOpThirtyMinuteSources, localMainFetchAt, opThirtyMinuteSnapshot, readOpChecklistGreen, type OpThirtyMinuteSources } from './ops-30m-check.js';
import { simCli } from '../ux-sim/in-process-cli.js';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

const sources = (): OpThirtyMinuteSources => ({
  mainLog: Array.from({ length: 12 }, (_, i) => `sha-${i}`).join('\n'),
  mainPackage: '{"version":"0.3.33-dev.0"}',
  checklist: '{"green":9,"yellow":2,"red":0,"done":3}',
  lastFetchAt: new Date().toISOString(),
  trainLog: `${new Date().toISOString()} [train-manager] tick base=abc queue=2`,
  reviewQueue: 'pr\tengine\tclaimedBy\tstatus\n1\tterra\t\tqueued\n2\tterra\tJUD\tqueued\n',
  landingSubLog: `${new Date().toISOString()} land pulse alive`,
});

test('OP 30-minute product CLI consumes isolated raw sources and reports every prompt observation', async () => {
  root = mkdtempSync(join(tmpdir(), 'op-check-30m-'));
  mkdirSync(join(root, 'fixtures'));
  const input = { ...sources(), trainLog: `${new Date().toISOString()} [train-manager] tick TRAIN-SECRET-4a TRAIN-MAIL-4b`, landingSubLog: `${new Date().toISOString()} LAND-SECRET-5a LAND-MAIL-5b` };
  writeFileSync(join(root, 'fixtures', 'op-30m-sources.json'), JSON.stringify(input));
  const result = await simCli(['ops', 'check-30m', '--previous-green', '3', '--expect-version', '0.3.33', '--json'],
    { stateRoot: root, allowPaths: [['ops', 'check-30m']] });
  expect(result.exitCode).toBe(0);
  for (const secret of ['TRAIN-SECRET-4a', 'TRAIN-MAIL-4b', 'LAND-SECRET-5a', 'LAND-MAIL-5b']) {
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  }
  const report = JSON.parse(result.stdout) as ReturnType<typeof opThirtyMinuteSnapshot>;
  expect(report).toMatchObject({ version: '0.3.33', landings30m: 12, green: 9, greenDelta: 6,
    reviewUnclaimed: 1, malformedQueueRows: 0, complete: true });
  expect(report.trainTickObserved).toBe(true);
  expect(report.landingSubObserved).toBe(true);
  for (const value of ['0', '9999']) {
    const boundary = await simCli(['ops', 'check-30m', '--previous-green', value, '--expect-version', '0.3.33', '--json'],
      { stateRoot: root, allowPaths: [['ops', 'check-30m']] });
    expect(boundary.exitCode).toBe(0);
    expect(JSON.parse(boundary.stdout).greenDelta).toBe(9 - Number(value));
  }
  for (const value of ['10000', '00', '1\n', '1\r\n']) {
    const invalid = await simCli(['ops', 'check-30m', '--previous-green', value, '--json'],
      { stateRoot: root, allowPaths: [['ops', 'check-30m']] });
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain('previous green count must be an integer from 0 to 9999');
  }
  const developmentVersion = await simCli(['ops', 'check-30m', '--previous-green', '3', '--expect-version', '0.3.33-dev.0', '--json'],
    { stateRoot: root, allowPaths: [['ops', 'check-30m']] });
  expect(developmentVersion.exitCode).toBe(0);
  const otherDevelopmentVersion = await simCli(['ops', 'check-30m', '--previous-green', '3', '--expect-version', '0.3.34-dev.42', '--json'],
    { stateRoot: root, allowPaths: [['ops', 'check-30m']] });
  expect(otherDevelopmentVersion.exitCode).not.toBe(0);
  expect(otherDevelopmentVersion.stderr).toContain('main version changed');
  const error = await simCli(['ops', 'check-30m', '--previous-green', '3', '--expect-version', '0.3.34', '--json'],
    { stateRoot: root, allowPaths: [['ops', 'check-30m']] });
  expect(error.exitCode).not.toBe(0);
  for (const secret of ['TRAIN-SECRET-4a', 'TRAIN-MAIL-4b', 'LAND-SECRET-5a', 'LAND-MAIL-5b']) {
    expect(error.stdout).not.toContain(secret);
    expect(error.stderr).not.toContain(secret);
  }
});

test('first-parent counts a multi-commit PR once and labels direct pushes', () => {
  root = mkdtempSync(join(tmpdir(), 'op-history-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('commit', '--allow-empty', '-qm', 'base');
  git('checkout', '-qb', 'pr');
  git('commit', '--allow-empty', '-qm', 'first');
  git('commit', '--allow-empty', '-qm', 'second');
  git('checkout', '-q', '-');
  git('merge', '--no-ff', '-qm', 'Merge pull request #42 from fixture/pr', 'pr');
  git('commit', '--allow-empty', '-qm', 'squash (#43)');
  git('commit', '--allow-empty', '-qm', 'Merge pull request #44 from fixture/not-a-merge');
  git('commit', '--allow-empty', '-qm', 'version bump');
  git('commit', '--allow-empty', '--allow-empty-message', '-qm', '');
  const mainLog = git('log', '--first-parent', '--format=%h%x09%P%x09%s', 'HEAD~5..HEAD');
  expect(opThirtyMinuteSnapshot({ ...sources(), mainLog }, 3))
    .toMatchObject({ landings30m: 5, landingsWithoutPr30m: 3 });
});

test('unknown unclaimed statuses are separate and incomplete', () => {
  const reviewQueue = 'pr\tengine\tclaimedBy\tstatus\n1\tterra\t\tqueued\n2\tterra\t  \tblocked\n3\tterra\tJUD\tqueued\n4\tterra\t\tother\n';
  expect(opThirtyMinuteSnapshot({ ...sources(), reviewQueue }, 3))
    .toMatchObject({ reviewUnclaimed: 2, malformedQueueRows: 0, unknownQueueRows: 1, unclaimedUnknownQueueRows: 1, complete: false });
});

test('queue rejects reordered headers and never takes semantics from later columns', () => {
  const normal = 'pr\tengine\tclaimedBy\tstatus\tnote\n1\tt\t\tqueued\tclosed\n2\tt\t\tclosed\tqueued\n';
  expect(opThirtyMinuteSnapshot({ ...sources(), reviewQueue: normal }, 3))
    .toMatchObject({ reviewUnclaimed: 1, unknownQueueRows: 0, complete: true });
  for (const reviewQueue of [
    'status\tclaimedBy\tpr\tengine\nqueued\t\t1\tt\n',
    'pr\tengine\tclaimedBy\tnote\tstatus\n1\tt\t\tx\tqueued\n',
    'pr\tengine\tnote\tstatus\tclaimedBy\n1\tt\tx\tqueued\t\n',
  ]) expect(() => opThirtyMinuteSnapshot({ ...sources(), reviewQueue }, 3)).toThrow('review queue columns are unavailable');
});

test('malformed review queue is not counted as zero', () => {
  const bad = { ...sources(), reviewQueue: 'pr\tengine\tclaimedBy\tstatus\n1\tterra\t\tqueued\n2\tbroken\n' };
  expect(opThirtyMinuteSnapshot(bad, 3)).toMatchObject({ reviewUnclaimed: null, malformedQueueRows: 1, complete: false });
});


test('source lines over 256 characters cannot become a complete observation', () => {
  for (const key of ['trainLog', 'landingSubLog'] as const) {
    const prefix = `${new Date().toISOString()} ${key === 'trainLog' ? '[train-manager] tick ' : 'landing '}`;
    const exact = prefix + 'x'.repeat(256 - prefix.length);
    expect(opThirtyMinuteSnapshot({ ...sources(), [key]: exact }, 3).complete).toBe(true);
    const snapshot = opThirtyMinuteSnapshot({ ...sources(), [key]: exact + 'x' }, 3);
    expect(snapshot.complete).toBe(false);
    expect(key === 'trainLog' ? snapshot.trainTickObserved : snapshot.landingSubObserved).toBe(false);
  }
});

test('actual mixed-format queue and empty landing log remain incomplete', () => {
  const mixed = 'pr\tengine\tclaimedBy\tstatus\n2026-11-19T19:55\tHAND-ELN-ELS-MCP\t39071\t[ELS-OP-ALLOW-RULE]\tclaim:\topen\thead c64e4bcef5d\tGATES:진행중\n38148\tterra-third\tOP\tskip · OP 가 이미 띄움/수리 대기\n';
  expect(opThirtyMinuteSnapshot({ ...sources(), reviewQueue: mixed, landingSubLog: '' }, 3))
    .toMatchObject({ reviewUnclaimed: 0, malformedQueueRows: 0, legacyQueueRows: 1, unknownQueueRows: 0, landingSubObserved: false, complete: false });
  expect(opThirtyMinuteSnapshot({ ...sources(), reviewQueue: mixed }, 3))
    .toMatchObject({ reviewUnclaimed: 0, malformedQueueRows: 0, legacyQueueRows: 1, complete: true });
});

// JUD-B #129644 probe cases, kept verbatim in ops-30m-judb-probe.ts.
test('JUD-B probe regression and OP v2 queue classification', () => {
  const cases: Array<[string, string, number | null, number, number, boolean]> = [
    ['queued', '1\tt\t\tqueued', 1, 0, 0, true],
    ['blocked', '1\tt\t\tblocked', 1, 0, 0, true],
    ['closed', '1\tt\t\tclosed', 0, 0, 0, true],
    ['unknown', '1\tt\t\taws1', 0, 0, 1, false],
    ['unknownClaimed', '1\tt\tJUD\taws1', 0, 0, 1, true],
    ['extra', '1\tt\t\tqueued\tnote', 1, 0, 0, true],
    ['short', '1\tt\t', null, 1, 0, false],
    ['suffix', '1\tt\t\tqueued · note', 1, 0, 0, true],
  ];
  for (const [_name, line, reviewUnclaimed, malformedQueueRows, unknownQueueRows, complete] of cases) {
    expect(opThirtyMinuteSnapshot({ ...sources(), reviewQueue: 'pr\tengine\tclaimedBy\tstatus\n' + line + '\n' }, 3))
      .toMatchObject({ reviewUnclaimed, malformedQueueRows, unknownQueueRows, complete });
  }
  for (const status of ['pass','pass-with-warn','fail','warn','skip','reviewed','merged','done','done-merged','done-closed','closed','사후','claim:JUD']) {
    expect(opThirtyMinuteSnapshot({ ...sources(), reviewQueue: `pr\tengine\tclaimedBy\tstatus\n1\tt\t\t${status} (note)\n` }, 3))
      .toMatchObject({ reviewUnclaimed: 0, unknownQueueRows: 0, complete: true });
  }
  for (const status of ['queued','ready','blocked','pending','-','']) {
    expect(opThirtyMinuteSnapshot({ ...sources(), reviewQueue: `pr\tengine\tclaimedBy\tstatus\n1\tt\t\t${status}\n` }, 3))
      .toMatchObject({ reviewUnclaimed: 1, unknownQueueRows: 0, complete: true });
  }
});


test('legacy rows are informational; hash PRs are v2 and short rows malformed', () => {
  const reviewQueue = 'pr\tengine\tclaimedBy\tstatus\n2026-11-19T19:55\tx\t\tqueued\n#42\tx\t\tqueued\nlegacy\tx\t\n';
  expect(opThirtyMinuteSnapshot({ ...sources(), reviewQueue }, 3)).toMatchObject({
    reviewUnclaimed: null, legacyQueueRows: 1, malformedQueueRows: 1, complete: false,
  });
  expect(opThirtyMinuteSnapshot({ ...sources(), reviewQueue: reviewQueue.replace('legacy\tx\t\n', '') }, 3))
    .toMatchObject({ reviewUnclaimed: 1, legacyQueueRows: 1, malformedQueueRows: 0, complete: true });
});

test('timestamped observations use a single check time and inclusive 30-minute boundary', () => {
  const now = Date.parse('2026-11-22T11:00:00.000Z');
  const base = { ...sources(), lastFetchAt: '2026-11-22T10:30:00.000Z' };
  const sample = (at: string) => ({ ...base, trainLog: `${at} [train-manager] tick secret`, landingSubLog: `${at} landing secret` });
  const boundary = opThirtyMinuteSnapshot(sample('2026-11-22T10:30:00.000Z'), 3, now);
  expect(boundary).toMatchObject({ fetchStale: false, complete: true, trainTickObserved: true, landingSubObserved: true,
    trainTick: { observed: true, lastSeenAt: '2026-11-22T10:30:00.000Z', ageSec: 1800 },
    landingSub: { observed: true, lastSeenAt: '2026-11-22T10:30:00.000Z', ageSec: 1800 } });
  const stale = opThirtyMinuteSnapshot(sample('2026-11-22T10:29:59.999Z'), 3, now);
  expect(stale).toMatchObject({ complete: false, trainTickObserved: false, landingSubObserved: false,
    trainTick: { observed: false, lastSeenAt: '2026-11-22T10:29:59.999Z', ageSec: 1800.001, reason: 'stale' },
    landingSub: { observed: false, reason: 'stale' } });
  const absent = opThirtyMinuteSnapshot({ ...base, trainLog: '[train-manager] tick', landingSubLog: 'landing' }, 3, now);
  expect(absent).toMatchObject({ complete: false, trainTick: { observed: false, lastSeenAt: null, ageSec: null, reason: 'no-timestamped-observation' }, landingSub: { observed: false } });
  const future = opThirtyMinuteSnapshot(sample('2026-11-22T11:00:01.000Z'), 3, now);
  expect(future.trainTick).toMatchObject({ observed: false, lastSeenAt: null });
  const newest = opThirtyMinuteSnapshot({ ...base, trainLog: '2026-11-22T10:59:00.000Z [train-manager] tick\n2026-11-22T09:00:00.000Z [train-manager] tick', landingSubLog: '2026-11-22T10:59:00.000Z landing' }, 3, now);
  expect(newest.trainTick).toMatchObject({ observed: true, ageSec: 60 });
  expect(opThirtyMinuteSnapshot({ ...sample('2026-11-22T10:59:00.000Z'), lastFetchAt: '2026-11-22T10:29:59.999Z' }, 3, now)).toMatchObject({ fetchStale: true, complete: false });
});

test('yearless local timestamps resolve across the new year and invalid dates do not count', () => {
  const nowDate = new Date(2027, 0, 1, 0, 5, 0);
  const base = { ...sources(), lastFetchAt: nowDate.toISOString(), trainLog: '12-31 23:55:00 [train-manager] tick', landingSubLog: '12-31 23:55:00 landing' };
  expect(opThirtyMinuteSnapshot(base, 3, nowDate.getTime())).toMatchObject({ complete: true, trainTick: { observed: true, ageSec: 600 } });
  expect(opThirtyMinuteSnapshot({ ...base, trainLog: '02-30 23:55:00 [train-manager] tick' }, 3, nowDate.getTime()).trainTick.observed).toBe(false);
});

test('fetch metadata conservatively makes unknown or old timestamps incomplete', () => {
  expect(opThirtyMinuteSnapshot({ ...sources(), lastFetchAt: null }, 3)).toMatchObject({ lastFetchAt: null, fetchStale: true, complete: false });
  expect(opThirtyMinuteSnapshot({ ...sources(), lastFetchAt: new Date(Date.now() - 60_000).toISOString() }, 3).fetchStale).toBe(false);
  expect(opThirtyMinuteSnapshot({ ...sources(), lastFetchAt: new Date(Date.now() - 31 * 60_000).toISOString() }, 3).fetchStale).toBe(true);
});


test('local main fetch evidence is ref-specific, bounded and conservative', () => {
  root = mkdtempSync(join(tmpdir(), 'op-fetch-evidence-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('commit', '--allow-empty', '-qm', 'first');
  const first = git('rev-parse', 'HEAD');
  expect(localMainFetchAt(root)).toBeNull();
  git('update-ref', '--create-reflog', '-m', 'fetch origin other: storing head', 'refs/remotes/origin/main', first);
  writeFileSync(join(root, '.git', 'FETCH_HEAD'), `${first}\t\tbranch 'other' of origin\n`);
  expect(localMainFetchAt(root)).toBeNull();
  git('commit', '--allow-empty', '-qm', 'second');
  const second = git('rev-parse', 'HEAD');
  git('update-ref', '-m', 'fetch origin main: fast-forward', 'refs/remotes/origin/main', second);
  const fresh = localMainFetchAt(root);
  expect(fresh).not.toBeNull();
  expect(opThirtyMinuteSnapshot({ ...sources(), lastFetchAt: fresh }, 3)).toMatchObject({ fetchStale: false, complete: true });
  const log = join(root, '.git', 'logs', 'refs', 'remotes', 'origin', 'main');
  const currentLog = readFileSync(log, 'utf8');
  const seconds = Math.floor(Date.now() / 1000);
  const retime = (time: number) => writeFileSync(log, currentLog.replace(/ (\d+) ([+-]\d{4})\tfetch origin main: fast-forward/u, ` ${time} $2\tfetch origin main: fast-forward`));
  retime(seconds - 1900);
  expect(opThirtyMinuteSnapshot({ ...sources(), lastFetchAt: localMainFetchAt(root) }, 3)).toMatchObject({ fetchStale: true, complete: false });
  retime(seconds + 100);
  expect(localMainFetchAt(root)).toBeNull();
  expect(opThirtyMinuteSnapshot({ ...sources(), lastFetchAt: localMainFetchAt(root) }, 3)).toMatchObject({ fetchStale: true, complete: false });
  writeFileSync(log, currentLog);
  git('update-ref', '-m', 'fetch origin other: forced-update', 'refs/remotes/origin/main', first);
  expect(localMainFetchAt(root)).toBeNull();
});

// First-column samples from the real queue, before the later time-only entry.
test('real nonnumeric queue first columns and invalid PRs', () => {
  const firstColumns = [
  "2026-11-19T19:55",
  "38421 MAKE-CODE-UNIT-THIN",
  "38414 W0 0d-1a 러너 깊이5·HITL N",
  "38422 W0 0d-1b 러너 USD·launch-key",
  "38560 B2",
  "38562 B4a",
  "38589 C3a",
  "38580 C3b",
  "38564 A1",
  "38578 A2",
  "38581 ACK-SLA",
  "38591 C2-FU",
  "38626 [턴 근본 C3-b] 우편 어댑터 배선 · 1순위(C1·C2·C3 on 관문)",
  "38665 PR-LAND-ISOLATION-GATE 변경 파일만(착지 속도)",
  "38638 [CTL PR-1] seat-stop 상태기",
  "38658 [CTL] 배선(CC-2)",
  "38662 [CTL] 원장 경로(CX-12)",
  "2026-11-19T01:03:54Z",
  "#38994"
];
  for (const [i, first] of firstColumns.entries()) {
    const reviewQueue = `pr\tengine\tclaimedBy\tstatus\n${first}\tx\t\tqueued\n`;
    expect(opThirtyMinuteSnapshot({ ...sources(), reviewQueue }, 3)).toMatchObject(
      i === 0 || i === 17
        ? { legacyQueueRows: 1, reviewUnclaimed: 0, malformedQueueRows: 0, complete: true }
        : { legacyQueueRows: 0, reviewUnclaimed: 1, malformedQueueRows: 0, complete: true });
  }
  for (const first of ['42x', '', 'legacy', '2026-xx-19T19:55']) {
    for (const claimed of ['', 'JUD']) {
      const reviewQueue = `pr\tengine\tclaimedBy\tstatus\n${first}\tx\t${claimed}\tqueued\n`;
      expect(opThirtyMinuteSnapshot({ ...sources(), reviewQueue }, 3))
        .toMatchObject({ malformedQueueRows: 1, malformedUnclaimedQueueRows: claimed ? 0 : 1, legacyQueueRows: 0,
          reviewUnclaimed: claimed ? 0 : null, complete: Boolean(claimed) });
    }
  }
  const timeOnly = 'pr\tengine\tclaimedBy\tstatus\n21:45\tx\t\tqueued\n';
  expect(opThirtyMinuteSnapshot({ ...sources(), reviewQueue: timeOnly }, 3))
    .toMatchObject({ legacyQueueRows: 1, malformedQueueRows: 0, reviewUnclaimed: 0, complete: true });
});


test('OP local checklist read never creates or imports and leaves every ledger table unchanged', () => {
  root = mkdtempSync(join(tmpdir(), 'op-check-ledger-'));
  const version = '0.3.33';
  const path = join(root, 'release', 'features.sqlite');
  expect(() => readOpChecklistGreen(version, root)).toThrow();
  expect(existsSync(join(root, 'release'))).toBe(false);

  // Use the real schema initializer, then construct an imported version.
  featureStore.list(version, '', '0.3.33-dev.0', root);
  const db = new Database(path, { strict: true });
  db.query('INSERT INTO imported_versions (version, json_hash) VALUES (?, ?)').run(version, null);
  db.query('INSERT INTO features (id, title, created_at) VALUES (?, ?, ?)').run('fixture', 'Fixture', '2026-01-01');
  db.query('INSERT INTO assignments (feature_id, version, status, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)').run('fixture', version, 'green', '2026-01-01', 'fixture');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  // A connection alone need not open WAL; force a read transaction before testing.
  db.exec('BEGIN');
  db.query('SELECT COUNT(*) FROM assignments').get();
  expect(existsSync(`${path}-wal`)).toBe(true);
  expect(existsSync(`${path}-shm`)).toBe(true);
  const snapshot = () => {
    const reader = new Database(path, { readonly: true });
    try {
      const names = reader.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
      return Object.fromEntries(names.map(({ name }) => [name, reader.query(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`).get()]));
    } finally { reader.close(); }
  };
  const before = snapshot();
  const mtime = statSync(path).mtimeMs;
  const files = readdirSync(join(root, 'release')).sort();
  const repo = join(root, 'repo.git');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '0.3.33-dev.0' }));
  git('add', 'package.json');
  git('commit', '-qm', 'fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const op = join(root, 'seat-state', 'OP');
  mkdirSync(join(op, 'tools'), { recursive: true });
  writeFileSync(join(op, 'train-manager.log'), '');
  writeFileSync(join(op, 'REVIEW-QUEUE.tsv'), 'pr\tengine\tclaimedBy\tstatus\n');
  writeFileSync(join(op, 'tools', 'land-pulse-loop.log'), '');
  expect(JSON.parse(loadLocalOpThirtyMinuteSources(root, root).checklist)).toMatchObject({ green: 1, evidence: expect.stringContaining('snapshot 읽기') });
  expect(snapshot()).toEqual(before);
  expect(statSync(path).mtimeMs).toBe(mtime);
  expect(readdirSync(join(root, 'release')).sort()).toEqual(files);

  const dir = join(root, 'release', version);
  mkdirSync(dir);
  const legacy = join(dir, 'checklist.json');
  const data = JSON.stringify({ version, items: [], history: [] });
  writeFileSync(legacy, data);
  const legacyMtime = statSync(legacy).mtimeMs;
  expect(opThirtyMinuteSnapshot(loadLocalOpThirtyMinuteSources(root, root), 0)).toMatchObject({ green: null, greenDelta: null, complete: false });
  expect(readFileSync(legacy, 'utf8')).toBe(data);
  expect(statSync(legacy).mtimeMs).toBe(legacyMtime);
  expect(snapshot()).toEqual(before);
  expect(statSync(path).mtimeMs).toBe(mtime);
  db.exec('COMMIT');
  db.query('UPDATE imported_versions SET json_hash = ? WHERE version = ?').run(createHash('sha256').update(data).digest('hex'), version);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const synced = snapshot();
  const syncedMtime = statSync(path).mtimeMs;
  expect(JSON.parse(readOpChecklistGreen(version, root))).toMatchObject({ green: 1, evidence: expect.stringContaining('snapshot 읽기') });
  expect(snapshot()).toEqual(synced);
  expect(statSync(path).mtimeMs).toBe(syncedMtime);
  expect(readFileSync(legacy, 'utf8')).toBe(data);
  db.close();
  const closedFiles = readdirSync(join(root, 'release')).sort();
  expect(JSON.parse(readOpChecklistGreen(version, root))).toMatchObject({ green: 1 });
  expect(readdirSync(join(root, 'release')).sort()).toEqual(closedFiles);
});

test('empty and legacy-only ledgers remain unknown without writes', () => {
  root = mkdtempSync(join(tmpdir(), 'op-check-empty-'));
  const version = '0.3.33';
  const dir = join(root, 'release', version);
  mkdirSync(dir, { recursive: true });
  const legacy = join(dir, 'checklist.json');
  const data = JSON.stringify({ version, items: [], history: [] });
  writeFileSync(legacy, data);
  expect(() => readOpChecklistGreen(version, root)).toThrow();
  expect(readdirSync(join(root, 'release')).sort()).toEqual([version]);
  expect(readFileSync(legacy, 'utf8')).toBe(data);
  featureStore.list(version, '', '0.3.33-dev.0', root);
  const before = readdirSync(join(root, 'release')).sort();
  expect(() => readOpChecklistGreen('0.3.34', root)).toThrow();
  expect(readdirSync(join(root, 'release')).sort()).toEqual(before);
  expect(readFileSync(legacy, 'utf8')).toBe(data);
});


test('immutable URI escapes path and ignores live WAL without touching database or sidecars', () => {
  root = mkdtempSync(join(tmpdir(), 'op ?#% 한글-'));
  const version = '0.3.33';
  featureStore.list(version, '', '0.3.33-dev.0', root);
  const path = join(root, 'release', 'features.sqlite');
  const db = new Database(path, { strict: true });
  db.query('INSERT INTO imported_versions (version, json_hash) VALUES (?, ?)').run(version, null);
  db.query('INSERT INTO features (id, title, created_at) VALUES (?, ?, ?)').run('x', 'x', '2026-01-01');
  db.query('INSERT INTO assignments (feature_id, version, status, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)').run('x', version, 'green', '2026-01-01', 'x');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.query("UPDATE assignments SET status = 'red' WHERE feature_id = 'x'").run();
  const paths = [path, `${path}-wal`, `${path}-shm`];
  const snapshot = () => paths.map(p => ({ bytes: readFileSync(p).toString('base64'), mtime: statSync(p).mtimeMs }));
  const before = snapshot();
  expect(JSON.parse(readOpChecklistGreen(version, root))).toMatchObject({ green: 1, evidence: expect.stringContaining('snapshot 읽기') });
  expect(snapshot()).toEqual(before);
  db.close();
  const beforeFiles = readdirSync(join(root, 'release')).sort();
  expect(JSON.parse(readOpChecklistGreen(version, root))).toMatchObject({ green: 0 });
  expect(readdirSync(join(root, 'release')).sort()).toEqual(beforeFiles);
});

test('missing or incompatible checklist is unknown and cannot complete', () => {
  for (const checklist of ['{"green":null,"evidence":"SQLite immutable snapshot 읽기 실패"}', '{"green":null}']) {
    expect(opThirtyMinuteSnapshot({ ...sources(), checklist }, 0)).toMatchObject({ green: null, greenDelta: null, complete: false });
  }
  root = mkdtempSync(join(tmpdir(), 'op-bad-schema-'));
  mkdirSync(join(root, 'release'));
  const db = new Database(join(root, 'release', 'features.sqlite'));
  db.exec('CREATE TABLE unrelated (x)'); db.close();
  expect(() => readOpChecklistGreen('0.3.33', root)).toThrow();
  expect(readdirSync(join(root, 'release'))).toEqual(['features.sqlite']);
});
