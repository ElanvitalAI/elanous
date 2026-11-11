import { expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { registerChecklistReadCommands, type StaleChecklistSweep } from './release-checklist-read-cli.js';
import { collectStaleMergedChecklistProposals, findOpenChecklistPathMatches, type StaleMergedChecklistScan } from '../release-loop/merged-pr-checklist.js';
import type { ChecklistItem } from '../release-loop/checklist.js';
import { withIsolatedElanousRoot } from '../../test/helpers/with-test-home.js';

function cli(sweep: StaleChecklistSweep) {
  const program = new Command();
  program.exitOverride();
  const release = program.command('release');
  const checklist = release.command('checklist').option('--version <v>').option('--json');
  registerChecklistReadCommands(checklist, undefined, sweep);
  return program;
}

const scan: StaleMergedChecklistScan = {
  scannedMergedMainPrs: 1,
  scannedOpenPrs: 1,
  complete: true,
  incompletePrNumbers: [],
  openPathMatches: [{ id: 'CELL-OPEN', currentStatus: 'yellow', targetPaths: ['src/open.ts'], prs: [{ number: 36715,
    title: 'active work', author: 'ElanvitalAI', baseRefName: 'feat/stack', matchedPaths: ['src/open.ts'], changedPaths: ['src/open.ts'] }] }],
  proposals: [
    { id: 'CELL-A', status: 'proposed', proposalKind: 'target-path-repair', currentStatus: 'yellow',
      targetPaths: ['src/expected.ts'], prs: [{ number: 42, title: 'path moved', mergedAt: '2026-11-11T00:00:00Z',
        matchedPaths: [], changedPaths: ['src/actual.ts'], matchKind: 'cell-id-path-mismatch', cellIdMentioned: true,
        ambiguousWith: [], evidenceRef: '#42' }] },
    { id: 'CELL-B', status: 'proposed', proposalKind: 'green', currentStatus: 'yellow', targetPaths: ['src/shared.ts'],
      prs: [{ number: 43, title: 'path hit', mergedAt: '2026-11-11T00:00:00Z', matchedPaths: ['src/shared.ts'],
        changedPaths: ['src/shared.ts'], matchKind: 'target-path', cellIdMentioned: false, ambiguousWith: [], evidenceRef: '#43' }] },
  ],
};

test('release checklist stale-sweep JSON exposes complete proposals without mutating checklist state', async () => {
  let called = 0;
  const sweep: StaleChecklistSweep = (version, cwd) => {
    called += 1;
    expect(version).toBe('0.3.9');
    expect(cwd).toBe(process.cwd());
    return scan;
  };
  const stdout: string[] = [];
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    stdout.push(String(chunk)); callback?.(); return true;
  }) as typeof process.stdout.write);
  try {
    await cli(sweep).parseAsync(['release', 'checklist', 'stale-sweep', '--version', '0.3.9', '--json'], { from: 'user' });
    expect(JSON.parse(stdout.join(''))).toEqual({ version: '0.3.9', ...scan });
    expect(called).toBe(1);
  } finally { write.mockRestore(); }
});

test('open PR path sweep maps the expected duplicate-work examples without matching #36511', () => {
  // Source: OP #98690 named these four open PRs as the duplicate-work simulation fixture set.
  const cells: ChecklistItem[] = [
    { id: 'UX-SIM-LEDGER-SYNC', title: '대상 경로: docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md', status: 'yellow', updatedAt: '', updatedBy: 'OP' },
    { id: 'NEXT-TUI-BRANCH-HARNESS', title: '대상 경로: src/tui/entry.ts', status: 'yellow', updatedAt: '', updatedBy: 'OP' },
  ];
  const matches = findOpenChecklistPathMatches(cells, [
    { number: 36715, state: 'OPEN', baseRefName: 'main', title: 'receipt', body: '', mergedAt: '', author: { login: 'ElanvitalAI' }, files: [{ path: 'docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md' }] },
    { number: 36720, state: 'OPEN', baseRefName: 'feat/absorb3-kaist-browser-receipt-1111', title: 'extension', body: '', mergedAt: '', author: { login: 'ElanvitalAI' }, files: [{ path: 'docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md' }] },
    { number: 36563, state: 'OPEN', baseRefName: 'main', title: 'graph view', body: '', mergedAt: '', author: { login: 'app/elanous-automation-ElanvitalAI' }, files: [{ path: 'src/tui/entry.ts' }] },
    { number: 36511, state: 'OPEN', baseRefName: 'main', title: 'GCP plugin', body: '', mergedAt: '', author: { login: 'ElanvitalAI' }, files: [{ path: 'plugins/gcp-architect-expand/plugin.json' }] },
  ]);
  expect(matches.map(({ id, prs }) => [id, prs.map(({ number }) => number)])).toEqual([
    ['UX-SIM-LEDGER-SYNC', [36715, 36720]], ['NEXT-TUI-BRANCH-HARNESS', [36563]],
  ]);
  expect(matches[0]!.prs[1]).toMatchObject({ author: 'ElanvitalAI', baseRefName: 'feat/absorb3-kaist-browser-receipt-1111' });
});

test('release checklist stale-sweep text prints target and changed paths plus incomplete scan warning', async () => {
  // Source: the CLI cap is 1,000 merged PRs; reaching it is surfaced as incomplete.
  const partial = { ...scan, complete: false, scannedMergedMainPrs: 1_000 };
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
  try {
    await cli(() => partial).parseAsync(['release', 'checklist', 'stale-sweep', '--version', '0.3.9'], { from: 'user' });
    expect(lines.join('\n')).toContain('⚠ 불완전 조사');
    expect(lines.join('\n')).toContain('제안 상태: proposed(사람 검토 필요)');
    expect(lines.join('\n')).toContain('대상 경로: src/expected.ts');
    expect(lines.join('\n')).toContain('변경 경로: src/actual.ts');
    expect(lines.join('\n')).toContain('경로 일치만 · 셀 ID 미언급');
    expect(lines.join('\n')).toContain('CELL-OPEN · 현재 yellow · 열린 PR 경로 일치(중복 작업 확인): #36715@ElanvitalAI');
  } finally { log.mockRestore(); }
});

test('collector marks PRs with truncated changed-file lists incomplete and excludes them from proposals', async () => {
  await withIsolatedElanousRoot(async () => {
    const scan = collectStaleMergedChecklistProposals('0.3.9', '/repo', (cwd, args) => {
      expect(cwd).toBe('/repo');
      expect(args.some((argument) => argument.includes('changedFiles'))).toBe(true);
      // Source: one more than GitHub's 100-file nested PR list cap.
      return [{ number: 88, state: 'MERGED', baseRefName: 'main', title: 'CELL-A', body: 'CELL-A',
        mergedAt: '2026-11-11T00:00:00Z', files: [{ path: 'src/one.ts' }], changedFiles: 101 }];
    });
    expect(scan.complete).toBe(false);
    expect(scan.incompletePrNumbers).toEqual([88]);
    expect(scan.proposals.flatMap(({ prs }) => prs.map(({ number }) => number))).not.toContain(88);
  });
});

test('release checklist stale-sweep reports source lookup failures to the caller', async () => {
  await expect(cli(() => { throw new Error('GitHub unavailable'); })
    .parseAsync(['release', 'checklist', 'stale-sweep', '--version', '0.3.9'], { from: 'user' }))
    .rejects.toThrow('GitHub unavailable');
});
