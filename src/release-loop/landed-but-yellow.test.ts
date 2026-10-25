import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { evidencePlan, fetchMergedChecklistPrs, landedButYellow, MERGED_PR_CONCURRENCY, MERGED_PR_LIMIT, type MergedChecklistPr, type MergedPrRunner } from './landed-but-yellow.js';
import { withFakeBins } from '../ux-sim/fake-bin.js';
import { debug } from '../debug/log.js';
import type { LandedButYellowDeps } from '../cli/release-cli.js';
import * as checklist from './checklist.js';
import type { Checklist, ChecklistItem } from './checklist.js';
import { registerReleaseCommands, type Runner } from '../cli/release-cli.js';

const item = (id: string, status: ChecklistItem['status'] = 'yellow', extra: Partial<ChecklistItem> = {}): ChecklistItem =>
  ({ id, title: id, status, owner: 'UX', updatedAt: '2026-10-03T00:00:00Z', updatedBy: 'UX', ...extra });
const pr = (number: number, title: string, body = '', mergedAt = '2026-10-03T01:00:00Z'): MergedChecklistPr =>
  ({ number, title, body, mergedAt });
const sample = [item('W3', 'yellow', { evidence: '#12' }), item('R1', 'red', { owner: 'TC', updatedAt: '2026-10-04T00:00:00Z' }), item('G1', 'green')];
const merges = [pr(11, 'W3d only'), pr(12, 'W3 fixed'), pr(13, 'misc', '칸: R1'), pr(14, 'G1 fixed')];

async function cli(args: string[], prs: MergedChecklistPr[] = merges, options: { status?: number | null; stderr?: string; items?: ChecklistItem[]; evidenceAdd?: LandedButYellowDeps['evidenceAdd']; pages?: (args: readonly string[]) => MergedChecklistPr[] } = {}) {
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
    return { status: options.status ?? 0, stdout: JSON.stringify(options.pages?.(argv) ?? prs), stderr: options.stderr ?? '' };
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
    log.mockRestore(); error.mockRestore(); write.mockRestore(); debugLog.mockRestore(); setItem.mockRestore(); process.exitCode = previous ?? 0;
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

  test('human lines, counts, earliest relevant updatedAt search and read-only injected ledger', async () => {
    const result = await cli([]);
    expect(result.calls).toEqual([{ command: 'gh', args: ['pr', 'list', '--state', 'merged', '--search', 'merged:>=2026-10-03', '--limit', '400', '--json', 'number,title,body,mergedAt'] }]);
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

  test('--owner filters and --json returns only an array', async () => {
    const filtered = await cli(['--owner', 'UX', '--json']);
    expect(JSON.parse(filtered.stdout.join(''))).toEqual(landedButYellow(sample, merges, { owner: 'UX' }));
    expect(filtered.stdout).toHaveLength(1);
    expect(filtered.stderr).toEqual([]);
  });

  test('offset updatedAt uses its UTC day, retaining a PR merged on the preceding local date', async () => {
    const merged = pr(99, 'W3 fixed', '', '2026-10-02T12:00:00Z');
    const result = await cli(['--json'], [merged], {
      items: [item('W3', 'yellow', { updatedAt: '2026-10-03T00:30:00+14:00' }), item('OTHER', 'red', { updatedAt: '2026-10-03T01:00:00Z' })],
      pages: (args) => [merged].filter((row) => row.mergedAt >= args[args.indexOf('--search') + 1]!.match(/merged:>=(\S+)/)![1]!),
    });
    expect(result.calls[0]!.args).toContain('merged:>=2026-10-02');
    expect(JSON.parse(result.stdout.join(''))[0].prs[0].number).toBe(99);
    expect(result.stderr).toEqual([]);
  });

  test('400 cap subdivides dated windows, merges pages and removes duplicate PR numbers without changing JSON rows', async () => {
    const all = [pr(900, 'W3 fixed', '', '2026-10-03T02:00:00Z'),
      ...Array.from({ length: 399 }, (_, i) => pr(i + 1, 'other', '', '2026-10-03T03:00:00Z')),
      pr(901, 'W3 fixed', '', '2026-10-04T02:00:00Z')];
    const result = await cli(['--json'], all, { items: [item('W3', 'yellow', { updatedAt: '2026-10-03T00:00:00Z' })],
      pages: (args) => {
        const search = args[args.indexOf('--search') + 1]!;
        const limit = Number(args[args.indexOf('--limit') + 1]);
        const from = search.match(/merged:>=(\S+)/)![1]!;
        const until = search.match(/merged:<(\S+)/)?.[1];
        const matches = all.filter((row) => row.mergedAt >= from && (!until || row.mergedAt < until));
        return (until && matches.length < 400 && matches.length ? [matches[0]!, ...matches] : matches).slice(0, limit);
      } });
    expect(result.calls.length).toBeGreaterThan(2);
    expect(result.calls[0]!.args).toContain('merged:>=2026-10-03');
    expect(result.calls.slice(1).every(({ args }) => args[args.indexOf('--search') + 1]!.includes('merged:<'))).toBe(true);
    const rows = JSON.parse(result.stdout.join(''));
    expect(rows).toEqual(landedButYellow([item('W3', 'yellow', { updatedAt: '2026-10-03T00:00:00Z' })], all));
    expect(rows[0].prs.map((entry: { number: number }) => entry.number)).toEqual([901, 900]);
    expect(result.stderr).toEqual([]);
  });

  test('exactly 400 within one second is not a truncation, but 401 warns', async () => {
    const all = Array.from({ length: 401 }, (_, i) => pr(i + 1, 'W3', '', '2026-10-03T02:00:00Z'));
    const pages = (rows: MergedChecklistPr[]) => (args: readonly string[]) => {
      const search = args[args.indexOf('--search') + 1]!;
      const from = search.match(/merged:>=(\S+)/)![1]!;
      const until = search.match(/merged:<(\S+)/)?.[1];
      return rows.filter((row) => row.mergedAt >= from && (!until || row.mergedAt < until)).slice(0, Number(args[args.indexOf('--limit') + 1]));
    };
    const exact = await cli([], all.slice(0, 400), { pages: pages(all.slice(0, 400)) });
    expect(exact.stderr).toEqual([]);
    const overflow = await cli([], all, { pages: pages(all) });
    expect(overflow.stderr).toEqual(['⚠ 병합 PR 400개 상한: 목록이 잘렸을 수 있다']);
    expect(overflow.calls.some(({ args }) => args.includes('401'))).toBe(true);
  });

  test('gh failure is exit 1 with reason, never writes ledger', async () => {
    const result = await cli([], merges, { status: 1, stderr: 'authentication required' });
    expect(result.exitCode).toBe(1);
    expect(result.reads).toBe(1);
    expect(result.stderr).toEqual(['⛔ 병합 PR 조회(gh) 실패 rc=1: authentication required']);
  });
});

// ── LANDED-YELLOW-FAST · 출력 불변 ⊕ 단계 속도 ────────────────────────────────────────────────
// The pre-index matcher, verbatim (2026-10-21 · abcbbf255d). The indexed one must return the same rows.
function referenceLandedButYellow(items: readonly ChecklistItem[], prs: readonly MergedChecklistPr[], { owner }: { owner?: string } = {}) {
  const rows: ReturnType<typeof landedButYellow> = [];
  for (const item of items) {
    if (item.status !== 'yellow' && item.status !== 'red') continue;
    if (owner !== undefined && !checklist.ownerMatches(item.owner, owner)) continue;
    const id = item.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = new RegExp(`(?<![A-Za-z0-9])${id}(?![A-Za-z0-9])`);
    const shortId = /^[A-Z]{1,2}\d{1,2}[a-z]?$/.test(item.id);
    const titleStart = shortId
      ? new RegExp(`^${id}(?:$|\\s+(?:수확|(?:첫|둘째|셋째)\\s*조각|fixed|new|old)(?=\\s|:|$))`)
      : new RegExp(`^${id}(?:\\s|$)`);
    const explicitTitle = new RegExp(`(?<![A-Za-z0-9])${id}\\s+(?:수확|(?:첫|둘째|셋째)\\s*조각)(?![A-Za-z0-9가-힣])|\\(${id}\\)`);
    const rank = { 'cell-line': 0, 'title-strong': 1, mention: 2 } as const;
    const matched = prs.flatMap((pr) => {
      const cellLine = (pr.body ?? '').split('\n').some((line) => {
        const match = /^[ \t]*칸(?:[ \t]*:[ \t]*|[ \t]+)([A-Za-z0-9_-]+(?:[ \t]*,[ \t]*[A-Za-z0-9_-]+)*)[ \t]*$/.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
        return match?.[1]?.split(',').some((candidate) => candidate.trim() === item.id) ?? false;
      });
      const basis = cellLine ? 'cell-line' as const
        : titleStart.test(pr.title) || explicitTitle.test(pr.title) ? 'title-strong' as const
          : !shortId && (word.test(pr.title) || word.test(pr.body ?? '')) ? 'mention' as const : undefined;
      return basis ? [{ number: pr.number, title: pr.title, mergedAt: pr.mergedAt, basis }] : [];
    }).sort((a, b) => rank[a.basis] - rank[b.basis] || b.mergedAt.localeCompare(a.mergedAt) || b.number - a.number);
    if (!matched.length) continue;
    const shown = matched.slice(0, 5);
    rows.push({
      id: item.id, owner: item.owner, status: item.status, prs: shown,
      alreadyInEvidence: shown.map(({ number }) => new RegExp(`(?<![A-Za-z0-9_#])#${number}(?![A-Za-z0-9_])`).test(item.evidence ?? '')),
      newer: matched.some((p) => p.mergedAt > item.updatedAt),
    });
  }
  return rows.sort((a, b) => Number(b.newer) - Number(a.newer));
}

/** Deterministic corpus: short/long/dashed/underscored/dotted/non-alnum-leading ids against every match shape. */
function corpus(prCount: number) {
  let seed = 7;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const ids = ['W3', 'W3d', 'R1', 'AB12c', 'LANDED-YELLOW-FAST', 'LANDED-YELLOW', 'MOCK_B-FLEET', 'v0.2-GATE', '_HIDDEN', 'X-1', 'CL-AUTO', 'Q9', 'TA', 'SEAMS-2'];
  const items = ids.map((id, i) => item(id, i % 5 === 4 ? 'green' : i % 3 === 0 ? 'red' : 'yellow', { owner: i % 2 ? 'UX' : 'TC', updatedAt: `2026-10-0${1 + (i % 8)}T0${i % 10}:00:00Z`, evidence: i % 4 === 0 ? `#${100 + i} · ##${101 + i} · #${102 + i}abc` : undefined }));
  const shapes = [
    (id: string) => ({ title: `${id} fixed`, body: '' }),
    (id: string) => ({ title: 'misc', body: `## 칸\n칸: ${id}\n` }),
    (id: string) => ({ title: 'misc', body: `칸: OTHER, ${id}\r\nmore` }),
    (id: string) => ({ title: 'misc', body: `  칸 ${id}  ` }),
    (id: string) => ({ title: `[TC] (${id}) 착지`, body: '' }),
    (id: string) => ({ title: `x ${id} 첫 조각`, body: '' }),
    (id: string) => ({ title: 'misc', body: `see ${id}, also ${id}x and x${id}` }),
    (id: string) => ({ title: `${id}수확`, body: '' }),
    (id: string) => ({ title: `pre-${id}-post`, body: `칸: ${id}-NOT` }),
    (id: string) => ({ title: `${id}`, body: `> 칸: ${id}` }),
    (id: string) => ({ title: 'misc', body: `\`${id}\` mentioned` }),
    () => ({ title: 'unrelated work', body: 'nothing to see\r\n칸: NOPE' }),
  ];
  const prs = Array.from({ length: prCount }, (_, i) => {
    const shape = shapes[rand(shapes.length)]!(ids[rand(ids.length)]!);
    return pr(100 + i, shape.title, shape.body, `2026-10-0${1 + rand(9)}T${String(rand(24)).padStart(2, '0')}:00:00Z`);
  });
  return { items, prs };
}

describe('LANDED-YELLOW-FAST — indexed matcher is byte-identical to the pre-index matcher', () => {
  test('every owner filter returns the same rows in the same order (JSON bytes)', () => {
    const { items, prs } = corpus(600);
    for (const owner of [undefined, 'UX', 'TC']) {
      const expected = JSON.stringify(referenceLandedButYellow(items, prs, { owner }));
      expect(JSON.stringify(landedButYellow(items, prs, { owner }))).toBe(expected);
    }
    // Reusing one PR list across versions reuses its index and still answers each item set exactly.
    const subset = items.slice(3, 9);
    expect(JSON.stringify(landedButYellow(subset, prs))).toBe(JSON.stringify(referenceLandedButYellow(subset, prs)));
    expect(JSON.parse(JSON.stringify(landedButYellow(items, prs))).length).toBeGreaterThan(5);
  });

  test('null bodies and duplicate PR numbers keep the reference order', () => {
    const prs = [pr(5, 'W3 fixed'), { ...pr(5, 'W3 fixed'), body: null }, pr(6, 'LANDED-YELLOW-FAST', '칸: LANDED-YELLOW-FAST')];
    const items = [item('W3'), item('LANDED-YELLOW-FAST')];
    expect(JSON.stringify(landedButYellow(items, prs))).toBe(JSON.stringify(referenceLandedButYellow(items, prs)));
  });

  test('the indexed matcher reads only candidate PRs (deterministic access count), same bytes as the reference', () => {
    const { items, prs } = corpus(3000);
    const many = Array.from({ length: 20 }, () => items).flat().map((entry, i) => ({ ...entry, id: i < items.length ? entry.id : `${entry.id}${i % 7 ? '' : `-${i}`}` }));
    // Count element reads: the reference reads every PR for every open item; the index reads each PR once to build, then candidates only.
    const counted = (rows: MergedChecklistPr[]) => {
      let reads = 0;
      const proxy = new Proxy(rows, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
      return { proxy, reads: () => reads };
    };
    const reference = counted([...prs]);
    const expected = JSON.stringify(referenceLandedButYellow(many, reference.proxy));
    const indexed = counted([...prs]);
    const actual = JSON.stringify(landedButYellow(many, indexed.proxy));
    expect(actual).toBe(expected);
    const open = many.filter(({ status }) => status === 'yellow' || status === 'red').length;
    expect(reference.reads()).toBe(open * prs.length);
    expect(indexed.reads()).toBeLessThan(reference.reads() / 4);
  });

  test('an in-place change of the PR list (length or edge numbers) re-indexes instead of answering from a stale index', () => {
    const prs: MergedChecklistPr[] = [pr(1, 'misc')];
    const items = [item('LANDED-YELLOW-FAST')];
    expect(landedButYellow(items, prs)).toEqual([]);
    prs.push(pr(2, 'misc', '칸: LANDED-YELLOW-FAST'));
    expect(JSON.stringify(landedButYellow(items, prs))).toBe(JSON.stringify(referenceLandedButYellow(items, prs)));
    expect(landedButYellow(items, prs)[0]!.prs.map(({ number }) => number)).toEqual([2]);
  });
});

/** The pre-change sequential bisection (release-cli.ts mergedChecklistPrs · abcbbf255d) — the expected set. */
async function referenceFetch(since: string, now: Date, run: MergedPrRunner) {
  const fetch = async (lower: string, upper?: string, limit = 400) => {
    const r = await run('gh', ['pr', 'list', '--state', 'merged', '--search', `merged:>=${lower}${upper ? ` merged:<${upper}` : ''}`, '--limit', String(limit), '--json', 'number,title,body,mergedAt'], '.');
    return JSON.parse(r.stdout) as MergedChecklistPr[];
  };
  const unique = new Map<number, MergedChecklistPr>();
  let truncated = false;
  const first = await fetch(since);
  if (first.length < 400) return { prs: first, truncated };
  const lower = Date.parse(`${since}T00:00:00Z`);
  const upper = Math.max(lower + 1000, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const visit = async (start: number, end: number): Promise<void> => {
    const from = new Date(start).toISOString(), to = new Date(end).toISOString();
    const page = await fetch(from, to);
    if (page.length < 400) { for (const p of page) if (!unique.has(p.number)) unique.set(p.number, p); return; }
    if (end - start <= 1000) {
      const probe = await fetch(from, to, 401);
      for (const p of probe.slice(0, 400)) if (!unique.has(p.number)) unique.set(p.number, p);
      if (probe.length > 400) truncated = true;
      return;
    }
    const middle = start + Math.floor((end - start) / 2000) * 1000;
    await visit(start, middle);
    await visit(middle, end);
  };
  await visit(lower, upper);
  return { prs: [...unique.values()], truncated };
}

/** A gh that honours `merged:>=` / `merged:<` and `--limit`, newest first, after `delayMs`; records argv and peak concurrency. */
function windowedGh(all: MergedChecklistPr[], delayMs: number) {
  const argv: string[][] = [];
  let active = 0, peak = 0;
  const run: MergedPrRunner = async (_command, args) => {
    argv.push([...args]);
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    active--;
    const search = args[args.indexOf('--search') + 1]!;
    const from = search.match(/merged:>=(\S+)/)![1]!;
    const until = search.match(/merged:<(\S+)/)?.[1];
    const fromMs = Date.parse(from.length === 10 ? `${from}T00:00:00Z` : from);
    const untilMs = until ? Date.parse(until) : Infinity;
    const rows = all.filter((row) => Date.parse(row.mergedAt) >= fromMs && Date.parse(row.mergedAt) < untilMs)
      .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || b.number - a.number)
      .slice(0, Number(args[args.indexOf('--limit') + 1]));
    return { status: 0, stdout: JSON.stringify(rows), stderr: '' };
  };
  return { run, argv, peak: () => peak };
}

describe('LANDED-YELLOW-FAST — merged PR fetch', () => {
  // 21 days × ~170 merges/day ≈ the 10-21 prod shape (3,276 PRs since 10-01): the first page is full.
  const now = new Date('2026-10-21T10:00:00Z');
  const all = Array.from({ length: 3600 }, (_, i) => pr(10_000 + i, i % 97 === 0 ? 'LANDED-YELLOW-FAST fixed' : `work ${i}`, i % 89 === 0 ? '칸: W3' : 'body',
    new Date(Date.parse('2026-10-01T00:00:00Z') + Math.floor(i * (20.9 * 86_400_000) / 3600)).toISOString().replace('.000Z', 'Z')));
  const byNumber = (rows: MergedChecklistPr[]) => [...rows].sort((a, b) => a.number - b.number);

  test('same PR set and truncation flag as the sequential bisection, fewer calls, bounded parallel (deterministic counts)', async () => {
    const delay = 20;
    const reference = windowedGh(all, delay);
    let at = performance.now();
    const before = await referenceFetch('2026-10-01', now, reference.run);
    const beforeMs = performance.now() - at;
    const current = windowedGh(all, delay);
    at = performance.now();
    const after = await fetchMergedChecklistPrs('2026-10-01', now, current.run, '.');
    const afterMs = performance.now() - at;
    expect(byNumber(after.prs)).toEqual(byNumber(before.prs));
    expect(after.prs).toHaveLength(3600);
    expect(after.truncated).toBe(before.truncated);
    expect(after.calls).toBe(current.argv.length);
    // The first call is unchanged — the small-range fast path keeps its exact argv.
    expect(current.argv[0]).toEqual(reference.argv[0]!);
    expect(current.argv.length).toBeLessThan(reference.argv.length);
    expect(current.peak()).toBe(MERGED_PR_CONCURRENCY);
    expect(reference.peak()).toBe(1);
    expect(before.prs.length).toBeGreaterThanOrEqual(MERGED_PR_LIMIT);
    // Generous ceilings only — the counts above are the verdict; wall time just guards a hang.
    expect(beforeMs).toBeLessThan(60_000);
    expect(afterMs).toBeLessThan(60_000);
    // Rows the CLI prints from either set are byte-identical.
    const items = [item('LANDED-YELLOW-FAST', 'yellow', { updatedAt: '2026-10-01T00:00:00Z' }), item('W3', 'red')];
    expect(JSON.stringify(landedButYellow(items, after.prs))).toBe(JSON.stringify(referenceLandedButYellow(items, before.prs)));
  }, 30_000);

  test('an injected concurrency cap bounds the pool and returns the same set', async () => {
    const gh = windowedGh(all, 5);
    const capped = await fetchMergedChecklistPrs('2026-10-01', now, gh.run, '.', { concurrency: 2 });
    expect(gh.peak()).toBe(2);
    expect(byNumber(capped.prs)).toEqual(byNumber(all));
    const serial = windowedGh(all, 1);
    await fetchMergedChecklistPrs('2026-10-01', now, serial.run, '.', { concurrency: 1 });
    expect(serial.peak()).toBe(1);
  });

  test('a full one-second window still probes 401 and flags truncation', async () => {
    const crowded = Array.from({ length: 401 }, (_, i) => pr(i + 1, 'W3', '', '2026-10-03T02:00:00Z'));
    const gh = windowedGh(crowded, 1);
    const result = await fetchMergedChecklistPrs('2026-10-03', new Date('2026-10-04T04:00:00Z'), gh.run, '.');
    expect(result.truncated).toBe(true);
    expect(result.prs).toHaveLength(400);
    expect(gh.argv.some((args) => args.includes('401'))).toBe(true);
    const exact = await fetchMergedChecklistPrs('2026-10-03', new Date('2026-10-04T04:00:00Z'), windowedGh(crowded.slice(0, 400), 1).run, '.');
    expect(exact.truncated).toBe(false);
  });

  test('one failing window rejects with the gh reason and starts no new calls after it', async () => {
    const gh = windowedGh(all, 20);
    let seen = 0;
    const failing: MergedPrRunner = async (command, args, cwd) => {
      seen++;
      if (seen === 3) return { status: 1, stdout: '', stderr: 'API rate limit exceeded' };
      return gh.run(command, args, cwd);
    };
    await expect(fetchMergedChecklistPrs('2026-10-01', now, failing, '.')).rejects.toThrow('병합 PR 조회(gh) 실패 rc=1: API rate limit exceeded');
    expect(seen).toBeLessThanOrEqual(1 + 6 + 1);
  });

  test('CLI on a fake gh (fake-bin · 300 merged PRs · 1s per call) prints the same JSON within 15s and logs stage timings', async () => {
    const items = [item('LANDED-YELLOW-FAST', 'yellow', { updatedAt: '2026-10-01T00:00:00Z' }), item('W3', 'red'), item('G1', 'green')];
    const page = all.slice(0, 300);
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    const debugLog = spyOn(debug, 'log').mockImplementation((category, event, data) => { events.push({ category, event, data }); });
    const written: string[] = [];
    const cacheDir = mkdtempSync(join(tmpdir(), 'landed-cli-cache-'));
    const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: unknown) => {
      written.push(String(chunk));
      if (typeof callback === 'function') callback();
      return true;
    }) as typeof process.stdout.write);
    const started = performance.now();
    try {
      await withFakeBins({ gh: { stdout: JSON.stringify(page), sleepSeconds: 1 } }, async (bins) => {
        const program = new Command();
        registerReleaseCommands(program, {}, {
          checklist: (version) => ({ version, dev: version, released: '', items, history: [] }),
          now: () => now,
          schedules: () => [],
          released: () => '',
          registerLogSink: async () => {},
          mergedPrCacheFile: () => join(cacheDir, 'cache.json'),
        });
        await program.parseAsync(['release', 'checklist', 'landed-but-yellow', '--version', '0.2.12', '--json'], { from: 'user' });
        expect(bins.calls()).toEqual([{ name: 'gh', argv: ['pr', 'list', '--state', 'merged', '--search', 'merged:>=2026-10-01', '--limit', '400', '--json', 'number,title,body,mergedAt'] }]);
      });
    } finally { write.mockRestore(); debugLog.mockRestore(); rmSync(cacheDir, { recursive: true, force: true }); }
    expect(performance.now() - started).toBeLessThan(60_000);
    expect(process.exitCode ?? 0).toBe(0);
    expect(written.join('')).toBe(`${JSON.stringify(referenceLandedButYellow(items, page))}\n`);
    const stages = events.filter(({ category, event }) => category === 'release.landed-yellow' && event === 'stage').map(({ data }) => (data as { stage: string }).stage);
    expect(stages).toEqual(['snapshots', 'merged-prs', 'match']);
    expect(events).toContainEqual(expect.objectContaining({ category: 'release.landed-yellow', data: expect.objectContaining({ stage: 'merged-prs', n: 300, calls: 1 }) }));
  }, 90_000);

  test('gh missing from PATH: the async runner reports rc=null with the spawn error, like the sync runner did', async () => {
    const stderr: string[] = [];
    const error = spyOn(console, 'error').mockImplementation((line) => { stderr.push(String(line)); });
    const debugLog = spyOn(debug, 'log').mockImplementation(() => {});
    const previousPath = process.env.PATH;
    const empty = mkdtempSync(join(tmpdir(), 'landed-no-gh-'));
    process.env.PATH = empty;
    try {
      const program = new Command();
      registerReleaseCommands(program, {}, {
        checklist: (version) => ({ version, dev: version, released: '', items: [item('W3')], history: [] }),
        now: () => now, schedules: () => [], released: () => '', registerLogSink: async () => {},
      });
      await program.parseAsync(['release', 'checklist', 'landed-but-yellow', '--version', '0.2.12', '--json'], { from: 'user' });
    } finally {
      process.env.PATH = previousPath;
      error.mockRestore(); debugLog.mockRestore();
      rmSync(empty, { recursive: true, force: true });
    }
    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveLength(1);
    // Same error text as the old spawnSync runner (Bun: «Executable not found»; Node: ENOENT). The old runner printed
    // `rc=undefined` here because Bun's spawnSync leaves status undefined on a spawn error; null is the documented RunResult value.
    expect(stderr[0]).toMatch(/^⛔ 병합 PR 조회\(gh\) 실패 rc=null: Error: (?:Executable not found in \$PATH: "gh"|.*ENOENT)/);
  });
});

// ── GREEN-SCAN-LANDED-CACHE · 완료 경계: 같은 입력 두 번은 캐시, 시간 상한은 부분 결과 ─────────────
describe('GREEN-SCAN-LANDED-CACHE — 같은 입력 두 번은 캐시로 끝나고, 시간 상한은 부분 결과를 낸다', () => {
  const now = new Date('2026-10-21T10:00:00Z');
  // 21 days × ~170 merges/day: the first page is full, so the windowed walk runs (the 10-21 prod shape).
  const many = Array.from({ length: 3600 }, (_, i) => pr(20_000 + i, i % 97 === 0 ? 'GREEN-SCAN-LANDED-CACHE fixed' : `work ${i}`, i % 89 === 0 ? '칸: CL-AUTO' : 'body',
    new Date(Date.parse('2026-10-01T00:00:00Z') + Math.floor(i * (20.9 * 86_400_000) / 3600)).toISOString().replace('.000Z', 'Z')));
  const board = (version: string, id: string): Checklist =>
    ({ version, released: '0.2.12', dev: version, items: [item(id, 'yellow', { updatedAt: '2026-10-01T00:00:00Z' })], history: [] });
  const boards = [board('0.2.13', 'CL-AUTO'), board('0.2.15', 'CL-NEXT')];
  const merged = [pr(301, 'misc', '칸: CL-AUTO'), pr(302, 'CL-NEXT fixed'), pr(303, 'CL-AUTO 수확'), pr(304, 'noise', 'nothing here')];
  const depsWith = (runAsync: MergedPrRunner, cacheFile?: string): LandedButYellowDeps => ({
    runAsync,
    checklist: (version) => boards.find((entry) => entry.version === version)!,
    now: () => now,
    schedules: () => boards.map(({ version }) => ({ version, cutAt: '', landBy: null, updatedAt: '', updatedBy: '' })),
    released: () => '0.2.12',
    registerLogSink: async () => {},
    ...(cacheFile ? { mergedPrCacheFile: () => cacheFile } : {}),
  });
  const capture = () => {
    const written: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: unknown) => {
      written.push(String(chunk)); if (typeof callback === 'function') callback(); return true;
    }) as typeof process.stdout.write);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const debugLog = spyOn(debug, 'log').mockImplementation(() => {});
    return { written, restore: () => { write.mockRestore(); log.mockRestore(); error.mockRestore(); debugLog.mockRestore(); } };
  };
  const parse = async (deps: LandedButYellowDeps, ...args: string[]) => {
    const program = new Command();
    registerReleaseCommands(program, {}, deps);
    await program.parseAsync(['release', 'checklist', 'landed-but-yellow', ...args], { from: 'user' });
  };

  test('fetch 재호출(같은 runner·같은 입력)은 gh 호출 0 · 결과 일치', async () => {
    const gh = windowedGh(many, 1);
    const cacheDir = mkdtempSync(join(tmpdir(), 'landed-yellow-cache-'));
    const cacheFile = join(cacheDir, 'cache.json');
    const first = await fetchMergedChecklistPrs('2026-10-01', now, gh.run, '.', { cacheFile });
    const callsAfterFirst = gh.argv.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const second = await fetchMergedChecklistPrs('2026-10-01', now, gh.run, '.', { cacheFile });
    expect(gh.argv.length).toBe(callsAfterFirst);
    expect(second).toEqual({ ...first, calls: 0 });
    expect(second.stopReason).toBeUndefined();
    expect(second.remainingWindows).toEqual([]);
    rmSync(cacheDir, { recursive: true, force: true });
  }, 30_000);

  test('GH_REPO 가 바뀌면 같은 cwd·입력이어도 다른 저장소 캐시를 쓰지 않는다', async () => {
    const gh = windowedGh(many, 1);
    const cacheDir = mkdtempSync(join(tmpdir(), 'landed-yellow-repo-cache-'));
    const cacheFile = join(cacheDir, 'cache.json');
    const previous = process.env.GH_REPO;
    try {
      process.env.GH_REPO = 'owner/first';
      const first = await fetchMergedChecklistPrs('2026-10-01', now, gh.run, '.', { cacheFile });
      const firstCalls = gh.argv.length;
      process.env.GH_REPO = 'owner/second';
      const second = await fetchMergedChecklistPrs('2026-10-01', now, gh.run, '.', { cacheFile });
      expect(second.calls).toBeGreaterThan(0);
      expect(gh.argv.length).toBeGreaterThan(firstCalls);
      expect(second).toEqual(first);
    } finally {
      if (previous === undefined) delete process.env.GH_REPO; else process.env.GH_REPO = previous;
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('별도 CLI 프로세스는 fake gh의 여러 판 조회 뒤 10분 캐시를 재사용한다', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'landed-yellow-process-cache-'));
    const cacheFile = join(cacheDir, 'cache.json');
    const counterFile = join(cacheDir, 'calls.txt');
    const fakeBinDir = join(cacheDir, 'bin');
    mkdirSync(fakeBinDir);
    const fakeGh = join(fakeBinDir, 'gh');
    writeFileSync(fakeGh, '#!/bin/sh\nprintf x >> "$LANDED_YELLOW_CALLS"\nprintf "%s\\n" "$LANDED_YELLOW_PAGE"\n');
    chmodSync(fakeGh, 0o755);
    const page = JSON.stringify([
      { number: 11, title: 'CL-AUTO fixed', body: '', mergedAt: '2026-10-03T00:00:00Z' },
      { number: 12, title: 'CL-NEXT fixed', body: '', mergedAt: '2026-10-03T00:01:00Z' },
    ]);
    const cliUrl = new URL('../cli/release-cli.ts', import.meta.url).href;
    const script = `
      import { Command } from 'commander';
      import { registerReleaseCommands } from ${JSON.stringify(cliUrl)};
      const deps = { schedules: () => ['0.2.13','0.2.15'].map(version => ({ version, cutAt: '', landBy: null, updatedAt: '', updatedBy: '' })), released: () => '0.2.12', now: () => new Date('2026-10-04T09:00:00Z'), mergedPrCacheFile: () => process.env.LANDED_YELLOW_CACHE, checklist: version => ({ version, released: '0.2.12', dev: version, items: [{ id: version === '0.2.13' ? 'CL-AUTO' : 'CL-NEXT', title: 'test', owner: 'MK', status: 'yellow', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'MK' }], history: [] }) };
      const program = new Command();
      registerReleaseCommands(program, {}, deps);
      await program.parseAsync(['release','checklist','landed-but-yellow','--open','--json'], { from: 'user' });
    `;
    const run = () => spawnSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`, LANDED_YELLOW_CACHE: cacheFile, LANDED_YELLOW_CALLS: counterFile, LANDED_YELLOW_PAGE: page } });
    try {
      const first = run();
      expect(first.status).toBe(0);
      const firstRows = JSON.parse(first.stdout) as Array<{ version: string; rows: Array<{ id: string; prs: Array<{ number: number }> }> }>;
      expect(firstRows.map(({ version }) => version)).toEqual(['0.2.13', '0.2.15']);
      expect(firstRows.find(({ version }) => version === '0.2.13')!.rows.find(({ id }) => id === 'CL-AUTO')!.prs.map(({ number }) => number)).toContain(11);
      expect(firstRows.find(({ version }) => version === '0.2.15')!.rows.find(({ id }) => id === 'CL-NEXT')!.prs.map(({ number }) => number)).toContain(12);
      const second = run();
      expect(second.status).toBe(0);
      expect(JSON.parse(second.stdout)).toEqual(JSON.parse(first.stdout));
      expect(readFileSync(counterFile, 'utf8')).toBe('x');
    } finally { rmSync(cacheDir, { recursive: true, force: true }); }
  }, 30_000);

  test('시간 상한: 창 조회 중 넘으면 부분 결과 ⊕ stopReason ⊕ 남은 판', async () => {
    const gh = windowedGh(many, 50);
    const cacheDir = mkdtempSync(join(tmpdir(), 'landed-yellow-partial-cache-'));
    const cacheFile = join(cacheDir, 'cache.json');
    try {
      const result = await fetchMergedChecklistPrs('2026-10-01', now, gh.run, '.', { timeBudgetMs: 120, cacheFile });
      expect(result.stopReason).toBe('time-budget-exceeded');
      expect(result.remainingWindows.length).toBeGreaterThan(0);
      expect(result.remainingWindows).toEqual([...result.remainingWindows].sort());
      expect(result.prs.length).toBeGreaterThan(0);
      expect(result.prs.length).toBeLessThan(many.length);
      expect(result.calls).toBeLessThan(22);
      const callsAfterPartial = gh.argv.length;
      const next = await fetchMergedChecklistPrs('2026-10-01', now, gh.run, '.', { timeBudgetMs: 120, cacheFile });
      expect(next.stopReason).toBe('time-budget-exceeded');
      expect(gh.argv.length).toBeGreaterThan(callsAfterPartial); // 부분 결과를 완전 결과 캐시에 쓰지 않는다
    } finally { rmSync(cacheDir, { recursive: true, force: true }); }
  }, 30_000);

  test('시간 상한은 첫 광역 gh 조회도 끊고 남은 UTC 창을 돌려준다', async () => {
    let calls = 0;
    const slowFirstPage: MergedPrRunner = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { status: 0, stdout: JSON.stringify(many), stderr: '' };
    };
    const started = performance.now();
    const result = await fetchMergedChecklistPrs('2026-10-01', now, slowFirstPage, '.', { timeBudgetMs: 30 });
    expect(performance.now() - started).toBeLessThan(150);
    expect(calls).toBe(1);
    expect(result.calls).toBe(1);
    expect(result.prs).toEqual([]);
    expect(result.stopReason).toBe('time-budget-exceeded');
    expect(result.remainingWindows.length).toBeGreaterThan(0);
  });

  test('광역 조회에서 받은 400건은 뒤 창 조회가 시간초과여도 부분 결과에 보존한다', async () => {
    let calls = 0;
    const slowWindows: MergedPrRunner = async (_command, args) => {
      calls++;
      if (!args.includes('--search') || args[args.indexOf('--search') + 1] === 'merged:>=2026-10-01') {
        return { status: 0, stdout: JSON.stringify(many.slice(0, MERGED_PR_LIMIT)), stderr: '' };
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { status: 0, stdout: JSON.stringify(many.slice(0, MERGED_PR_LIMIT)), stderr: '' };
    };
    const result = await fetchMergedChecklistPrs('2026-10-01', now, slowWindows, '.', { concurrency: 1, timeBudgetMs: 30 });
    expect(calls).toBeGreaterThan(1);
    expect(result.stopReason).toBe('time-budget-exceeded');
    expect(result.prs.map(({ number }) => number)).toEqual(many.slice(0, MERGED_PR_LIMIT).map(({ number }) => number));
    expect(result.truncated).toBe(true);
    expect(result.remainingWindows.length).toBeGreaterThan(0);
  });

  test('CLI 첫 gh 프로세스가 멈추면 상한 안에 부분 JSON을 내고 gh를 종료한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'landed-yellow-timeout-cli-'));
    const fakeBinDir = join(root, 'bin');
    mkdirSync(fakeBinDir);
    const fakeGh = join(fakeBinDir, 'gh');
    writeFileSync(fakeGh, '#!/bin/sh\ntrap "" TERM\nexec sleep 10\n');
    chmodSync(fakeGh, 0o755);
    const cliUrl = new URL('../cli/release-cli.ts', import.meta.url).href;
    const script = `
      import { Command } from 'commander';
      import { registerReleaseCommands } from ${JSON.stringify(cliUrl)};
      const program = new Command();
      registerReleaseCommands(program, {}, { checklist: version => ({ version, released: '0.2.12', dev: version, items: [{ id: 'CL-AUTO', title: 'test', owner: 'MK', status: 'yellow', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'MK' }], history: [] }), now: () => new Date('2026-10-04T09:00:00Z'), schedules: () => [], released: () => '0.2.12' });
      await program.parseAsync(['release','checklist','landed-but-yellow','--version','0.2.13','--limit','30','--json'], { from: 'user' });
    `;
    const started = performance.now();
    try {
      const result = spawnSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH ?? ''}` } });
      expect(result.status).toBe(0);
      expect(performance.now() - started).toBeLessThan(3_000);
      const partial = JSON.parse(result.stdout) as { results: unknown[]; stopReason: string; remainingVersions: string[]; remainingWindows: string[] };
      expect(partial.stopReason).toBe('time-budget-exceeded');
      expect(partial.results).toHaveLength(1);
      expect(partial.remainingVersions).toEqual(['0.2.13']);
      expect(partial.remainingWindows.length).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('CLI --open --json 같은 입력 두 번: 둘째 호출은 gh 호출 0 · JSON 결과 일치', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'landed-yellow-cli-cache-'));
    let ghCalls = 0;
    const runAsync: MergedPrRunner = async () => {
      ghCalls++;
      return { status: 0, stdout: JSON.stringify(merged), stderr: '' };
    };
    const deps = depsWith(runAsync, join(cacheDir, 'cache.json'));
    const cap = capture();
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      await parse(deps, '--open', '--json');
      const first = cap.written.join('');
      expect(ghCalls).toBe(1);
      cap.written.length = 0;
      await parse(deps, '--open', '--json');
      expect(ghCalls).toBe(1);
      expect(cap.written.join('')).toBe(first);
      const rows = JSON.parse(first) as Array<{ version: string; rows: Array<{ id: string }> }>;
      expect(rows.map(({ version }) => version)).toEqual(['0.2.13', '0.2.15']);
      expect(rows[0]!.rows.map((row) => row.id)).toEqual(['CL-AUTO']);
      expect(rows[1]!.rows.map((row) => row.id)).toEqual(['CL-NEXT']);
      expect(process.exitCode).toBe(0);
    } finally { cap.restore(); process.exitCode = previous ?? 0; rmSync(cacheDir, { recursive: true, force: true }); }
  }, 30_000);

  test('지연 gh + --time-budget: 부분 결과 · stopReason · 미완료 판과 남은 UTC 창을 JSON 에 실는다', async () => {
    const gh = windowedGh(many, 50);
    const deps = depsWith(gh.run);
    const cap = capture();
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      await parse(deps, '--open', '--json', '--time-budget', '120');
      const parsed = JSON.parse(cap.written.join('')) as { results: Array<{ version: string; rows: Array<{ prs: Array<{ number: number }> }> }>; stopReason?: string; remainingVersions?: string[]; remainingWindows?: string[] };
      expect(parsed.stopReason).toBe('time-budget-exceeded');
      expect(parsed.remainingVersions).toEqual(['0.2.13', '0.2.15']);
      expect(parsed.remainingWindows!.length).toBeGreaterThan(0);
      expect(parsed.results).toHaveLength(2);
      expect(parsed.results.flatMap(({ rows }) => rows.flatMap(({ prs }) => prs.map(({ number }) => number)))).toContain(23560);
      expect(gh.argv.length).toBeLessThan(22);
    } finally { cap.restore(); process.exitCode = previous ?? 0; }
  }, 30_000);
});
