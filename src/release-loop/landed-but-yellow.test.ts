import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { evidencePlan, landedButYellow, type MergedChecklistPr } from './landed-but-yellow.js';
import { debug } from '../debug/log.js';
import type { LandedButYellowDeps } from '../cli/release-cli.js';
import * as checklist from './checklist.js';
import type { ChecklistItem } from './checklist.js';
import { registerReleaseCommands, type Runner } from '../cli/release-cli.js';

const item = (id: string, status: ChecklistItem['status'] = 'yellow', extra: Partial<ChecklistItem> = {}): ChecklistItem =>
  ({ id, title: id, status, owner: 'UX', updatedAt: '2026-10-03T00:00:00Z', updatedBy: 'UX', ...extra });
const pr = (number: number, title: string, body = '', mergedAt = '2026-10-03T01:00:00Z'): MergedChecklistPr =>
  ({ number, title, body, mergedAt });
const sample = [item('W3', 'yellow', { evidence: '#12' }), item('R1', 'red', { owner: 'TC', updatedAt: '2026-10-04T00:00:00Z' }), item('G1', 'green')];
const merges = [pr(11, 'W3d only'), pr(12, 'W3 fixed'), pr(13, 'misc', '칸: R1'), pr(14, 'G1 fixed')];

async function cli(args: string[], prs: MergedChecklistPr[] = merges, options: { status?: number | null; stderr?: string; items?: ChecklistItem[]; evidenceAdd?: LandedButYellowDeps['evidenceAdd'] } = {}) {
  const stdout: string[] = [], stderr: string[] = [], calls: Array<{ command: string; args: readonly string[] }> = [];
  const evidenceCalls: Array<{ id: string; version: string; ref: string; by: string; released: string | undefined; dev: string | undefined }> = [];
  const events: Array<{ category: string; event: string; data: unknown }> = [];
  const evidenceAdd: NonNullable<LandedButYellowDeps['evidenceAdd']> = (id, version, ref, by, released, dev) => {
    evidenceCalls.push({ id, version, ref, by, released, dev });
    options.evidenceAdd?.(id, version, ref, by, released, dev);
  };
  const debugLog = spyOn(debug, 'log').mockImplementation((category, event, data) => { events.push({ category, event, data }); });
  const setItem = spyOn(checklist, 'setItem').mockImplementation(() => { throw new Error('status 변경 호출 금지'); });
  const log = spyOn(console, 'log').mockImplementation((line) => { stdout.push(String(line)); });
  const error = spyOn(console, 'error').mockImplementation((line) => { stderr.push(String(line)); });
  const write = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array, callback?: unknown) => {
    stdout.push(String(chunk).trim());
    if (typeof callback === 'function') callback();
    return true;
  });
  const previous = process.exitCode;
  const root = mkdtempSync(join(tmpdir(), 'landed-but-yellow-'));
  setElanousConfigDir(root);
  process.exitCode = 0;
  const run: Runner = (command, argv) => {
    calls.push({ command, args: argv });
    return { status: options.status ?? 0, stdout: JSON.stringify(prs), stderr: options.stderr ?? '' };
  };
  let reads = 0;
  try {
    const program = new Command();
    registerReleaseCommands(program, {}, { run, checklist: (version) => {
      reads++;
      expect(version).toBe('0.2.12');
      return { version, dev: version, released: '', items: options.items ?? sample, history: [] };
    }, evidenceAdd, now: () => new Date('2026-10-04T04:00:00Z') });
    await program.parseAsync(['release', 'checklist', 'landed-but-yellow', '--version', '0.2.12', ...args], { from: 'user' });
    expect(existsSync(join(root, 'release', 'features.sqlite'))).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    return { stdout, stderr, calls, reads, evidenceCalls, events, exitCode: process.exitCode };
  } finally {
    log.mockRestore(); error.mockRestore(); write.mockRestore(); debugLog.mockRestore(); setItem.mockRestore(); process.exitCode = previous;
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
}

afterEach(() => { process.exitCode = 0; });

describe('landedButYellow', () => {
  test('W3d alone does not match W3; title and body match, green does not, evidence is per PR', () => {
    expect(landedButYellow([item('W3')], [pr(11, 'W3d')])).toEqual([]);
    const result = landedButYellow(sample, merges);
    expect(result.map((row) => row.id)).toEqual(['W3', 'R1']);
    expect(result[0]).toEqual({ id: 'W3', owner: 'UX', status: 'yellow', prs: [{ number: 12, title: 'W3 fixed', mergedAt: '2026-10-03T01:00:00Z', basis: 'title-strong' }], alreadyInEvidence: [true], newer: true });
    expect(result[1]?.prs[0]?.basis).toBe('cell-line');
    expect(result[1]).toMatchObject({ status: 'red', prs: [{ number: 13 }], alreadyInEvidence: [false], newer: false });
    expect(landedButYellow(sample, merges, { owner: 'UX' }).map((row) => row.id)).toEqual(['W3']);
    expect(landedButYellow([item('W3', 'yellow', { owner: 'UX/sub' })], [pr(9, 'W3')], { owner: 'UX' })).toHaveLength(1);
  });

  test('evidence requires a standalone #number, not an embedded or doubled hash', () => {
    for (const evidence of ['#12abc', '##12', '#123', '#12_abc', 'x#12']) {
      expect(landedButYellow([item('W3', 'yellow', { evidence })], [pr(12, 'W3')])[0]?.alreadyInEvidence).toEqual([false]);
    }
    expect(landedButYellow([item('W3', 'yellow', { evidence: 'merged (#12), reviewed' })], [pr(12, 'W3')])[0]?.alreadyInEvidence).toEqual([true]);
  });

  test('cell lines precede strong titles and mentions, with newest first within each basis', () => {
    const rows = landedButYellow([item('W3'), item('CL-AUTO')], [
      pr(21, 'misc', '칸: W3', '2026-10-03T01:00:00Z'),
      pr(22, 'W3 첫 조각', '', '2026-10-03T02:00:00Z'),
      pr(23, 'W3 수확: done', '', '2026-10-03T03:00:00Z'),
      pr(24, '(W3) verified', '', '2026-10-03T04:00:00Z'),
      pr(25, 'misc', '칸 W3', '2026-10-03T05:00:00Z'),
      pr(26, 'check CL-AUTO now', '', '2026-10-03T06:00:00Z'),
      pr(27, 'misc', 'CL-AUTO', '2026-10-03T07:00:00Z'),
      pr(28, 'CL-AUTO 수확', '', '2026-10-03T02:00:00Z'),
      pr(29, 'misc', '칸: CL-AUTO', '2026-10-03T01:00:00Z'),
      pr(30, 'W3 수확', '칸: W3', '2026-10-03T00:00:00Z'),
    ]);
    expect(rows[0]?.prs.map(({ number, basis }) => [number, basis])).toEqual([
      [25, 'cell-line'], [21, 'cell-line'], [30, 'cell-line'], [24, 'title-strong'], [23, 'title-strong'],
    ]);
    expect(rows[1]?.prs.map(({ number, basis }) => [number, basis])).toEqual([
      [29, 'cell-line'], [28, 'title-strong'], [27, 'mention'], [26, 'mention'],
    ]);
  });

  test('short ids reject incidental mentions but accept cell lines and explicit title shapes', () => {
    const ids = ['R7', 'R2', 'A2', 'A4', 'F1'];
    const incidental = [
      'U1c2 실물 PTY 시험을 맥에선 tui-regress R7 로',
      'V1g tui-regress 승인 줄 R2 로',
      'owner 문법 TC/rel ⊕ 표 A2',
      '방문자 한 장 영어판 A4',
      'V3 shadow comparison sheet F1',
    ];
    for (const [index, id] of ids.entries()) {
      expect(landedButYellow([item(id)], [pr(index, incidental[index]!)])).toEqual([]);
      expect(landedButYellow([item(id)], [pr(index, 'misc', `설명에 ${id} 언급`)])).toEqual([]);
    }
    expect(landedButYellow([item('R7')], [pr(39, 'tui-regress R7 로')])).toEqual([]);
    expect(landedButYellow([item('R7')], [pr(38, 'R7 로 tui-regress 승인')])).toEqual([]);
    expect(landedButYellow([item('R7')], [pr(37, 'R7 는 회귀 묶음')])).toEqual([]);
    expect(landedButYellow([item('R7')], [pr(36, 'R7 릴리스 수확')])).toEqual([]);
    expect(landedButYellow([item('R7')], [pr(35, 'R7 수확물 검토')])).toEqual([]);
    const rows = landedButYellow([item('R7'), item('A2'), item('W3')], [
      pr(40, 'tui-regress R7 로', '배경\n칸: R7\n후속'),
      pr(41, 'other', '칸: A2, W3'),
      pr(42, 'other', '칸 A2, W3'),
      pr(43, 'W3 둘째 조각'),
      pr(44, '배포 W3 셋째 조각'),
      pr(55, 'tui-regress R7 로', '배경\r\n칸: R7\r\n후속'),
    ]);
    expect(rows.find(({ id }) => id === 'R7')?.prs.map(({ number, basis }) => [number, basis])).toEqual([[55, 'cell-line'], [40, 'cell-line']]);
    expect(rows.find(({ id }) => id === 'A2')?.prs.map(({ number, basis }) => [number, basis])).toEqual([[42, 'cell-line'], [41, 'cell-line']]);
    expect(rows.find(({ id }) => id === 'W3')?.prs.map(({ number, basis }) => [number, basis])).toEqual([
      [42, 'cell-line'], [41, 'cell-line'], [44, 'title-strong'], [43, 'title-strong'],
    ]);
    expect(landedButYellow([item('W3')], [pr(45, 'tui-regress (W3d)'), pr(46, 'tui-regress (W3)')])[0]?.prs.map(({ number, basis }) => [number, basis])).toEqual([[46, 'title-strong']]);
    expect(landedButYellow([item('W3')], [pr(47, 'W3d 수확'), pr(48, 'W3d 첫 조각')])).toEqual([]);
    expect(landedButYellow([item('W3')], [pr(49, 'misc', '서술 중 칸: W3 거짓'), pr(50, 'misc', '칸: W3d, W30')])).toEqual([]);
    expect(landedButYellow([item('W3')], [pr(51, 'misc', '칸: W3, W3d')])[0]?.prs[0]?.basis).toBe('cell-line');
    expect(landedButYellow([item('R7')], [pr(52, 'R7 수확'), pr(53, 'R7 첫 조각'), pr(54, '(R7)')])[0]?.prs.map(({ basis }) => basis)).toEqual(['title-strong', 'title-strong', 'title-strong']);
  });

  test('CRLF cell lines recognize short ids without matching a bare carriage return inside a line', () => {
    expect(landedButYellow([item('R7')], [pr(55, 'tui-regress R7 로', '칸: R7\r\n후속')])[0]?.prs[0]?.basis).toBe('cell-line');
    expect(landedButYellow([item('R7')], [pr(56, 'tui-regress R7 로', '칸: R7\r후속')])).toEqual([]);
  });

  test('newer rows lead; up to five matching PRs are newest first and #12 is not #123', () => {
    const rows = landedButYellow([item('OLD', 'red', { updatedAt: '2026-10-04T00:00:00Z' }), item('W3', 'yellow', { evidence: '#123' })], [
      pr(1, 'OLD'), ...Array.from({ length: 7 }, (_, i) => pr(i + 10, 'W3', '', `2026-10-03T0${i}:00:00Z`)),
    ]);
    expect(rows.map((row) => [row.id, row.newer])).toEqual([['W3', true], ['OLD', false]]);
    expect(rows[0]?.prs.map((p) => p.number)).toEqual([16, 15, 14, 13, 12]);
    expect(rows[0]?.alreadyInEvidence).toEqual([false, false, false, false, false]);
  });
});

describe('evidencePlan', () => {
  test('includes only missing cell-line and strong-title pairs, deduplicated by cell and PR', () => {
    const rows = landedButYellow([item('CL-AUTO', 'yellow', { evidence: '#8' }), item('OTHER')], [
      pr(7, 'misc', '칸: CL-AUTO'), pr(8, 'CL-AUTO 수확'), pr(9, 'CL-AUTO 셋째 조각'),
      pr(10, 'unrelated CL-AUTO mention'), pr(11, 'misc', '칸: OTHER, CL-AUTO'),
    ]);
    expect(evidencePlan([...rows, rows[0]!])).toEqual([
      { id: 'CL-AUTO', ref: '#11' }, { id: 'CL-AUTO', ref: '#7' }, { id: 'CL-AUTO', ref: '#9' },
      { id: 'OTHER', ref: '#11' },
    ]);
    expect(rows[0]?.prs.find((p) => p.number === 10)?.basis).toBe('mention');
    expect(rows[0]?.alreadyInEvidence[rows[0].prs.findIndex((p) => p.number === 8)]).toBe(true);
  });
});

describe('release checklist landed-but-yellow CLI', () => {
  test('--apply-evidence writes the plan only, preserves status, prints summary and logs the sync', async () => {
    const items = [item('CL-AUTO', 'yellow', { evidence: '#8' }), item('R1', 'red')];
    const prs = [pr(7, 'misc', '칸: CL-AUTO'), pr(8, 'CL-AUTO 수확'), pr(9, 'CL-AUTO 셋째 조각'),
      pr(10, 'unrelated CL-AUTO mention'), pr(11, 'misc', '칸: R1')];
    const initial = items.map(({ status, evidence }) => ({ status, evidence }));
    const applied = await cli(['--apply-evidence'], prs, { items });
    expect(applied.evidenceCalls).toEqual([
      { id: 'CL-AUTO', version: '0.2.12', ref: '#7', by: process.env.ELANOUS_TRACK || 'cli', released: '', dev: '0.2.12' },
      { id: 'CL-AUTO', version: '0.2.12', ref: '#9', by: process.env.ELANOUS_TRACK || 'cli', released: '', dev: '0.2.12' },
      { id: 'R1', version: '0.2.12', ref: '#11', by: process.env.ELANOUS_TRACK || 'cli', released: '', dev: '0.2.12' },
    ]);
    expect(applied.stdout.slice(-4)).toEqual(['✅ CL-AUTO 근거 #7', '✅ CL-AUTO 근거 #9', '✅ R1 근거 #11', '붙임 3 · 건너뜀(언급만) 1']);
    expect(applied.events).toContainEqual({ category: 'release.checklist', event: 'evidence-synced', data: { added: 3, skippedMention: 1 } });
    expect(items.map(({ status, evidence }) => ({ status, evidence }))).toEqual(initial);
    expect(applied.exitCode).toBe(0);

    const dry = await cli(['--apply-evidence', '--dry-run'], prs, { items });
    expect(dry.evidenceCalls).toEqual([]);
    expect(dry.stdout.slice(-4)).toEqual(['· CL-AUTO 근거 #7', '· CL-AUTO 근거 #9', '· R1 근거 #11', '붙임 0 · 건너뜀(언급만) 1']);
    expect(dry.events.find(({ event }) => event === 'evidence-synced')).toBeUndefined();
    expect(items.map(({ status, evidence }) => ({ status, evidence }))).toEqual(initial);
  });

  test('human lines, counts, seven-day search and read-only injected ledger', async () => {
    const result = await cli([]);
    expect(result.calls).toEqual([{ command: 'gh', args: ['pr', 'list', '--state', 'merged', '--search', 'merged:>=2026-09-27', '--limit', '400', '--json', 'number,title,body,mergedAt'] }]);
    expect(result.reads).toBe(1);
    expect(result.stdout).toEqual([
      'W3 UX 🟡 ← #12 «W3 fixed» (10-03 10:00 · 근거에 있음 · 칸보다 새것)',
      'R1 TC 🔴 ← #13 «misc» (10-03 10:00 · 근거에 없음)',
      '2칸 · 그중 근거에 없는 PR 이 있는 칸 1',
    ]);
    expect(result.stderr).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('embedded PR-like text does not reduce the missing-evidence count', async () => {
    const result = await cli([], [pr(12, 'W3 fixed')], { items: [item('W3', 'yellow', { evidence: '#12abc · ##12' })] });
    expect(result.stdout).toEqual([
      'W3 UX 🟡 ← #12 «W3 fixed» (10-03 10:00 · 근거에 없음 · 칸보다 새것)',
      '1칸 · 그중 근거에 없는 PR 이 있는 칸 1',
    ]);
  });

  test('mixed merge times do not label the older PR as newer than the item', async () => {
    const result = await cli([], [
      pr(31, 'W3 new', '', '2026-10-03T02:00:00Z'),
      pr(30, 'W3 old', '', '2026-10-03T00:00:00Z'),
    ], { items: [item('W3', 'yellow', { updatedAt: '2026-10-03T01:00:00Z' })] });
    expect(result.stdout).toEqual([
      'W3 UX 🟡 ← #31 «W3 new» (10-03 11:00 · 근거에 없음 · 칸보다 새것) · #30 «W3 old» (10-03 09:00 · 근거에 없음)',
      '1칸 · 그중 근거에 없는 PR 이 있는 칸 1',
    ]);
  });

  test('--owner filters, --json returns only an array, and 400 limit warns', async () => {
    const filtered = await cli(['--owner', 'UX', '--json']);
    expect(JSON.parse(filtered.stdout.join(''))).toEqual(landedButYellow(sample, merges, { owner: 'UX' }));
    expect(filtered.stdout).toHaveLength(1);
    expect(filtered.stderr).toEqual([]);
    const capped = await cli([], Array.from({ length: 400 }, (_, i) => pr(i + 1, 'W3')));
    expect(capped.stderr).toEqual(['⚠ 병합 PR 400개 상한: 목록이 잘렸을 수 있다']);
  });

  test('gh failure is exit 1 with reason, never reads or writes ledger', async () => {
    const result = await cli([], merges, { status: 1, stderr: 'authentication required' });
    expect(result.exitCode).toBe(1);
    expect(result.reads).toBe(0);
    expect(result.stderr).toEqual(['⛔ 병합 PR 조회(gh) 실패 rc=1: authentication required']);
  });
});
