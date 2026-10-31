import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addItem, listChecklist, setItem } from '../../src/release-loop/checklist.js';
import { enableLandingFreeze } from '../../src/release-loop/landing-freeze.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { setSchedule } from '../../src/release-loop/release-schedule.js';
import { releaseReadiness } from './release-readiness.js';
import { cutChecklistGate } from '../../src/release-loop/checklist.js';
import { cadencePublishAt, formatCountdown, formatPreflight, formatReleaseCountdown, isPostPublishCell, releaseCountdown as scheduleReleaseCountdown, releaseGateMeasure, releasePreflight, runReleaseCountdown, type PreflightDeps } from './preflight.js';

async function isolated(fn: (root: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'release-preflight-'));
  const root = join(home, '.elanous');
  mkdirSync(root);
  setElanousConfigDir(root);
  try { await fn(root); } finally { resetElanousConfigDir(); rmSync(home, { recursive: true, force: true }); }
}

/** The real release-loop path shape (checklist-gate «and» gate) — copied from a finished 0.2.17 run. */
const RELEASE_PATH = ['version-release', 'cutoff', 'checklist-gate', 'gate', 'mac-smoke', 'export-check', 'pwa', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues', 'notes-check', 'auto-approve', 'publish', 'npm-publish', 'done'];

/** A finished release-loop run whose `gate` node took `gateSeconds`: contexts/<n>.json is written when node n starts (mtime). */
function fakeRun(runs: string, runId: string, version: string, startedAt: string, gateSeconds: number): void {
  mkdirSync(join(runs, `${runId}.json.contexts`), { recursive: true });
  writeFileSync(join(runs, `${runId}.json`), JSON.stringify({ graphId: 'release-loop', runId, status: 'done', startedAt, path: RELEASE_PATH, input: { version } }));
  const t0 = Date.parse(startedAt);
  const gate = RELEASE_PATH.indexOf('gate');
  RELEASE_PATH.forEach((node, i) => {
    // 1 s per node, except the gate node which takes gateSeconds (checklist-gate stays short, as in the real run).
    const ms = t0 + i * 1000 + (i > gate ? gateSeconds * 1000 - 1000 : 0);
    const p = join(runs, `${runId}.json.contexts`, `${i + 1}.json`);
    writeFileSync(p, JSON.stringify({ nodeId: node }));
    utimesSync(p, new Date(ms), new Date(ms));
  });
}

const NOW = new Date('2026-10-06T20:30:00.000Z');

test('release countdown lays out T−120/T−60/T−30/T0 and never claims that a step ran', () => {
  const cutAt = '2026-10-07T06:00:00.000Z';
  const steps = scheduleReleaseCountdown(cutAt);
  expect(steps.map(({ id, offsetMinutes, at, observation }) => ({ id, offsetMinutes, at, observation }))).toEqual([
    { id: 'notes-and-readiness', offsetMinutes: -120, at: '2026-10-07T04:00:00.000Z', observation: 'not-observed-by-countdown' },
    { id: 'pinned-main-preflight', offsetMinutes: -60, at: '2026-10-07T05:00:00.000Z', observation: 'not-observed-by-countdown' },
    { id: 'gate-window', offsetMinutes: -30, at: '2026-10-07T05:30:00.000Z', observation: 'not-observed-by-countdown' },
    { id: 'cut', offsetMinutes: 0, at: cutAt, observation: 'not-observed-by-countdown' },
  ]);
  const lines = formatReleaseCountdown(cutAt, new Date('2026-10-07T04:00:00.000Z'));
  expect(lines).toHaveLength(5);
  expect(lines[1]).toContain('시각 도달 · 완료 미관측');
  expect(lines[2]).toContain('예정');
  expect(lines[0]).toContain('단계 완료를 관측하거나 실행하지 않는다');
});

function deps(root: string, extra: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    now: NOW,
    runInput: async () => ({ input: { previousVersion: '0.2.17', gatePodPool: 'pool-test' } }),
    schedule: () => ({ version: '0.2.18', cutAt: '2026-10-06T21:00:00.000Z', landBy: '2026-10-06T20:30:00.000Z', updatedAt: NOW.toISOString(), updatedBy: 'test' }),
    graphRunsRoot: join(root, 'graph-runs', 'release-loop'),
    exportCheck: async () => ({ mainSha: 'a'.repeat(40), files: 123, leaks: 0, codeLiterals: 0 }),
    releaseNotesCheck: async () => 1,
    releaseRunDeps: { freezeRoot: root },
    publishAt: '2026-10-06T23:30:00.000Z',
    ...extra,
  };
}

test('T−120 countdown readiness summarizes pinned release notes, public export and checklist without claiming execution', () => isolated(async (root) => {
  const result = await releasePreflight('0.2.18', deps(root, { countdown: true, releaseNotesCheck: async () => 2 }));
  expect(result.countdownReadiness).toEqual({
    status: 'green',
    notes: { status: 'green', addedLines: 2 },
    export: { status: 'green', leaks: 0 },
    checklist: { status: 'green' },
  });
  const lines = formatReleaseCountdown(result.schedule!.cutAt, new Date('2026-10-06T20:00:00.000Z'), result.countdownReadiness);
  expect(lines[1]).toContain('read-only 판정 green');
  expect(lines[1]).toContain('notes +2');
  expect(lines[0]).toContain('단계 완료를 관측하거나 실행하지 않는다');
}));

test('T−120 readiness is red on missing release notes or public export leaks', () => isolated(async (root) => {
  const notesMissing = await releasePreflight('0.2.18', deps(root, { countdown: true, releaseNotesCheck: async () => 0 }));
  expect(notesMissing.countdownReadiness).toMatchObject({ status: 'red', notes: { status: 'red', addedLines: 0 } });
  const leaks = await releasePreflight('0.2.18', deps(root, {
    countdown: true,
    releaseNotesCheck: async () => 1,
    exportCheck: async () => ({ mainSha: 'b'.repeat(40), files: 123, leaks: 2, codeLiterals: 0 }),
  }));
  expect(leaks.countdownReadiness).toMatchObject({ status: 'red', export: { status: 'red', leaks: 2 } });
}));

test('ordinary preflight does not run or block on the T−120 release notes check', () => isolated(async (root) => {
  const result = await releasePreflight('0.2.18', deps(root, {
    releaseNotesCheck: async () => { throw new Error('countdown-only check should not run'); },
  }));
  expect(result.findings.some((finding) => finding.check === 'release-notes')).toBe(false);
  expect(result.countdownReadiness.status).toBe('unmeasured');
}));

test('F9 export preflight records one main head, separates code literals, and names the cut-minus-60 manual check time', () => isolated(async (root) => {
  const result = await releasePreflight('0.2.18', deps(root, { now: new Date('2026-10-06T20:00:00.000Z'), exportCheck: async () => ({ mainSha: 'a'.repeat(40), files: 123, leaks: 0, codeLiterals: 2 }) }));
  expect(result.exportCheck).toEqual({ mainSha: 'a'.repeat(40), files: 123, leaks: 0, codeLiterals: 2 });
  expect(result.schedule?.exportCheckAt).toBe('2026-10-06T20:00:00.000Z');
  expect(result.findings.find((f) => f.check === 'export' && f.level === 'ok')?.message).toContain('aaaaaaaaaaaa');
  expect(result.findings.find((f) => f.check === 'export' && f.level === 'warn')?.message).toContain('코드 리터럴 표지 2건');
  expect(result.findings.find((f) => f.message.includes('컷 − 60분'))?.message).toContain('자동 예약 없음');
}));

test('F9 fails closed when the pinned main export scan cannot be measured', () => isolated(async (root) => {
  const result = await releasePreflight('0.2.18', deps(root, { exportCheck: async () => { throw new Error('origin/main unavailable'); } }));
  expect(result.findings.find((f) => f.check === 'export')).toMatchObject({ level: 'block' });
  expect(result.findings.find((f) => f.check === 'export')?.message).toContain('origin/main unavailable');
}));

test('default path: the stored schedule and cutChecklistGate at the cut decide ⛔ (no injected schedule)', () => isolated(async (root) => {
  setSchedule('0.2.18', { cutAt: '2026-10-07T06:00:00+09:00', landBy: '2026-10-07T05:30:00+09:00' }, 'test');
  addItem('0.2.18', { id: 'P0CELL', title: 'p0 yellow', owner: 'TC', priority: 'P0' });
  addItem('0.2.18', { id: 'DONE1', title: 'done', owner: 'TC' });
  setItem('0.2.18', 'DONE1', { status: 'green' }, 'TC');
  const cut = new Date('2026-10-06T21:00:00.000Z');
  expect(cutChecklistGate('0.2.18', '2026-10-06T20:30:00.000Z', cut).blocked).toContain('P0CELL');
  const { schedule: _schedule, ...rest } = deps(root);
  const result = await releasePreflight('0.2.18', rest);
  expect(result.schedule?.cutAt).toBe(cut.toISOString());
  // «P0 노랑» is a reason only the cut judgement produces (the raw checklistGate calls it undecided).
  const finding = result.findings.find((f) => f.id === 'P0CELL')!;
  expect(finding.level).toBe('block');
  expect(finding.message).toContain('P0 노랑');
  expect(formatPreflight(result).some((l) => l.startsWith('⛔ P0CELL — P0 노랑'))).toBe(true);
}));

test('a blocking (P0) POSTPUB-VERIFY cell left in the release is ⛔ with a move suggestion, and nothing is written', () => isolated(async (root) => {
  addItem('0.2.18', { id: 'A1', title: 'landed feature', owner: 'TC' });
  setItem('0.2.18', 'A1', { status: 'green' }, 'TC');
  addItem('0.2.18', { id: 'POSTPUB-VERIFY', title: '발행 뒤 1시간 실측', owner: 'OP', priority: 'P0' });
  const before = JSON.stringify(listChecklist('0.2.18'));
  const result = await releasePreflight('0.2.18', deps(root));
  expect(result.verdict).toBe('block');
  const finding = result.findings.find((f) => f.id === 'POSTPUB-VERIFY')!;
  expect(finding).toMatchObject({ level: 'block', check: 'postpub' });
  expect(finding.suggestion).toContain('release checklist move POSTPUB-VERIFY --from 0.2.18 --to 0.2.19');
  const lines = formatPreflight(result);
  expect(lines.some((l) => l.startsWith('⛔ POSTPUB-VERIFY'))).toBe(true);
  expect(lines.at(-1)).toStartWith('⛔ 판정: 막힘');
  expect(JSON.stringify(listChecklist('0.2.18'))).toBe(before);
  expect(listChecklist('0.2.19').items).toHaveLength(0);
}));

test('post-publish cells that do not block (move · green · done) still warn with the move command', () => isolated(async (root) => {
  addItem('0.2.18', { id: 'POSTPUB-KIND', title: 'kind', owner: 'TC' });
  setItem('0.2.18', 'POSTPUB-KIND', { disposition: 'move' }, 'TC');
  addItem('0.2.18', { id: 'POSTPUB-GREEN', title: 'g', owner: 'TC' });
  setItem('0.2.18', 'POSTPUB-GREEN', { status: 'green' }, 'TC');
  addItem('0.2.18', { id: 'POSTPUB-DONE', title: 'd', owner: 'TC' });
  setItem('0.2.18', 'POSTPUB-DONE', { status: 'done' }, 'TC');
  const result = await releasePreflight('0.2.18', deps(root));
  expect(result.blockers).toBe(0);
  for (const id of ['POSTPUB-KIND', 'POSTPUB-GREEN', 'POSTPUB-DONE']) {
    const finding = result.findings.find((f) => f.id === id)!;
    expect(finding).toMatchObject({ level: 'warn', check: 'postpub' });
    expect(finding.suggestion).toContain(`release checklist move ${id} --from 0.2.18 --to 0.2.19`);
  }
}));

test('an all-green checklist with measured headroom is ok', () => isolated(async (root) => {
  for (const id of ['A1', 'A2']) { addItem('0.2.18', { id, title: `cell ${id}`, owner: 'TC' }); setItem('0.2.18', id, { status: 'green' }, 'TC'); }
  const runs = join(root, 'graph-runs', 'release-loop');
  fakeRun(runs, 'r1', '0.2.17', '2026-10-06T09:00:00.000Z', 3600);
  // Measured from the `gate` node (start → next node start), not from `checklist-gate`.
  expect(releaseGateMeasure({ version: '0.2.17' }, runs)).toMatchObject({ version: '0.2.17', gateSeconds: 3600, toPublishSeconds: 3600 + 13 });
  const result = await releasePreflight('0.2.18', deps(root));
  expect(result.findings.filter((f) => f.level !== 'ok')).toEqual([]);
  expect(result.verdict).toBe('ok');
  expect(formatPreflight(result).at(-1)).toBe('✅ 판정: 통과');
}));

test('a landing freeze is reported as a blocker', () => isolated(async (root) => {
  enableLandingFreeze({ reason: 'emergency', by: 'OP' }, root, new Date());
  const result = await releasePreflight('0.2.18', deps(root, { now: new Date() }));
  expect(result.findings.find((f) => f.check === 'freeze')).toMatchObject({ level: 'block' });
}));

test('no measured gate prints «직전 판 실측 없음 … 게이트 실측 없음»', () => isolated(async (root) => {
  const result = await releasePreflight('0.2.18', deps(root, { publishAt: undefined }));
  expect(result.schedule?.publishAt).toBe('2026-10-06T22:00:00.000Z');
  expect(result.findings.some((f) => f.level === 'warn' && f.message.startsWith('직전 판(0.2.17) 실측 없음') && f.message.includes('게이트 실측 없음'))).toBe(true);
}));

test('only the immediately previous release counts as «직전 실측» — never a later or older one', () => isolated(async (root) => {
  const runs = join(root, 'graph-runs', 'release-loop');
  fakeRun(runs, 'later', '0.2.19', '2026-10-06T19:00:00.000Z', 60);       // newer run, later version
  fakeRun(runs, 'older', '0.2.15', '2026-10-06T18:00:00.000Z', 7200);     // older version
  fakeRun(runs, 'prev', '0.2.17', '2026-10-05T09:00:00.000Z', 600);       // the previous release, oldest run
  fakeRun(runs, 'recent-low', '0.2.14', '2026-10-06T20:00:00.000Z', 1800); // a lower version measured most recently
  const picked = await releasePreflight('0.2.18', deps(root));
  expect(picked.previousVersion).toBe('0.2.17');
  expect(picked.gateMeasure).toMatchObject({ version: '0.2.17', gateSeconds: 600 });
  rmSync(join(runs, 'prev.json'));
  const missing = await releasePreflight('0.2.18', deps(root));
  expect(missing.gateMeasure).toBeNull();
  // The labelled reference is the most recently measured run, not the highest version below.
  expect(missing.fallbackGateMeasure).toMatchObject({ version: '0.2.14', gateSeconds: 1800 });
  const line = missing.findings.find((f) => f.check === 'schedule' && f.level === 'warn')!;
  expect(line.message).toStartWith('직전 판(0.2.17) 실측 없음');
  expect(line.message).toContain('0.2.14 게이트 30분(직전 판 아님)');
}));

test('run input errors surface as blockers', () => isolated(async (root) => {
  const result = await releasePreflight('0.2.18', deps(root, { runInput: async () => { throw new Error('release.loop.gatePodPool is required before graph execution'); } }));
  expect(result.findings.find((f) => f.check === 'run-input')).toMatchObject({ level: 'block' });
}));

test('the stored schedule publish time (schedule set --publish-at) wins over the cadence; --publish-at still wins over it', () => isolated(async (root) => {
  const stored = { version: '0.2.18', cutAt: '2026-10-06T21:00:00.000Z', landBy: '2026-10-06T20:30:00.000Z', publishAt: '2026-10-06T23:00:00.000Z', updatedAt: NOW.toISOString(), updatedBy: 'test' };
  const { publishAt: _publishAt, ...rest } = deps(root, { schedule: () => stored });
  const fromSchedule = await releasePreflight('0.2.18', rest);
  expect(fromSchedule.schedule).toMatchObject({ publishAt: '2026-10-06T23:00:00.000Z', publishAtSource: 'schedule' });
  const fromOption = await releasePreflight('0.2.18', deps(root, { schedule: () => stored }));
  expect(fromOption.schedule).toMatchObject({ publishAt: '2026-10-06T23:30:00.000Z', publishAtSource: 'option' });
}));

test('the default path reads the publish time stored by setSchedule (no injected schedule)', () => isolated(async (root) => {
  setSchedule('0.2.18', { cutAt: '2026-10-07T06:00:00+09:00', landBy: '2026-10-07T05:30:00+09:00', publishAt: '2026-10-07T08:00:00+09:00' }, 'test');
  const { schedule: _schedule, publishAt: _publishAt, ...rest } = deps(root);
  const result = await releasePreflight('0.2.18', rest);
  expect(result.schedule).toMatchObject({ publishAt: '2026-10-06T23:00:00.000Z', publishAtSource: 'schedule' });
  expect(result.findings.some((f) => f.check === 'schedule' && f.message.includes('(판 일정)'))).toBe(true);
}));

test('post-publish detection reads the id or a title that starts with the marker', () => {
  expect(isPostPublishCell({ id: 'POSTPUB-VERIFY', title: 'x' })).toBe(true);
  expect(isPostPublishCell({ id: 'X', title: '«발행 뒤» 실측' })).toBe(true);
  expect(isPostPublishCell({ id: 'X', title: '편집 루프가 08:30 · 판 발행 뒤 · 22:00 슬롯에' })).toBe(false);
  expect(isPostPublishCell({ id: 'POSTPUBLISHER', title: 'x' })).toBe(false);
  expect(cadencePublishAt('2026-10-07T09:45:00.000Z')).toBe('2026-10-07T22:00:00.000Z');
  // A cut exactly on a cadence hour publishes at the «next» one, never at the cut itself.
  expect(cadencePublishAt('2026-10-06T22:00:00.000Z')).toBe('2026-10-07T09:00:00.000Z');
  expect(cadencePublishAt('2026-10-07T09:00:00.000Z')).toBe('2026-10-07T22:00:00.000Z');
  expect(cadencePublishAt('2026-10-06T21:59:59.000Z')).toBe('2026-10-06T22:00:00.000Z');
});

test('real CLI: without release.loop.gatePodPool, preflight surfaces the actual release run --dry-run error and exits 1', async () => {
  const home = mkdtempSync(join(tmpdir(), 'release-preflight-cli-'));
  const root = join(home, '.elanous');
  mkdirSync(join(root, 'release', '0.2.17'), { recursive: true });
  writeFileSync(join(root, 'release', '0.2.17', 'release.json'), JSON.stringify({ version: '0.2.17', publishedAt: '2026-10-06T11:47:18.214Z' }));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ release: { loop: {} } }));
  try {
    const repo = join(import.meta.dir, '../..');
    const env = { ...process.env, HOME: home, ELANOUS_STATE_DIR: root };
    const cli = (...args: string[]) => spawnSync('bun', [join(repo, 'bin/elanous.mjs'), '--config-dir', root, 'release', ...args], { cwd: repo, encoding: 'utf8', env });
    const dry = cli('run', '--version', '0.2.18', '--dry-run', '--json');
    const dryError = (JSON.parse(dry.stdout.trim().split('\n').at(-1)!) as { error: string }).error;
    expect(dryError).toContain('release.loop.gatePodPool is required');
    const run = cli('preflight', '--version', '0.2.18', '--json');
    expect(run.status).toBe(1);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { findings: Array<{ check: string; level: string; message: string }> };
    const finding = result.findings.find((f) => f.check === 'run-input')!;
    expect(finding.level).toBe('block');
    expect(finding.message).toContain(dryError);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 180_000);

test('a non-P0 undecided yellow cell is carried at the cut by every path (node · run entry · releaseReadiness, #24557) → ⚠️ not ⛔', () => isolated(async (root) => {
  setSchedule('0.2.18', { cutAt: '2026-10-07T06:00:00+09:00', landBy: '2026-10-07T05:30:00+09:00' }, 'test');
  addItem('0.2.18', { id: 'UNDECIDED', title: 'plain yellow', owner: 'TC' });
  const cut = new Date('2026-10-06T21:00:00.000Z');
  expect(cutChecklistGate('0.2.18', '2026-10-06T20:30:00.000Z', cut).autoMoved).toContain('UNDECIDED');
  expect(releaseReadiness('0.2.18', { now: () => cut })).toMatchObject({ ready: true });
  const { schedule: _schedule, ...rest } = deps(root);
  const result = await releasePreflight('0.2.18', rest);
  const finding = result.findings.find((f) => f.id === 'UNDECIDED')!;
  expect(finding.level).toBe('warn');
  expect(finding.message).toContain('자동 이월');
  expect(result.blockers).toBe(0);
}));

test('a scheduled-start checklist that refuses more than the cut judgement is still reported ⛔ (injected deps.checklist)', () => isolated(async (root) => {
  setSchedule('0.2.18', { cutAt: '2026-10-07T06:00:00+09:00', landBy: '2026-10-07T05:30:00+09:00' }, 'test');
  addItem('0.2.18', { id: 'UNDECIDED', title: 'plain yellow', owner: 'TC' });
  const { schedule: _schedule, ...rest } = deps(root);
  const result = await releasePreflight('0.2.18', { ...rest, releaseRunDeps: { ...rest.releaseRunDeps, checklist: () => ({ ok: false, red: [], undecided: ['UNDECIDED'], blocked: [] }) } });
  const finding = result.findings.find((f) => f.id === 'UNDECIDED')!;
  expect(finding.level).toBe('block');
  expect(finding.message).toContain('releaseReadiness');
}));

test('real CLI: a valid release.loop config passes the run-input check end to end', () => {
  const home = mkdtempSync(join(tmpdir(), 'release-preflight-cli-ok-'));
  const root = join(home, '.elanous');
  mkdirSync(join(root, 'release', '0.2.17'), { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ release: { loop: { gatePodPool: 'pool-cli-test' } } }));
  writeFileSync(join(root, 'release', '0.2.17', 'release.json'), JSON.stringify({ version: '0.2.17', publishedAt: '2026-10-06T11:47:18.214Z' }));
  try {
    const repo = join(import.meta.dir, '../..');
    const run = spawnSync('bun', [join(repo, 'bin/elanous.mjs'), '--config-dir', root, 'release', 'preflight', '--version', '0.2.18', '--json'], { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: root } });
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { previousVersion: string; findings: Array<{ check: string; level: string; message: string }> };
    const finding = result.findings.find((f) => f.check === 'run-input')!;
    expect(finding.level).toBe('ok');
    expect(finding.message).toContain('직전 판 0.2.17 · 게이트 풀 pool-cli-test');
    expect(result.previousVersion).toBe('0.2.17');
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 180_000);

test('a live run.lock (already-running) refuses the scheduled start → ⛔ and the CLI exits 1', () => {
  const home = mkdtempSync(join(tmpdir(), 'release-preflight-running-'));
  const root = join(home, '.elanous');
  mkdirSync(join(root, 'release', '0.2.17'), { recursive: true });
  mkdirSync(join(root, 'release', '0.2.18'), { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ release: { loop: { gatePodPool: 'pool-cli-test' } } }));
  writeFileSync(join(root, 'release', '0.2.17', 'release.json'), JSON.stringify({ version: '0.2.17', publishedAt: '2026-10-06T11:47:18.214Z' }));
  writeFileSync(join(root, 'release', '0.2.18', 'run.lock'), JSON.stringify({ pid: process.pid }));
  try {
    const repo = join(import.meta.dir, '../..');
    const run = spawnSync('bun', [join(repo, 'bin/elanous.mjs'), '--config-dir', root, 'release', 'preflight', '--version', '0.2.18', '--json'], { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: root } });
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { verdict: string; findings: Array<{ check: string; level: string; message: string }> };
    const finding = result.findings.find((f) => f.message.includes('already-running'))!;
    expect(finding.level).toBe('block');
    expect(result.verdict).toBe('block');
    expect(run.status).toBe(1);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 180_000);

test('run after the cut: judges at the stored cut, not now (land-by between cut and now keeps an undecided cell ⛔ 판정 없음)', () => isolated(async (root) => {
  // cut 06:00 < land-by 06:20 < now 07:00 KST — judged «now», the cell would read overdue and be carried.
  setSchedule('0.2.18', { cutAt: '2026-10-07T06:00:00+09:00', landBy: '2026-10-07T06:20:00+09:00' }, 'test');
  addItem('0.2.18', { id: 'LATE', title: 'undecided yellow', owner: 'TC' });
  const now = new Date('2026-10-06T22:00:00.000Z');
  expect(cutChecklistGate('0.2.18', '2026-10-06T21:20:00.000Z', now).autoMoved).toContain('LATE');
  expect(cutChecklistGate('0.2.18', '2026-10-06T21:20:00.000Z', new Date('2026-10-06T21:00:00.000Z')).undecided).toContain('LATE');
  const { schedule: _schedule, ...rest } = deps(root, { now });
  const result = await releasePreflight('0.2.18', rest);
  const finding = result.findings.find((f) => f.id === 'LATE')!;
  expect(finding.level).toBe('block');
  expect(finding.message).toContain('판정 없음');
  expect(finding.message).not.toContain('releaseReadiness');
}));

test('real preflight CLI scans the pinned origin/main tree and blocks its exported crown comment', () => {
  const privateMarker = String.fromCodePoint(0x1f451);
  const home = mkdtempSync(join(tmpdir(), 'release-preflight-main-cli-'));
  const repo = join(home, 'repo');
  const config = join(home, '.elanous');
  const redactions = join(home, 'redactions.tsv');
  mkdirSync(repo, { recursive: true });
  mkdirSync(config, { recursive: true });
  writeFileSync(redactions, '');
  writeFileSync(join(repo, '.gitignore'), '');
  mkdirSync(join(repo, 'release'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/.gitignore'), 'ignored.ts\n');
  writeFileSync(join(repo, 'release/public-export.yaml'), 'include: ["src/**"]\nexclude: []\nreplace: {}\n');
  writeFileSync(join(repo, 'src/leak.ts'), `// ${privateMarker} private marker\nexport const safe = true;\nexport const marker = '${privateMarker}';\n`);
  writeFileSync(join(repo, 'src/ignored.ts'), 'export const ignored = true;\n');
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    git(['init', '-q', '-b', 'main']);
    git(['add', '-A']);
    git(['add', '-f', 'src/ignored.ts']);
    git(['-c', 'user.name=Preflight test', '-c', 'user.email=preflight@example.invalid', 'commit', '-qm', 'fixture main']);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const mainSha = git(['rev-parse', 'HEAD']);
    // A second marker exists only in the working tree; preflight must still report the pinned main result.
    const workingTreeContent = `// ${privateMarker} working-tree-only marker\nexport const safe = true;\nexport const marker = '${privateMarker}';\n`;
    writeFileSync(join(repo, 'src/leak.ts'), workingTreeContent);
    const mainStatus = git(['status', '--porcelain']);
    const sourceRepo = join(import.meta.dir, '../..');
    const result = spawnSync('bun', [join(sourceRepo, 'bin/elanous.mjs'), '--config-dir', config, 'release', 'preflight', '--version', '0.2.18', '--json'], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: config, ELANOUS_EXPORT_REDACTIONS: redactions },
    });
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { exportCheck: { mainSha: string; leaks: number; codeLiterals: number }; findings: Array<{ check: string; level: string; message?: string }> };
    expect(output.exportCheck).toMatchObject({ mainSha, leaks: 1, codeLiterals: 1 });
    expect(output.findings).toContainEqual(expect.objectContaining({ check: 'export', level: 'block', message: expect.stringContaining('공개 export 누수 1건') }));
    expect(output.findings).toContainEqual(expect.objectContaining({ check: 'export', level: 'warn', message: expect.stringContaining('코드 리터럴 표지 1건') }));
    expect(git(['rev-parse', 'origin/main'])).toBe(mainSha);
    expect(git(['status', '--porcelain'])).toBe(mainStatus);
    expect(readFileSync(join(repo, 'src/leak.ts'), 'utf8')).toBe(workingTreeContent);
    expect(result.status).toBe(1);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 60_000);

// ── RELEASE-COUNTDOWN-SEQUENCE (0.2.42) — T−120 → T0 발사 시퀀스 ────────────────────────────────
// 무대: mock 시나리오(가짜 시계 deps.now ⊕ 주입 export 검사 ⊕ 주입 컷 manifest/node-b 게이트 자리) · L2 통합 층.
// 판정선: 단계별 녹색/빨강 한 화면 · 빨강이면 이후 단계 자동 중지 ⊕ 담당 자리 우편 ⊕ «부적합 보고» 원장 자동 추가.

const CUT_MANIFEST = { cutoff: { sha: 'b'.repeat(40) }, fragments: { byPr: 0, byNextMd: 2, unlinked: 0, unknown: 0 }, escalate: [] as Array<{ kind: string }> };
const SLOT_OK = { dispatcherPaused: true, podTargetFrom: 6, podTargetTo: 2 };

test('RELEASE-COUNTDOWN-SEQUENCE: T−120→T0 단계를 녹색 한 화면으로 내보내고 전부 녹색이면 통과', () => isolated(async (root) => {
  addItem('0.2.18', { id: 'A1', title: 'cell A1', owner: 'TC' });
  setItem('0.2.18', 'A1', { status: 'green' }, 'TC');
  const runs = join(root, 'graph-runs', 'release-loop');
  fakeRun(runs, 'r1', '0.2.17', '2026-10-06T09:00:00.000Z', 600);
  const ledger = join(root, 'release', 'nonconformance.jsonl');
  const result = await runReleaseCountdown('0.2.18', deps(root, {
    manifest: () => CUT_MANIFEST,
    gateSlot: () => SLOT_OK,
    nonconformanceLog: ledger,
  }));
  expect(result.steps.map((step) => step.stage)).toEqual(['T-120', 'T-60', 'T-30', 'T0']);
  expect(result.steps.map((step) => step.level)).toEqual(['ok', 'ok', 'ok', 'ok']);
  expect(result.steps.every((step) => !step.skipped)).toBe(true);
  expect(result.haltedAt).toBeNull();
  expect(result.verdict).toBe('ok');
  expect(result.mail).toBeNull();
  expect(result.nonconformance).toEqual([]);
  expect(existsSync(ledger)).toBe(false);
  expect(result.steps.map((step) => step.at)).toEqual([
    '2026-10-06T19:00:00.000Z', '2026-10-06T20:00:00.000Z', '2026-10-06T20:30:00.000Z', '2026-10-06T21:00:00.000Z',
  ]);
  expect(result.manualCancel).toMatchObject({
    totalResponsibleSeconds: 8, ldSeconds: 5,
    windowStartAt: '2026-10-06T20:59:47.000Z', windowEndAt: '2026-10-06T21:00:00.000Z',
  });
  const lines = formatCountdown(result);
  expect(lines[0]).toStartWith('release countdown 0.2.18');
  expect(lines.some((line) => line.startsWith('✅ T-120'))).toBe(true);
  expect(lines.some((line) => line.startsWith('✅ T-60'))).toBe(true);
  expect(lines.some((line) => line.startsWith('✅ T-30'))).toBe(true);
  expect(lines.some((line) => line.startsWith('✅ T0'))).toBe(true);
  expect(lines.some((line) => line.includes('최후 수동 취소 구간') && line.includes('총책임자 8초') && line.includes('LD 5초'))).toBe(true);
  expect(lines.at(-1)).toStartWith('✅ 판정:');
}));

test('RELEASE-COUNTDOWN-SEQUENCE: 빨강 기본 dry-run은 우편·부적합 원장을 쓰지 않고 계획만 보인다', () => isolated(async (root) => {
  const ledger = join(root, 'release', 'nonconformance.jsonl');
  const mailed: Array<{ from: string; to: string; subject: string; body: string }> = [];
  const result = await runReleaseCountdown('0.2.18', deps(root, {
    exportCheck: async () => ({ mainSha: 'a'.repeat(40), files: 12, leaks: 3, codeLiterals: 0 }),
    releaseNotesCheck: async () => 1,
    manifest: () => CUT_MANIFEST,
    gateSlot: () => SLOT_OK,
    nonconformanceLog: ledger,
    postMail: (mail) => { mailed.push(mail); },
  }));
  expect(result.haltedAt).toBe('T-120');
  expect(result.sideEffectsEnabled).toBe(false);
  expect(result.mail?.to).toBe('TC');
  expect(mailed).toEqual([]);
  expect(existsSync(ledger)).toBe(false);
  expect(formatCountdown(result).some((line) => line.startsWith('📮 담당 자리 우편 계획(미발송 · 기본 dry-run)'))).toBe(true);
}));

test('RELEASE-COUNTDOWN-SEQUENCE: 빨강이면 이후 단계 자동 중지 ⊕ 담당 자리 우편 ⊕ «부적합 보고» 원장 자동 추가', () => isolated(async (root) => {
  const ledger = join(root, 'release', 'nonconformance.jsonl');
  const mailed: Array<{ from: string; to: string; subject: string; body: string }> = [];
  const result = await runReleaseCountdown('0.2.18', deps(root, {
    exportCheck: async () => ({ mainSha: 'a'.repeat(40), files: 12, leaks: 3, codeLiterals: 0 }),
    manifest: () => CUT_MANIFEST,
    gateSlot: () => SLOT_OK,
    nonconformanceLog: ledger,
    postMail: (mail) => { mailed.push(mail); },
    allowSideEffects: true,
  }));
  expect(result.haltedAt).toBe('T-120');
  expect(result.verdict).toBe('block');
  expect(result.steps.map((step) => step.skipped)).toEqual([false, true, true, true]);
  expect(result.steps.slice(1).every((step) => step.findings.length === 0)).toBe(true);
  expect(result.steps[0]!.findings).toContainEqual(expect.objectContaining({ check: 'export', level: 'block' }));
  expect(result.mail).toMatchObject({ from: 'OP', to: 'TC' });
  expect(result.mail?.subject).toBe('RELEASE-COUNTDOWN 0.2.18 T-120');
  expect(mailed).toEqual([result.mail!]);
  const entry = result.nonconformance.find((row) => row.stage === 'T-120' && row.cause.includes('공개 export 누수'))!;
  expect(entry).toMatchObject({ version: '0.2.18', stage: 'T-120', nextRelease: '0.2.19' });
  expect(entry.repair.length).toBeGreaterThan(0);
  expect(result.nonconformanceLedger).toBe(ledger);
  const written = readFileSync(ledger, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(written).toContainEqual(entry);
  const lines = formatCountdown(result);
  expect(lines.some((line) => line.startsWith('⏸ T-60') && line.includes('미진행(T-120 빨강 — 자동 중지)'))).toBe(true);
  expect(lines.some((line) => line.startsWith('📮 담당 자리 우편 → TC'))).toBe(true);
  expect(lines.at(-1)).toStartWith('⛔ 판정: 평가 중지 — T-120 빨강');
}));

test('RELEASE-COUNTDOWN-SEQUENCE: T−120 노트 0줄은 ⛔ notes-empty, T−60 node-b 게이트 자리 미확보는 ⛔ 디스패처·podTarget', () => isolated(async (root) => {
  const ledger = join(root, 'release', 'nonconformance.jsonl');
  const notesRed = await runReleaseCountdown('0.2.18', deps(root, {
    manifest: () => ({ cutoff: { sha: 'b'.repeat(40) }, fragments: { byPr: 0, byNextMd: 0, unlinked: 0, unknown: 0 }, escalate: [{ kind: 'notes-empty' }] }),
    gateSlot: () => SLOT_OK,
    nonconformanceLog: ledger,
  }));
  expect(notesRed.haltedAt).toBe('T-120');
  const notes = notesRed.steps[0]!.findings.find((finding) => finding.check === 'notes')!;
  expect(notes).toMatchObject({ level: 'block' });
  expect(notes.message).toContain('notes-empty');

  rmSync(ledger, { force: true });
  const slotRed = await runReleaseCountdown('0.2.18', deps(root, {
    manifest: () => CUT_MANIFEST,
    gateSlot: () => ({ dispatcherPaused: false, podTargetFrom: 6, podTargetTo: 6 }),
    nonconformanceLog: ledger,
  }));
  expect(slotRed.steps[0]!.level).toBe('ok');
  expect(slotRed.haltedAt).toBe('T-60');
  const slot = slotRed.steps[1]!.findings.filter((finding) => finding.check === 'gate-slot');
  expect(slot.every((finding) => finding.level === 'block')).toBe(true);
  expect(slot.some((finding) => finding.message.includes('디스패처'))).toBe(true);
  expect(slot.some((finding) => finding.message.includes('podTarget'))).toBe(true);
  expect(slotRed.mail?.to).toBe('OP');
  expect(slotRed.steps.slice(2).every((step) => step.skipped)).toBe(true);
  expect(formatCountdown(slotRed).at(-1)).toStartWith('⛔ 판정: 평가 중지 — T-60 빨강');
}));

test('real CLI: release preflight --countdown 은 생산 진입점에서 T−120→T0 단계와 판정 한 줄을 낸다', () => {
  const home = mkdtempSync(join(tmpdir(), 'release-countdown-cli-'));
  const root = join(home, '.elanous');
  mkdirSync(join(root, 'release', '0.2.17'), { recursive: true });
  mkdirSync(join(root, 'release', '0.2.18'), { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ release: { loop: { gatePodPool: 'pool-cli-test' } } }));
  writeFileSync(join(root, 'release', '0.2.17', 'release.json'), JSON.stringify({ version: '0.2.17', publishedAt: '2026-10-06T11:47:18.214Z' }));
  writeFileSync(join(root, 'release', '0.2.18', 'manifest.json'), JSON.stringify({ version: '0.2.18', baseline: { ref: 'v0.2.17', sha: 'a'.repeat(40) }, cutoff: { sha: 'b'.repeat(40) }, in: [], deferred: [], escalate: [], fragments: { byPr: 0, byNextMd: 2, unlinked: 0, unknown: 0 } }));
  writeFileSync(join(root, 'release', '0.2.18', 'gate-slot.json'), JSON.stringify(SLOT_OK));
  setElanousConfigDir(root);
  setSchedule('0.2.18', { cutAt: '2026-10-07T06:00:00+09:00', landBy: '2026-10-07T05:30:00+09:00' }, 'test');
  resetElanousConfigDir();
  try {
    const repo = join(import.meta.dir, '../..');
    const run = spawnSync('bun', [join(repo, 'bin/elanous.mjs'), '--config-dir', root, 'release', 'preflight', '--version', '0.2.18', '--countdown', '--json'], {
      cwd: repo, encoding: 'utf8', timeout: 180_000, env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: root },
    });
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as {
      steps: Array<{ stage: string; level: string; skipped: boolean }>; verdict: string; nonconformance: unknown[]; manualCancel: { totalResponsibleSeconds: number };
    };
    expect(result.steps.map((step) => step.stage)).toEqual(['T-120', 'T-60', 'T-30', 'T0']);
    expect(result.manualCancel).toMatchObject({
      totalResponsibleSeconds: 8, ldSeconds: 5,
      windowEndAt: '2026-10-06T21:00:00.000Z', windowStartAt: '2026-10-06T20:59:47.000Z',
    });
    expect(run.status).toBe(result.verdict === 'block' ? 1 : 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 240_000);
