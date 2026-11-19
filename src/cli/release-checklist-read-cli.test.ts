import { expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { collectChecklistEvidenceStages, registerChecklistReadCommands, type ChecklistEvidenceCommandRunner, type StaleChecklistSweep } from './release-checklist-read-cli.js';
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

test('E1 treats only explicit PR forms as PR refs — bare seat-mail #<digits> is not a PR (OP #105708)', () => {
  // 리터럴 출처(2026-11-19): OP #105708 «우편 #105111 → PR 아님 · PR #39100 → PR» · BADGE 칸 E1 오염 관측(«JUD-B #104594» 우편 인용 혼입) · #39100 merge sha a08ee5dd66739525e38a5b4159cffeb8ad74f5c0(gh pr view 39100)
  const run: ChecklistEvidenceCommandRunner = (command, args) =>
    command === 'eln' && args[0] === 'gh' && args[1] === 'pr'
      ? { status: 0, stdout: '{"state":"MERGED","mergeCommit":{"oid":"a08ee5dd66739525e38a5b4159cffeb8ad74f5c0"}}\n', stderr: '' }
      : { status: 1, stdout: '', stderr: '' };
  const item = { id: 'ELS-UNREAD-MAIL-BADGE', title: 'ELS-UNREAD-MAIL-BADGE', status: 'yellow', updatedAt: '2026-11-19T14:00:00.000Z', updatedBy: 'TC-H-POOL-2',
    evidence: '우편 #105111 재배달 관측 · JUD-B #104594·#104595 독립 대조\nPR #39100 a08ee5dd66739525e38a5b4159cffeb8ad74f5c0 merged' } satisfies ChecklistItem;
  const e1 = collectChecklistEvidenceStages(item, run).find((stage) => stage.id === 'E1');
  expect(e1?.state).toBe('observed');
  expect(String(e1?.source)).toContain('#39100');
});

test('E1 reports no PR when evidence carries only bare #<digits> references', () => {
  // 리터럴 출처(2026-11-19): 세 칸 23:27 재측정 greenEligible=false — E1 «하나로 좁혀지지 않는다»(# 우편 번호 혼입) · OP #105708: 맨 «#N»은 PR 아님
  const item = { id: 'SEAT-MAIL-ACK-SLA', title: 'SEAT-MAIL-ACK-SLA', status: 'yellow', updatedAt: '2026-11-19T14:00:00.000Z', updatedBy: 'TC-H-POOL-2',
    evidence: '우편 #105111 회신 · #104893·#105051 인용 · 4e4397eb9f205533b93188386c4920c9dbda04e2' } satisfies ChecklistItem;
  const e1 = collectChecklistEvidenceStages(item, () => { throw new Error('unexpected external command'); }).find((stage) => stage.id === 'E1');
  expect(e1?.state).toBe('missing');
  expect(e1?.reason).toBe('근거에 병합 PR 번호가 없다');
});

test('E1 accepts pull/N and landed-commit «(#N)» citation forms with same-line merge sha', () => {
  // 리터럴 출처(2026-11-19): #39092 merge sha edf2ca1d43b9c0b1aa4a5d5940933113078cb6b4(gh pr view 39092) · #39044 merge sha 29bc963d4abdb3f70d24da3194a2970b8c207e07(gh pr view 39044 · S7+ ⑦)
  const run: ChecklistEvidenceCommandRunner = (command, args) => {
    if (command !== 'eln' || args[0] !== 'gh' || args[1] !== 'pr') return { status: 1, stdout: '', stderr: '' };
    const sha = args.includes('39092') ? 'edf2ca1d43b9c0b1aa4a5d5940933113078cb6b4' : '29bc963d4abdb3f70d24da3194a2970b8c207e07';
    return { status: 0, stdout: `{"state":"MERGED","mergeCommit":{"oid":"${sha}"}}\n`, stderr: '' };
  };
  const pull = { id: 'SIM-WORLD-SEAT-MAIL', title: 'SIM-WORLD-SEAT-MAIL', status: 'yellow', updatedAt: '2026-11-19T14:00:00.000Z', updatedBy: 'TC-H-POOL-2',
    evidence: 'pull/39092 edf2ca1d43b9c0b1aa4a5d5940933113078cb6b4 merged' } satisfies ChecklistItem;
  const commit = { id: 'SEAT-MAIL-ACK-SLA', title: 'SEAT-MAIL-ACK-SLA', status: 'yellow', updatedAt: '2026-11-19T14:00:00.000Z', updatedBy: 'TC-H-POOL-2',
    evidence: '착지 커밋 (#39044) 29bc963d4abdb3f70d24da3194a2970b8c207e07' } satisfies ChecklistItem;
  expect(collectChecklistEvidenceStages(pull, run).find((stage) => stage.id === 'E1')?.state).toBe('observed');
  expect(collectChecklistEvidenceStages(commit, run).find((stage) => stage.id === 'E1')?.state).toBe('observed');
});

test('E1 binds the merge sha on any PR-citation line — pre-merge progress line no longer blocks (SIM-WORLD 23:58 사례)', () => {
  // 리터럴 출처(2026-11-20): SIM-WORLD-SEAT-MAIL 23:58 재측정 E1 missing «병합 PR #39044와 merge SHA가 같은 근거 줄에서 결속되지 않았다» — 19:57 «진행: PR #39044 / 착수 2026-11-19T09:19:12Z» 줄이 첫 PR 인용 줄이라 23:58 sha 결속 줄(PR #39044 29bc963d4abdb3f70d24da3194a2970b8c207e07 MERGED)이 무시됨 · gh pr view 39044
  const run: ChecklistEvidenceCommandRunner = (command, args) =>
    command === 'eln' && args[0] === 'gh' && args[1] === 'pr'
      ? { status: 0, stdout: '{"state":"MERGED","mergeCommit":{"oid":"29bc963d4abdb3f70d24da3194a2970b8c207e07"}}\n', stderr: '' }
      : { status: 1, stdout: '', stderr: '' };
  const item = { id: 'SIM-WORLD-SEAT-MAIL', title: 'SIM-WORLD-SEAT-MAIL', status: 'yellow', updatedAt: '2026-11-19T15:00:00.000Z', updatedBy: 'TC-H-POOL-2',
    evidence: '진행: PR #39044 / 착수 2026-11-19T09:19:12Z · merge SHA 확정 후 기입 예정\nPR #39044 29bc963d4abdb3f70d24da3194a2970b8c207e07 MERGED 2026-11-19 19:50:17 KST' } satisfies ChecklistItem;
  const e1 = collectChecklistEvidenceStages(item, run).find((stage) => stage.id === 'E1');
  expect(e1?.state).toBe('observed');
  expect(String(e1?.source)).toContain('#39044');
});

test('E1 still fails when no PR-citation line carries the merge sha (progress line only)', () => {
  // 리터럴 출처(2026-11-20): sha 결속 줄이 없으면 여전히 missing — 이유 문구 불변(«결속되지 않았다»)
  const run: ChecklistEvidenceCommandRunner = (command, args) =>
    command === 'eln' && args[0] === 'gh' && args[1] === 'pr'
      ? { status: 0, stdout: '{"state":"MERGED","mergeCommit":{"oid":"29bc963d4abdb3f70d24da3194a2970b8c207e07"}}\n', stderr: '' }
      : { status: 1, stdout: '', stderr: '' };
  const item = { id: 'SIM-WORLD-SEAT-MAIL', title: 'SIM-WORLD-SEAT-MAIL', status: 'yellow', updatedAt: '2026-11-19T15:00:00.000Z', updatedBy: 'TC-H-POOL-2',
    evidence: '진행: PR #39044 / 착수 2026-11-19T09:19:12Z · merge SHA 확정 후 기입 예정' } satisfies ChecklistItem;
  const e1 = collectChecklistEvidenceStages(item, run).find((stage) => stage.id === 'E1');
  expect(e1?.state).toBe('missing');
  expect(e1?.reason).toBe('병합 PR #39044와 merge SHA가 같은 근거 줄에서 결속되지 않았다');
});
