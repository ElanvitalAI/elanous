import { afterEach, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { registerReleaseCommands } from '../../src/cli/release-cli.js';
import { getSchedule } from '../../src/release-loop/release-schedule.js';
import { defaultReleaseGraphRunsRoot, formatPublishProposal, measurePublishWindow, proposePublishAt, publishWindowWarning } from './publish-window.js';

const PATH = ['version-release', 'cutoff', 'checklist-gate', 'gate', 'prepare', 'publish', 'npm-publish', 'done'];
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); resetElanousConfigDir(); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'publish-window-')); dirs.push(d); return d; };

/** A run whose publish node ends `minutes` after the run start, recorded in nodes[]. */
function runWithNodes(root: string, runId: string, version: string, startedAt: string, minutes: number, status = 'done') {
  const end = new Date(Date.parse(startedAt) + minutes * 60_000).toISOString();
  writeFileSync(join(root, `${runId}.json`), JSON.stringify({
    runId, status, startedAt, input: { version }, path: PATH,
    nodes: [{ nodeId: 'gate', startedAt, endedAt: startedAt }, { nodeId: 'publish', startedAt, endedAt: end }],
  }));
}

/** An older ledger: no node timestamps, only contexts/<n>.json mtimes (node n started). */
function runWithContexts(root: string, runId: string, version: string, startedAt: string, minutes: number) {
  writeFileSync(join(root, `${runId}.json`), JSON.stringify({ runId, status: 'done', startedAt, input: { version }, path: PATH, nodes: PATH.map((nodeId) => ({ nodeId })) }));
  const contexts = join(root, `${runId}.json.contexts`);
  mkdirSync(contexts, { recursive: true });
  const next = PATH.indexOf('publish') + 1; // npm-publish starts when publish ends
  const file = join(contexts, `${next + 1}.json`);
  writeFileSync(file, JSON.stringify({ nodeId: PATH[next] }));
  const at = new Date(Date.parse(startedAt) + minutes * 60_000);
  utimesSync(file, at, at);
}

test('median over the last 3 completed stable runs · failed / rc runs are not in the window · an unmeasurable run stays in it as skipped (never backfilled, never 0)', () => {
  const root = tmp();
  runWithNodes(root, 'r5', '0.2.19', '2026-10-07T09:30:00.000Z', 120);
  runWithContexts(root, 'r4', '0.2.18', '2026-10-06T21:30:00.000Z', 150);
  runWithNodes(root, 'r3f', '0.2.18', '2026-10-06T20:00:00.000Z', 5, 'failed');
  runWithNodes(root, 'r3rc', '0.2.18-rc.0', '2026-10-06T19:00:00.000Z', 5);
  writeFileSync(join(root, 'r2.json'), JSON.stringify({ runId: 'r2', status: 'done', startedAt: '2026-10-06T09:00:00.000Z', input: { version: '0.2.17' }, path: PATH, nodes: [] }));
  runWithNodes(root, 'r1', '0.2.16', '2026-10-06T00:00:00.000Z', 90);
  runWithNodes(root, 'r0', '0.2.15', '2026-10-05T00:00:00.000Z', 10); // 4th measurable — outside the sample
  const m = measurePublishWindow({ root });
  expect(m.samples.map((s) => [s.version, s.seconds / 60, s.source])).toEqual([['0.2.19', 120, 'nodes'], ['0.2.18', 150, 'contexts']]);
  expect(m.skipped).toEqual([{ runId: 'r2', version: '0.2.17', why: '발행 노드 끝 시각을 못 읽음' }]);
  expect(m.medianSeconds).toBe(135 * 60); // 0.2.16 (outside the last 3 completed runs) is not pulled in
  expect(measurePublishWindow({ root, sample: 4 }).samples.map((s) => s.version)).toEqual(['0.2.19', '0.2.18', '0.2.16']);
});

test('a completed stable run with a broken startedAt or path is skipped with a reason, not silently dropped', () => {
  const root = tmp();
  runWithNodes(root, 'ok', '0.2.19', '2026-10-07T09:30:00.000Z', 100);
  writeFileSync(join(root, 'nostart.json'), JSON.stringify({ runId: 'nostart', status: 'done', input: { version: '0.2.18' }, path: PATH }));
  writeFileSync(join(root, 'nopath.json'), JSON.stringify({ runId: 'nopath', status: 'done', startedAt: '2026-10-06T09:00:00.000Z', input: { version: '0.2.17' } }));
  const m = measurePublishWindow({ root });
  expect(m.samples.map((s) => s.version)).toEqual(['0.2.19']);
  expect(m.skipped.map(({ runId, why }) => [runId, why]).sort()).toEqual([['nopath', 'path 가 배열이 아님'], ['nostart', 'startedAt 없음·무효']]);
  expect(m.medianSeconds).toBe(100 * 60);
});

test('proposal = cut + median + margin rounded up to 5 min · warning only when the window is shorter than the median', () => {
  const root = tmp();
  runWithNodes(root, 'a', '0.2.19', '2026-10-07T09:30:00.000Z', 103);
  const m = measurePublishWindow({ root });
  const cut = '2026-10-07T09:45:00.000Z'; // 18:45 KST
  expect(proposePublishAt(cut, m)).toBe('2026-10-07T11:40:00.000Z'); // 18:45 + 103 + 10 = 20:38 → 20:40 KST
  const warning = publishWindowWarning(cut, '2026-10-07T11:00:00.000Z', m)!; // 20:00 KST = 75 min
  expect(warning.split('\n')).toHaveLength(1);
  expect(warning).toContain('발행 시각이 실측 중앙값(103분)보다 짧다');
  expect(warning).toContain('제안: 20:40');
  expect(publishWindowWarning(cut, '2026-10-07T11:28:00.000Z', m)).toBeNull(); // exactly the median
  expect(formatPublishProposal(cut, m)).toStartWith('발행 제안 20:40 KST — 컷 + 실측 중앙값 103분');
});

test('no measured run ⇒ no proposal and no warning (unmeasured is not 0)', () => {
  const m = measurePublishWindow({ root: join(tmp(), 'missing') });
  expect(m.medianSeconds).toBeNull();
  expect(proposePublishAt('2026-10-07T09:45:00.000Z', m)).toBeNull();
  expect(publishWindowWarning('2026-10-07T09:45:00.000Z', '2026-10-07T09:50:00.000Z', m)).toBeNull();
  expect(formatPublishProposal('2026-10-07T09:45:00.000Z', m)).toStartWith('발행 제안 — 실측 없음');
});

test('release schedule set --publish-at warns on stderr in one line · show prints the proposal · reads only the injected ledger', async () => {
  const dir = tmp();
  setElanousConfigDir(join(dir, 'config'));
  const ledger = join(dir, 'ledger');
  const runs = defaultReleaseGraphRunsRoot(ledger);
  mkdirSync(runs, { recursive: true });
  runWithNodes(runs, 'a', '0.2.19', '2026-10-07T09:30:00.000Z', 100);
  runWithNodes(runs, 'b', '0.2.18', '2026-10-06T21:30:00.000Z', 110);
  runWithNodes(runs, 'c', '0.2.17', '2026-10-06T09:30:00.000Z', 120);
  const out: string[] = [], err: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((l: string) => { out.push(l); });
  const error = spyOn(console, 'error').mockImplementation((l: string) => { err.push(l); });
  try {
    const run = async (...args: string[]) => { const cmd = new Command(); registerReleaseCommands(cmd, { ledgerRoot: ledger }); await cmd.parseAsync(['release', 'schedule', ...args], { from: 'user' }); };
    await run('set', '--version', '9.9.1', '--cut-at', '2099-10-07T18:45+09:00', '--publish-at', '2099-10-07T20:00+09:00');
    expect(out.at(-1)).toBe('9.9.1 컷 10-07(수) 18:45 KST · 발행 20:00');
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('발행 시각이 실측 중앙값(110분)보다 짧다');
    expect(err[0]).toContain('제안: 20:45'); // 18:45 + 110 + 10 = 20:45
    expect(getSchedule('9.9.1', ledger)?.publishAt).toBe('2099-10-07T11:00:00.000Z');

    await run('set', '--version', '9.9.1', '--publish-at', '2099-10-07T21:00+09:00');
    expect(err).toHaveLength(1); // long enough — no new warning

    await run('show', '--version', '9.9.1');
    expect(out.at(-2)).toBe('9.9.1 컷 10-07(수) 18:45 KST · 발행 21:00');
    expect(out.at(-1)).toStartWith('발행 제안 20:45 KST — 컷 + 실측 중앙값 110분(최근 3판 0.2.19 100분 · 0.2.18 110분 · 0.2.17 120분)');
    await run('show', '--version', '9.9.1', '--json');
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ publishAt: '2099-10-07T12:00:00.000Z', proposedPublishAt: '2099-10-07T11:45:00.000Z', measuredPublishMedianSeconds: 6600 });
    await expect(run('set', '--version', '9.9.1', '--publish-at', '2099-10-07T18:00+09:00')).rejects.toThrow('발행 시각은 컷보다 뒤여야 한다');
  } finally { log.mockRestore(); error.mockRestore(); }
});
