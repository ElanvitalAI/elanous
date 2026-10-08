import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FENCE_FAILURE_STREAK, fenceAlertRole, fenceOutcomeDir, readFenceOutcome, recordFenceOutcome } from './fence-outcomes.js';
import { hqFenceAlert } from './fence-wrapper.js';
import { hqFenceRun } from './hq.js';
import { fileLeaseStore, serializeLease } from './lease.js';

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function root() { const dir = mkdtempSync(join(tmpdir(), 'hq-fence-outcomes-')); roots.push(dir); return dir; }
const journal = (dir: string) => join(dir, 'seat-requests', 'requests.jsonl');
const rows = (dir: string) => existsSync(journal(dir))
  ? readFileSync(journal(dir), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { key: string; seat: string; text: string })
  : [];
const failed = (role: string, rc = 1) => `hq-fence: fence failed (rc=${rc}, role=${role})`;

test('many ended hq-fence runs with lone failures queue zero loopcheck:hq-fence requests', () => {
  const dir = root();
  const outcomeDir = join(dir, 'hq', 'fence-outcomes');
  const now = new Date('2026-10-07T10:00:00Z');
  // 40 cron executions across three roles: every failure is followed by a success (the 10-06~07 pattern).
  let alerts = 0;
  for (let i = 0; i < 40; i++) {
    const role = ['cron', 'seat-loop', 'release-run'][i % 3]!;
    const rc = Math.floor(i / 3) % 2 === 0 ? 1 : 0;
    recordFenceOutcome(outcomeDir, role, rc, now);
    if (rc !== 0) alerts += hqFenceAlert(failed(role), { root: dir, outcomeDir, now });
  }
  expect(alerts).toBe(0);
  expect(rows(dir).filter(row => row.key.startsWith('loopcheck:hq-fence:'))).toEqual([]);
});

test('a role failing in consecutive runs queues at most one request per role per day', () => {
  const dir = root();
  const outcomeDir = join(dir, 'hq', 'fence-outcomes');
  const day = new Date('2026-10-07T10:37:00Z');
  for (let i = 0; i < 6; i++) {
    recordFenceOutcome(outcomeDir, 'seat-loop', 1, day);
    hqFenceAlert(failed('seat-loop'), { root: dir, outcomeDir, now: day });
  }
  expect(readFenceOutcome(outcomeDir, 'seat-loop')?.consecutiveFailures).toBe(6);
  expect(rows(dir)).toHaveLength(1);
  expect(rows(dir)[0]).toMatchObject({ key: 'loopcheck:hq-fence:seat-loop:2026-10-07:failing', seat: 'TC' });
  expect(rows(dir)[0]!.text).toContain(`${FENCE_FAILURE_STREAK} consecutive runs`);
  // A second failing role gets its own single line; the next day may raise once more.
  for (let i = 0; i < 3; i++) { recordFenceOutcome(outcomeDir, 'cron', 1, day); hqFenceAlert(failed('cron'), { root: dir, outcomeDir, now: day }); }
  const next = new Date('2026-10-08T01:00:00Z');
  recordFenceOutcome(outcomeDir, 'seat-loop', 1, next);
  expect(hqFenceAlert(failed('seat-loop'), { root: dir, outcomeDir, now: next })).toBe(1);
  expect(rows(dir).map(row => row.key)).toEqual([
    'loopcheck:hq-fence:seat-loop:2026-10-07:failing',
    'loopcheck:hq-fence:cron:2026-10-07:failing',
    'loopcheck:hq-fence:seat-loop:2026-10-08:failing',
  ]);
  // A success resets the streak, so the next lone failure is quiet again.
  recordFenceOutcome(outcomeDir, 'release-run', 0, next);
  recordFenceOutcome(outcomeDir, 'release-run', 1, next);
  expect(hqFenceAlert(failed('release-run'), { root: dir, outcomeDir, now: next })).toBe(0);
});

test('wrapper failures without a run record still alert, once per day, never keyed by pid', () => {
  const dir = root();
  const outcomeDir = join(dir, 'hq', 'fence-outcomes');
  const now = new Date('2026-10-07T10:00:00Z');
  expect(hqFenceAlert('hq-fence: installed entrypoint missing: /x', { root: dir, outcomeDir, now })).toBe(1);
  expect(hqFenceAlert('hq-fence: role required', { root: dir, outcomeDir, now })).toBe(0);
  // Unknown streak (role never recorded — e.g. the CLI rejected the role) is not read as «first failure».
  expect(hqFenceAlert(failed('not-a-role'), { root: dir, outcomeDir, now })).toBe(1);
  expect(rows(dir).map(row => row.key)).toEqual([
    'loopcheck:hq-fence:wrapper:2026-10-07:failing',
    'loopcheck:hq-fence:not-a-role:2026-10-07:failing',
  ]);
  expect(fenceAlertRole('hq-fence: role required')).toBeNull();
  expect(fenceOutcomeDir('/c/hq/local.json')).toBe('/c/hq/fence-outcomes');
});

test('hqFenceRun records the wrapped rc per role; a not-holder skip records nothing', () => {
  const dir = root();
  const store = fileLeaseStore(join(dir, 'arbiter', 'lease.json'), () => 100);
  store.cas(null, serializeLease({ holder: 'HostA', generation: 3, acquiredAt: 100, renewedAt: 100, ttlSeconds: 1500 }));
  writeFileSync(join(dir, 'a.host'), 'HostA\n');
  writeFileSync(join(dir, 'b.host'), 'HostB\n');
  const deps = (host: string) => ({ config: { arbiter: 'local' }, store, hostPath: join(dir, `${host}.host`), localPath: join(dir, host, 'local.json'),
    seenPath: join(dir, `${host}.seen`), now: () => 100, log: () => {} });
  const outcomeDir = fenceOutcomeDir(join(dir, 'a', 'local.json'));
  expect(hqFenceRun('seat-loop', ['/bin/sh', '-c', 'exit 1'], deps('a'))).toBe(1);
  expect(hqFenceRun('seat-loop', ['/bin/sh', '-c', 'exit 1'], deps('a'))).toBe(1);
  expect(readFenceOutcome(outcomeDir, 'seat-loop')).toMatchObject({ consecutiveFailures: 2, lastRc: 1 });
  expect(hqFenceRun('seat-loop', ['/bin/sh', '-c', 'exit 0'], deps('a'))).toBe(0);
  expect(readFenceOutcome(outcomeDir, 'seat-loop')).toMatchObject({ consecutiveFailures: 0, lastRc: 0 });
  expect(hqFenceRun('cron', ['/bin/sh', '-c', 'exit 1'], deps('b'))).toBe(0);
  expect(existsSync(join(dir, 'b', 'fence-outcomes'))).toBe(false);
});

test('overlapping runs of one role serialize the streak update (review must-fix)', async () => {
  const dir = root();
  const outcomeDir = join(dir, 'hq', 'fence-outcomes');
  mkdirSync(outcomeDir, { recursive: true });
  const lock = new Database(`${join(outcomeDir, 'seat-loop.json')}.lock.sqlite`);
  lock.exec('BEGIN EXCLUSIVE');
  const worker = `import { recordFenceOutcome } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, 'fence-outcomes.ts')).href)};
    recordFenceOutcome(process.argv[1], 'seat-loop', 1);`;
  const children = Array.from({ length: 2 }, () => Bun.spawn([process.execPath, '-e', worker, outcomeDir], { stdout: 'pipe', stderr: 'pipe' }));
  try { await Bun.sleep(300); expect(existsSync(join(outcomeDir, 'seat-loop.json'))).toBe(false); }
  finally { lock.exec('COMMIT'); lock.close(); }
  expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0]);
  expect(readFenceOutcome(outcomeDir, 'seat-loop')).toMatchObject({ consecutiveFailures: 2, lastRc: 1 });
});

test('real CLI alert path: a lone failure stays quiet, a consecutive one lands one per-role row', () => {
  const dir = root();
  const configDir = join(dir, 'config');
  const outcomeDir = join(configDir, 'hq', 'fence-outcomes');
  const entry = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
  const env = { ...process.env, HOME: dir, ELANOUS_STATE_DIR: configDir };
  const alert = () => spawnSync(process.execPath, [entry, '--test', '--config-dir', configDir, 'hq', 'fence-wrapper', 'alert', failed('seat-loop')],
    { env, encoding: 'utf8', timeout: 120_000 });
  recordFenceOutcome(outcomeDir, 'seat-loop', 1);
  const quiet = alert();
  expect(quiet.status, quiet.stderr).toBe(0);
  expect(rows(configDir)).toEqual([]);
  recordFenceOutcome(outcomeDir, 'seat-loop', 1);
  for (let i = 0; i < 2; i++) { const loud = alert(); expect(loud.status, loud.stderr).toBe(0); }
  expect(rows(configDir).map(row => row.key)).toEqual([`loopcheck:hq-fence:seat-loop:${new Date().toISOString().slice(0, 10)}:failing`]);
}, 300_000);
