import { afterAll, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { ELN_LOGS_PARTIAL_READ_EXIT, EvidenceRunLeaseRefused, collectChecklistEvidenceStages, remoteEvidenceEventObserved, nexusRegisteredHost, registerChecklistReadCommands, runChecklistEvidence, runInIsolatedUniverse, type ChecklistEvidenceCommandRunner, type ChecklistEvidenceRunDeps, type EvidenceSpawn, type StaleChecklistSweep } from './release-checklist-read-cli.js';
import { parseEvidenceReceipt, runEvidenceReceipt, type EvidenceDispatchOutcome, type EvidenceRunRequest, type RegistryHostEntry } from '../release-loop/checklist-evidence-run.js';
import { collectStaleMergedChecklistProposals, findOpenChecklistPathMatches, type StaleMergedChecklistScan } from '../release-loop/merged-pr-checklist.js';
import { CHECKLIST_EVIDENCE_RUN_EVENT, checklistEvidenceCommand, isTestRunCommand, type ChecklistItem } from '../release-loop/checklist.js';
import { withIsolatedElanousRoot } from '../../test/helpers/with-test-home.js';

function cli(sweep: StaleChecklistSweep) {
  const program = new Command();
  program.exitOverride();
  const release = program.command('release');
  const checklist = release.command('checklist').option('--version <v>').option('--json');
  registerChecklistReadCommands(checklist, undefined, sweep);
  return program;
}

test('checklist load is registered as a read-only command with version and JSON options', () => {
  const checklist = cli(() => { throw new Error('unexpected sweep'); }).commands[0]!.commands[0]!;
  const load = checklist.commands.find(command => command.name() === 'load');
  expect(load).toBeDefined();
  expect(load!.options.map(option => option.long)).toContain('--version');
  expect(load!.options.map(option => option.long)).toContain('--json');
  expect(load!.options.map(option => option.long)).not.toContain('--apply');
});
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

test('E1 narrows the PR to the line binding a 40-char merge sha — repair-PR short sha is not a candidate', () => {
  // 리터럴 출처(2026-11-19): 0.3.30 RELEASE-REALPATH-PROBE 칸 근거 원문 — #38495 merge sha 329d5e6607a64d2c554ccb53a84b18fc66889686(gh pr view 38495) · 착지 head 4702a2bd5b · 수리 PR #38933 head c89c9bfcc737 · 6 pass/0 fail/16 expect (OP #99234 파서 수리)
  const run: ChecklistEvidenceCommandRunner = (command, args) =>
    command === 'eln' && args[0] === 'gh' && args[1] === 'pr'
      ? { status: 0, stdout: '{"state":"MERGED","mergeCommit":{"oid":"329d5e6607a64d2c554ccb53a84b18fc66889686"}}\n', stderr: '' }
      : { status: 1, stdout: '', stderr: '' };
  const item = { id: 'RELEASE-REALPATH-PROBE', title: 'RELEASE-REALPATH-PROBE', status: 'yellow', updatedAt: '2026-11-19T08:00:00.000Z', updatedBy: 'HAND-GROK-2',
    evidence: 'PR #38495 329d5e6607a64d2c554ccb53a84b18fc66889686 merged\n#38495 착지 4702a2bd5b · 완료선 재실측 RED → 수리 PR #38933 head c89c9bfcc737 · 6 pass/0 fail/16 expect' } satisfies ChecklistItem;
  const e1 = collectChecklistEvidenceStages(item, run).find((stage) => stage.id === 'E1');
  expect(e1?.state).toBe('observed');
  expect(String(e1?.source)).toContain('#38495');
});

test('E1 ignores seat-mail #<digits> without a sha and queries only the sha-bound PR', () => {
  // 리터럴 출처(2026-11-19): 0.3.31 O2-CRON-RECEIPT 칸 E1 «PR #93985 조회 실패» 관측(08:29 — 우편 #93985·#94189 오인) · #38875 merge sha 0a67bb5d0cdc069fee4d16e47d82ffadba99da68(gh pr view 38875) · 반복 cron */20 (OP #99234 파서 수리)
  const run: ChecklistEvidenceCommandRunner = (command, args) =>
    command === 'eln' && args[0] === 'gh' && args[1] === 'pr'
      ? { status: 0, stdout: '{"state":"MERGED","mergeCommit":{"oid":"0a67bb5d0cdc069fee4d16e47d82ffadba99da68"}}\n', stderr: '' }
      : { status: 1, stdout: '', stderr: '' };
  const item = { id: 'O2-CRON-RECEIPT', title: 'O2-CRON-RECEIPT', status: 'yellow', updatedAt: '2026-11-19T08:00:00.000Z', updatedBy: 'HAND-GROK-2',
    evidence: 'msg #93985·#94189 두 발화 관측\nPR #38875 0a67bb5d0cdc069fee4d16e47d82ffadba99da68 merged · 반복 cron */20' } satisfies ChecklistItem;
  const e1 = collectChecklistEvidenceStages(item, run).find((stage) => stage.id === 'E1');
  expect(e1?.state).toBe('observed');
  expect(String(e1?.source)).toContain('#38875');
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

// CHECKLIST-JUDGE-MULTI-PR-AND-E4-LINES(2026-11-20) — 다중 PR·둘째 줄 runId·줄 중간 문구 시험. 가짜 근거 거부(틀린 sha·미병합·로그 부재·runId 불일치·문구 부재)는 그대로 유지한다.
// 리터럴 출처(2026-11-20): 0.3.31 NEXUS-REMOTE-HOST-REGISTRY 칸 근거 원문 — PR #39189 merged 188c82268bd0449cb174316bee809c36d4c3f1be · PR #39165 MERGED 70cef5a1d21e47b1423852a2dfc3c472ee03db04 (gh pr view 39189·39165 MERGED 확인) · E1 «하나로 좁혀지지 않는다» 영구 missing 사례(REL #111568)
const multiPrFixture = { '39189': '188c82268bd0449cb174316bee809c36d4c3f1be', '39165': '70cef5a1d21e47b1423852a2dfc3c472ee03db04' } as const;
const multiPrNumbers = Object.keys(multiPrFixture) as Array<keyof typeof multiPrFixture>;
const multiPrItem = { id: 'NEXUS-REMOTE-HOST-REGISTRY', title: 'NEXUS-REMOTE-HOST-REGISTRY', status: 'yellow', updatedAt: '2026-11-20T09:00:00.000Z', updatedBy: 'REL',
  evidence: `PR #39189 호스트 원장 비밀 수신 칸(canReceiveSecret) — merged ${multiPrFixture['39189']} (2026-11-20T05:21:34Z · JUD pass)\nPR #39165 MERGED ${multiPrFixture['39165']} · 증거 명령: bun test src/nexus/host-registry/host-registry.test.ts` } satisfies ChecklistItem;
const pinSha = 'f'.repeat(multiPrFixture['39189'].length);

function multiPrRunner(opts: { prs?: Partial<Record<string, { state: string; oid: string }>>; notAncestor?: string } = {}) {
  const calls: string[][] = [];
  const run: ChecklistEvidenceCommandRunner = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'eln' && args[0] === 'gh') {
      const number = args[3]!;
      const pr = opts.prs?.[number] ?? { state: 'MERGED', oid: multiPrFixture[number as keyof typeof multiPrFixture] };
      return { status: 0, stdout: `${JSON.stringify({ state: pr.state, mergeCommit: { oid: pr.oid } })}\n`, stderr: '' };
    }
    if (command === 'eln' && args[0] === '--version') return { status: 0, stdout: `0.3.31-dev.0 ${pinSha}`, stderr: '' };
    if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: '/repo/elanous\n', stderr: '' };
    if (command === 'git' && args[0] === 'remote') return { status: 0, stdout: 'git@github.com:ElanvitalAI/elanous.git\n', stderr: '' };
    if (command === 'git' && args[0] === 'cat-file') return { status: 0, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'merge-base') return { status: args[2] === opts.notAncestor ? 1 : 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('E1 accepts multiple sha-bound merged PRs when every PR verifies, and E3 checks ancestry for every merge sha', () => {
  const { run, calls } = multiPrRunner();
  const stages = collectChecklistEvidenceStages(multiPrItem, run);
  const e1 = stages.find((stage) => stage.id === 'E1');
  const e3 = stages.find((stage) => stage.id === 'E3');
  expect(e1?.state).toBe('observed');
  for (const number of multiPrNumbers) expect(String(e1?.source)).toContain(`#${number} → ${multiPrFixture[number]}`);
  expect(e3?.state).toBe('observed');
  const ancestryChecks = calls.filter((call) => call[0] === 'git' && call[1] === 'merge-base').map((call) => call[3]);
  // 정수꼴 키는 Object.keys 순서가 근거 순서와 다르다 — 집합으로 비교한다(모든 merge sha 가 각각 한 번씩 검사됨).
  expect([...ancestryChecks].sort()).toEqual(Object.values(multiPrFixture).sort());
});

test('E1 rejects multi-PR evidence when one cited PR is not MERGED — no ancestry check runs', () => {
  const { run, calls } = multiPrRunner({ prs: { '39165': { state: 'OPEN', oid: multiPrFixture['39165'] } } });
  const stages = collectChecklistEvidenceStages(multiPrItem, run);
  const e1 = stages.find((stage) => stage.id === 'E1');
  expect(e1?.state).toBe('missing');
  expect(e1?.reason).toContain('PR #39165 상태가 MERGED가 아니다');
  expect(stages.find((stage) => stage.id === 'E3')?.state).toBe('unmeasurable');
  expect(calls.some((call) => call[0] === 'git' && call[1] === 'merge-base')).toBe(false);
});

test('E1 rejects multi-PR evidence when one PR merge sha differs from the cited sha (fake sha)', () => {
  // 가짜 근거: 조회된 merge sha 가 근거 줄의 sha 와 다르면 결속 실패 — 다른 PR 이 맞아도 칸 전체 missing
  const { run } = multiPrRunner({ prs: { '39189': { state: 'MERGED', oid: pinSha } } });
  const e1 = collectChecklistEvidenceStages(multiPrItem, run).find((stage) => stage.id === 'E1');
  expect(e1?.state).toBe('missing');
  expect(e1?.reason).toContain('병합 PR #39189와 merge SHA가 같은 근거 줄에서 결속되지 않았다');
});

test('E3 names the merge sha whose PR is not an ancestor of the installed pin', () => {
  const { run } = multiPrRunner({ notAncestor: multiPrFixture['39165'] });
  const stages = collectChecklistEvidenceStages(multiPrItem, run);
  expect(stages.find((stage) => stage.id === 'E1')?.state).toBe('observed');
  const e3 = stages.find((stage) => stage.id === 'E3');
  expect(e3?.state).toBe('missing');
  expect(e3?.reason).toContain(multiPrFixture['39165']);
});

test('E1 still refuses to narrow when multiple PRs are cited but none binds a 40-char sha', () => {
  const item = { ...multiPrItem, evidence: 'PR #39189 merged 188c82268bd0 · PR #39165 merged 70cef5a1d21e' } satisfies ChecklistItem;
  const e1 = collectChecklistEvidenceStages(item, () => { throw new Error('unexpected external command'); }).find((stage) => stage.id === 'E1');
  expect(e1?.state).toBe('missing');
  expect(e1?.reason).toBe('근거에서 교차할 PR이 하나로 좁혀지지 않는다');
});

// 리터럴 출처(2026-11-20): E4 줄별 짝 — 첫 줄 runId 는 시각이 없고(건너뜀) 둘째 줄 runId·event·ISO 시각 짝이 로그와 맞는다(CHECKLIST-JUDGE-MULTI-PR-AND-E4-LINES ②) · runId 꼴은 0.3.31 RELEASE-TRAFFIC-PREP-T1H 근거의 9eac3c52-7e24-4630-ab6d-8220be2abe2e
const e4FirstRunId = 'run-11111111-1111-1111-1111-111111111111';
const e4SecondRunId = '9eac3c52-7e24-4630-ab6d-8220be2abe2e';
const e4SecondAt = '2026-11-20T08:30:00.000Z';
const e4Item = { id: 'E4-LINES', title: '완료 경계 증거 명령: bun test scripts/release-loop/traffic-prep-node.test.ts', status: 'yellow', updatedAt: e4SecondAt, updatedBy: 'REL',
  evidence: `runId=${e4FirstRunId} event=node-start (시각 미기재)\nrunId=${e4SecondRunId} at=${e4SecondAt} event=node-end` } satisfies ChecklistItem;

function e4Runner(row: { event: string; runId: string }) {
  const queried: string[][] = [];
  const run: ChecklistEvidenceCommandRunner = (command, args) => {
    if (command === 'eln' && args[0] === 'logs') { queried.push(args); return { status: 0, stdout: `${JSON.stringify({ event: row.event, data: JSON.stringify({ runId: row.runId }) })}\n`, stderr: '' }; }
    return { status: 1, stdout: '', stderr: '' };
  };
  return { run, queried };
}

test('E4 accepts a second-line runId+event+timestamp pair when the first line has no timestamp', () => {
  const { run, queried } = e4Runner({ event: 'node-end', runId: e4SecondRunId });
  const e4 = collectChecklistEvidenceStages(e4Item, run).find((stage) => stage.id === 'E4');
  expect(e4?.state).toBe('observed');
  expect(String(e4?.source)).toContain(`runId=${e4SecondRunId}`);
  expect(queried.map((args) => args[args.indexOf('--event') + 1])).toEqual(['node-end']);
});

test('E4 still rejects a second-line pair whose runId is not in the logs (runId mismatch)', () => {
  const { run } = e4Runner({ event: 'node-end', runId: e4FirstRunId });
  const e4 = collectChecklistEvidenceStages(e4Item, run).find((stage) => stage.id === 'E4');
  expect(e4?.state).toBe('missing');
  expect(e4?.reason).toBe('같은 runId의 node-end 이벤트가 없다');
});

test('E4 still rejects when the cited event is absent from the logs', () => {
  const { run } = e4Runner({ event: 'node-start', runId: e4SecondRunId });
  expect(collectChecklistEvidenceStages(e4Item, run).find((stage) => stage.id === 'E4')?.state).toBe('missing');
});

test('E4 observes any matching pair — first timed pair absent, second timed pair present', () => {
  const firstAt = '2026-11-20T01:00:00.000Z';
  const item = { ...e4Item, evidence: `runId=${e4FirstRunId} at=${firstAt} event=node-start\nrunId=${e4SecondRunId} at=${e4SecondAt} event=node-end` } satisfies ChecklistItem;
  const { run, queried } = e4Runner({ event: 'node-end', runId: e4SecondRunId });
  expect(collectChecklistEvidenceStages(item, run).find((stage) => stage.id === 'E4')?.state).toBe('observed');
  // prod 인스턴스 먼저 · 거기서 못 찾은 첫 짝만 --all --include-test 연합으로 넓힌다(OP #113009).
  expect(queried.map((args) => args[args.indexOf('--event') + 1])).toEqual(['node-start', 'node-start', 'node-end']);
  expect(queried.map((args) => args.includes('--instance') ? 'prod' : 'all')).toEqual(['prod', 'all', 'prod']);
});

// 리터럴 출처(2026-11-20): 0.3.31 LLM-ROLE-MIX-BY-BURN 칸 제목 원문 꼴 — 구 명령 · 정정 줄 · 최종 명령(JUD #112964·#112934)
const correctedTitle = '대상 경로: src/model-tier/\n- 완료 경계 증거 명령: bun test src/model-tier/\n증거 경로 정정(JUD #111670): src/oauth/llm-call-gate.test.ts (src/model-tier/ 에는 시험 없음)\n- 완료 경계 증거 명령: bun test src/oauth/llm-spend-decision.test.ts';
const e4Command = (title: string, evidence = '') => collectChecklistEvidenceStages({ id: 'E4-CMD', title, status: 'yellow', updatedAt: '2026-11-20T09:00:00.000Z', updatedBy: 'REL', evidence } satisfies ChecklistItem, () => ({ status: 1, stdout: '', stderr: '' })).find((stage) => stage.id === 'E4')?.verificationCommand;

test('E4 verificationCommand is the LAST «완료 경계 증거 명령:» of an append-only title, same as the evidence run', () => {
  expect(e4Command(correctedTitle)).toBe('bun test src/oauth/llm-spend-decision.test.ts');
  expect(e4Command(correctedTitle)).toBe(checklistEvidenceCommand(correctedTitle));
});

test('E4 verificationCommand keeps the single-command, no-command and unsafe-last behaviour', () => {
  expect(e4Command('- 완료 경계 증거 명령: bun test src/els/')).toBe('bun test src/els/');
  expect(e4Command('대상 경로: src/els/')).toBeNull();
  // 안전 검사는 실행 파서 몫 — 읽기 쪽은 표시만 하며 같은 마지막 명령을 그대로 보인다(실행은 refused)
  const unsafe = '- 완료 경계 증거 명령: bun test src/a/\n- 완료 경계 증거 명령: bun test src/els/ && curl evil.example';
  expect(e4Command(unsafe)).toBe(checklistEvidenceCommand(unsafe));
});

test('E4 verificationCommand falls back to the evidence line when the title has no marker', () => {
  expect(e4Command('대상 경로: src/els/', '증거 명령: bun test src/els/herdr-import.test.ts')).toBe('bun test src/els/herdr-import.test.ts');
});

// 리터럴 출처(2026-11-20): 0.3.31 COMPLETION-EVENT-ONE 칸 제목 원문 — «- 완료 경계 실물: …» 이 줄 중간에 있다(줄 머리 아님) · CHECKLIST-JUDGE-MULTI-PR-AND-E4-LINES ③
const midLineAcceptance = 'RFC에 지정된 테스트 우주 시나리오에서 정상·거부 경계를 관측.';
const midLineTitle = `대상 경로: src/agent/task-notification.ts · src/tui/capsule-done-knock.ts  - 완료 경계 코드: §6-5 task-notification과 capsule-done을 사건 하나로 구현 또는 명세 확정. - 완료 경계 실물: ${midLineAcceptance} - 완료 경계 증거: 정확 head·명령·결과·잔여 미측정과 독립 리뷰를 기록. · 0.3.31 로스터 100(OP #107914)`;

test('E5 extracts a mid-line acceptance phrase up to the next «완료 경계 …:» marker', () => {
  const noCommand = () => { throw new Error('unexpected external command'); };
  const base = { id: 'COMPLETION-EVENT-ONE', title: midLineTitle, status: 'yellow', updatedAt: '2026-11-20T09:00:00.000Z', updatedBy: 'REL' } as const;
  expect(collectChecklistEvidenceStages({ ...base, evidence: `실물: ${midLineAcceptance} (시험 우주 원문)` } satisfies ChecklistItem, noCommand).find((stage) => stage.id === 'E5')?.state).toBe('observed');
  // 문구 부재 근거(뒤 «완료 경계 증거» 문구만 있음)는 여전히 거부
  expect(collectChecklistEvidenceStages({ ...base, evidence: '정확 head·명령·결과·잔여 미측정과 독립 리뷰를 기록.' } satisfies ChecklistItem, noCommand).find((stage) => stage.id === 'E5')?.state).toBe('missing');
});

test('E5 ignores a quoted «완료 경계 실물:» mention and reads the real · 완료 경계 실물: marker', () => {
  // 리터럴 출처(2026-11-20): 0.3.31 CHECKLIST-JUDGE-MULTI-PR-AND-E4-LINES 칸 제목 원문(인용 «완료 경계 실물:» 과 실제 표지가 한 줄에 함께 있다)
  const title = '③ E5 «완료 경계 실물:» 줄 머리만 인정 → 줄 중간도 인정 · 단언 약화 0(가짜 근거 거부 시험 유지) · 완료 경계 실물: 8칸·4칸이 근거 그대로 greenEligible 판정 · 완료 경계 증거: 다중 PR·둘째 줄 runId·줄 중간 문구 시험';
  const noCommand = () => { throw new Error('unexpected external command'); };
  const base = { id: 'CHECKLIST-JUDGE-MULTI-PR-AND-E4-LINES', title, status: 'yellow', updatedAt: '2026-11-20T09:00:00.000Z', updatedBy: 'REL' } as const;
  expect(collectChecklistEvidenceStages({ ...base, evidence: '실측: 8칸·4칸이 근거 그대로 greenEligible 판정' } satisfies ChecklistItem, noCommand).find((stage) => stage.id === 'E5')?.state).toBe('observed');
  expect(collectChecklistEvidenceStages({ ...base, evidence: '» 줄 머리만 인정 → 줄 중간도 인정 · 단언 약화 0(가짜 근거 거부 시험 유지)' } satisfies ChecklistItem, noCommand).find((stage) => stage.id === 'E5')?.state).toBe('missing');
});

// ── CHECKLIST-E4-RUN-RECEIPT — evidence run (러너·logs 저장소·원장 쓰기 모두 가짜 주입) ─────────────────────
// 리터럴 출처(2026-11-20): 칸 제목 꼴은 0.3.31 ELS-HERDR-IMPORT 원문의 «- 완료 경계 증거 명령: bun test src/els/» 줄 · 시각은 이 칸 작업일.
const runCellTitle = '대상 경로: src/els/herdr-import.ts\n- 완료 경계 실물: 두 번째 실행 건너뜀\n- 완료 경계 증거 명령: bun test src/els/';
const runCell = { id: 'ELS-HERDR-IMPORT', title: runCellTitle, status: 'yellow', updatedAt: '2026-11-20T00:00:00.000Z', updatedBy: 'OP', evidence: '진행: 착수' } satisfies ChecklistItem;
const runStartedAt = '2026-11-20T09:00:00.000Z';
const runUuid = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
const SUCCESS_RC = 0; // POSIX 성공 종료 코드
const FAILURE_RC = 1; // bun test 실패 종료 코드
const SSH_UNREACHABLE_RC = 255; // ssh(1): 연결 실패 시 255
const hqHeadSha = 'ce760462e8476ed9e5a41dfb19e12fd600b39547'; // 출처: #39237 병합 커밋(이 칸의 앞 PR)

function evidenceRunFake(input: { status: number | null; host?: string; cell?: ChecklistItem; hq?: boolean; registry?: RegistryHostEntry[]; dispatch?: (request: EvidenceRunRequest) => EvidenceDispatchOutcome; eventObserved?: boolean }) {
  const logged: Record<string, unknown>[] = [];
  const dispatchLogged: Record<string, unknown>[] = [];
  const appended: { id: string; line: string }[] = [];
  const executed: (readonly string[])[] = [];
  const dispatched: EvidenceRunRequest[] = [];
  const reads: string[] = [];
  const deps: ChecklistEvidenceRunDeps = {
    hqWriteAllowed: () => input.hq ?? true,
    readItem: (_version, id) => { reads.push(id); return (input.cell ?? runCell).id === id ? (input.cell ?? runCell) : undefined; },
    localHost: () => input.host ?? 'node-b',
    execute: (argv) => { executed.push(argv); return { status: input.status }; },
    log: (data) => { logged.push(data); },
    appendEvidence: (_version, item, line) => { appended.push({ id: item.id, line }); },
    now: () => new Date(runStartedAt),
    runId: () => runUuid,
    cwd: process.cwd(),
    registryHosts: () => input.registry ?? [],
    headSha: () => hqHeadSha,
    dispatch: (request) => { dispatched.push(request); return input.dispatch ? input.dispatch(request) : { kind: 'unreachable', reason: 'no fake dispatch' }; },
    logDispatch: (data) => { dispatchLogged.push(data); },
    remoteEventObserved: () => input.eventObserved ?? true,
  };
  return { deps, logged, dispatchLogged, appended, executed, dispatched, reads };
}

// 넥서스 호스트 원장(#39165) 가짜 — 등록 호스트는 OP #112499 가 명시한 시험 실행 호스트(node-b)와 좌석 호스트(mshq).
const fakeRegisteredHosts = new Set(['node-b', 'mshq']);
function evidenceHosts(local: string) {
  return { localHost: () => local, isRegisteredHost: (host: string) => fakeRegisteredHosts.has(host) };
}

function loggedRowRunner(logged: Record<string, unknown>[], calls: { command: string; args: string[] }[] = []): ChecklistEvidenceCommandRunner {
  return (command, args) => {
    calls.push({ command, args });
    const rows = logged.map((data) => JSON.stringify({ event: CHECKLIST_EVIDENCE_RUN_EVENT, data: JSON.stringify(data) })).join('\n');
    if (command === 'eln' && args[0] === 'logs') return { status: SUCCESS_RC, stdout: `${rows}\n`, stderr: '' };
    if (command === 'ssh') return { status: SUCCESS_RC, stdout: `${rows}\n`, stderr: '' };
    return { status: FAILURE_RC, stdout: '', stderr: '' };
  };
}

test('checklistEvidenceCommand reads the «- 완료 경계 증거 명령:» title line and ignores a quoted mention', () => {
  expect(checklistEvidenceCommand(runCellTitle)).toBe('bun test src/els/');
  expect(checklistEvidenceCommand('칸 제목의 «완료 경계 증거 명령»을 격리 테스트 우주에서 실행')).toBeNull();
  expect(checklistEvidenceCommand('대상 경로: a.ts · 완료 경계 증거 명령: eln logs --since 24h · 완료 경계 증거: 성공·실패')).toBe('eln logs --since 24h');
  expect(checklistEvidenceCommand(`${runCellTitle}\n- 완료 경계 증거 명령: bun test src/oauth/llm-call-gate.test.ts`)).toBe('bun test src/oauth/llm-call-gate.test.ts');
  expect(isTestRunCommand('bun test src/els/')).toBe(true);
  expect(isTestRunCommand('python3 seat-state/RES/tools/pregate.py 1 --light')).toBe(true);
  expect(isTestRunCommand('eln logs --category memory.lifecycle --since 24h')).toBe(false);
});

test('evidence run success: rc 0 → one checklist.evidence.run event + one evidence line → E4 observed for that cell', () => {
  const { deps, logged, appended, executed } = evidenceRunFake({ status: SUCCESS_RC });
  const result = runChecklistEvidence('0.3.31', runCell.id, deps);
  expect(executed).toEqual([['bun', 'test', 'src/els/']]);
  expect(logged).toEqual([{ runId: runUuid, cellId: runCell.id, version: '0.3.31', command: 'bun test src/els/', rc: SUCCESS_RC, durationMs: 0, layer: 'test', synthetic: true, host: 'node-b' }]);
  expect(appended).toHaveLength(1);
  expect(appended[0]!.line).toBe(`E4 test 층 — runId ${runUuid} · event: ${CHECKLIST_EVIDENCE_RUN_EVENT} · ${runStartedAt} · host node-b · 칸 ${runCell.id} · 명령: bun test src/els/ · rc 0 (evidence run · synthetic/test)`);
  expect(result.evidenceLine).toBe(appended[0]!.line);
  const calls: { command: string; args: string[] }[] = [];
  const judged = { ...runCell, evidence: `${runCell.evidence}\n${appended[0]!.line}` };
  const e4 = collectChecklistEvidenceStages(judged, loggedRowRunner(logged, calls), evidenceHosts('node-b')).find((stage) => stage.id === 'E4');
  expect(e4?.state).toBe('observed');
  expect(calls.map((call) => call.command)).toEqual(['eln']);
});

test('evidence run failure: rc≠0 → event logged with rc, zero evidence lines', () => {
  const { deps, logged, appended } = evidenceRunFake({ status: FAILURE_RC });
  const result = runChecklistEvidence('0.3.31', runCell.id, deps);
  expect(result.rc).toBe(FAILURE_RC);
  expect(result.evidenceLine).toBeNull();
  expect(logged.map((row) => row.rc)).toEqual([FAILURE_RC]);
  expect(appended).toEqual([]);
});

test('evidence run binding: the receipt line copied into another cell → E4 missing (logged cellId differs)', () => {
  const { deps, logged, appended } = evidenceRunFake({ status: SUCCESS_RC });
  runChecklistEvidence('0.3.31', runCell.id, deps);
  const other = { ...runCell, id: 'OTHER-CELL', evidence: appended[0]!.line };
  const e4 = collectChecklistEvidenceStages(other, loggedRowRunner(logged), evidenceHosts('node-b')).find((stage) => stage.id === 'E4');
  expect(e4?.state).toBe('missing');
  expect(e4?.reason).toContain(`칸 ${runCell.id} 에 결속돼 있다`);
});

test('evidence run refuses a cell whose title has no evidence command — nothing executed, logged or written', () => {
  const cell = { ...runCell, title: '대상 경로: src/els/herdr-import.ts\n- 완료 경계 실물: 두 번째 실행 건너뜀' };
  const { deps, logged, appended, executed } = evidenceRunFake({ status: SUCCESS_RC, cell });
  expect(() => runChecklistEvidence('0.3.31', cell.id, deps)).toThrow('완료 경계 증거 명령');
  expect([executed, logged, appended]).toEqual([[], [], []]);
});

// ── OP #112782: HQ(좌석 mshq)는 시험을 등록 시험 호스트로 보낸다 · 사건은 그 호스트 logs.db · 원장 쓰기는 HQ ─────────────
// 리터럴 출처: OP #112782 가 명시한 등록 시험 호스트(node-b · mbp · node-c)와 HQ(mshq) · 별칭 MacStudioB1 은 EVIDENCE-RUN-0331 README 의 node-b 자기 이름.
const registryEntry = (key: string, aliases?: string[]): RegistryHostEntry => ({ key, host: key, ...(aliases ? { aliases } : {}) });
const testRegistry = [registryEntry('mshq'), registryEntry('node-b', ['MacStudioB1']), registryEntry('mbp'), registryEntry('node-c')];

/** A fake test host: runs the real receipt half (runEvidenceReceipt) with a fake executor and its own logs.db rows. */
function fakeTestHost(rc: number, hostLogs: Record<string, unknown>[], selfReported = 'MacStudioB1') {
  return (request: EvidenceRunRequest): EvidenceDispatchOutcome => {
    const printed: string[] = [];
    const exit = runEvidenceReceipt([request.runId, request.cellId, request.version, request.host, request.ledgerHost, request.commit, ...request.argv], {
      execute: () => ({ status: rc }), log: (data) => { hostLogs.push(data); }, selfReportedHost: () => selfReported,
      now: () => new Date(runStartedAt), cwd: process.cwd(), print: (line) => { printed.push(line); },
    });
    return { kind: 'ran', rc: exit, receipt: parseEvidenceReceipt(printed.join('\n')), outputTail: rc === SUCCESS_RC ? ' 1 pass' : ' 1 fail' };
  };
}

test('evidence run on HQ seat host mshq dispatches to the first registered test host — event on that host, evidence line on HQ naming the registry host', () => {
  const hostLogs: Record<string, unknown>[] = [];
  const fake = evidenceRunFake({ status: SUCCESS_RC, host: 'mshq', registry: testRegistry, dispatch: fakeTestHost(SUCCESS_RC, hostLogs) });
  const result = runChecklistEvidence('0.3.31', runCell.id, fake.deps);
  expect(fake.executed).toEqual([]);
  expect(fake.logged).toEqual([]);
  expect(fake.dispatched).toEqual([{ runId: runUuid, cellId: runCell.id, version: '0.3.31', host: 'node-b', ledgerHost: 'mshq', commit: hqHeadSha, argv: ['bun', 'test', 'src/els/'] }]);
  expect(hostLogs).toHaveLength(1);
  expect(hostLogs[0]).toMatchObject({ runId: runUuid, cellId: runCell.id, rc: SUCCESS_RC, host: 'node-b', executedOn: 'node-b', selfReportedHost: 'MacStudioB1', ledgerHost: 'mshq', commit: hqHeadSha, layer: 'test' });
  expect(fake.dispatchLogged).toEqual([expect.objectContaining({ runId: runUuid, executedOn: 'node-b', ledgerHost: 'mshq', commit: hqHeadSha, rc: SUCCESS_RC, eventObserved: true, selfReportedRegistryName: 'node-b' })]);
  expect(fake.appended).toHaveLength(1);
  expect(fake.appended[0]!.line).toBe(`E4 test 층 — runId ${runUuid} · event: ${CHECKLIST_EVIDENCE_RUN_EVENT} · ${runStartedAt} · host node-b · 칸 ${runCell.id} · 명령: bun test src/els/ · rc 0 · 원장 mshq · 실행 node-b @${hqHeadSha.slice(0, 12)} (evidence run · synthetic/test)`);
  expect(result.dispatch).toMatchObject({ executedOn: 'node-b', ledgerHost: 'mshq', commit: hqHeadSha, eventObserved: true, outputTail: ' 1 pass' });
  // E4 on HQ reads the line's host over ssh — the registry host's logs.db holds the event.
  const calls: { command: string; args: string[] }[] = [];
  const e4 = collectChecklistEvidenceStages({ ...runCell, evidence: fake.appended[0]!.line }, loggedRowRunner(hostLogs, calls), evidenceHosts('mshq')).find((stage) => stage.id === 'E4');
  expect(e4?.state).toBe('observed');
  expect(calls.map((call) => call.command)).toEqual(['ssh']);
  expect(calls[0]!.args).toContain('node-b');
});

test('evidence run dispatch skips an unreachable registered host and runs on the next', () => {
  const hostLogs: Record<string, unknown>[] = [];
  const ran = fakeTestHost(SUCCESS_RC, hostLogs, 'mbp');
  const fake = evidenceRunFake({ status: SUCCESS_RC, host: 'mshq', registry: testRegistry,
    dispatch: (request) => request.host === 'node-b' ? { kind: 'unreachable', reason: 'push-failed rc=255' } : ran(request) });
  const result = runChecklistEvidence('0.3.31', runCell.id, fake.deps);
  expect(fake.dispatched.map((request) => request.host)).toEqual(['node-b', 'mbp']);
  expect(result.dispatch?.skipped).toEqual([{ host: 'node-b', reason: 'push-failed rc=255' }]);
  expect(fake.appended[0]!.line).toContain('host mbp ·');
});

test('evidence run dispatch: test host rc≠0 → event on the test host and HQ dispatch log, zero evidence lines', () => {
  const hostLogs: Record<string, unknown>[] = [];
  const fake = evidenceRunFake({ status: SUCCESS_RC, host: 'mshq', registry: testRegistry, dispatch: fakeTestHost(FAILURE_RC, hostLogs) });
  const result = runChecklistEvidence('0.3.31', runCell.id, fake.deps);
  expect(result.rc).toBe(FAILURE_RC);
  expect(result.evidenceLine).toBeNull();
  expect(hostLogs.map((row) => row.rc)).toEqual([FAILURE_RC]);
  expect(fake.dispatchLogged.map((row) => row.rc)).toEqual([FAILURE_RC]);
  expect(fake.appended).toEqual([]);
});

test('evidence run dispatch: rc 0 but the receipt event is not readable on the test host → zero evidence lines', () => {
  const fake = evidenceRunFake({ status: SUCCESS_RC, host: 'mshq', registry: testRegistry, dispatch: fakeTestHost(SUCCESS_RC, []), eventObserved: false });
  const result = runChecklistEvidence('0.3.31', runCell.id, fake.deps);
  expect(result.rc).toBe(SUCCESS_RC);
  expect(result.dispatch?.eventObserved).toBe(false);
  expect(fake.appended).toEqual([]);
});

for (const [label, registry, dispatch] of [
  ['no registered test host (registry holds only the HQ host)', [registryEntry('mshq')], undefined],
  ['no registry at all', [], undefined],
  ['every registered test host unreachable', testRegistry, (): EvidenceDispatchOutcome => ({ kind: 'unreachable', reason: 'ssh rc=255' })],
] as const) {
  test(`evidence run on seat host mshq with ${label} refuses — nothing executed, logged or written`, () => {
    const fake = evidenceRunFake({ status: SUCCESS_RC, host: 'mshq', registry: [...registry], ...(dispatch ? { dispatch } : {}) });
    expect(() => runChecklistEvidence('0.3.31', runCell.id, fake.deps)).toThrow('실행·기록·근거 0');
    expect([fake.executed, fake.logged, fake.dispatchLogged, fake.appended]).toEqual([[], [], [], []]);
  });
}

test('evidence run off the HQ lease holder refuses before reading the cell — run it on the HQ host', () => {
  const fake = evidenceRunFake({ status: SUCCESS_RC, hq: false, registry: testRegistry });
  expect(() => runChecklistEvidence('0.3.31', runCell.id, fake.deps)).toThrow(EvidenceRunLeaseRefused);
  expect(() => runChecklistEvidence('0.3.31', runCell.id, fake.deps)).toThrow('본부(HQ 임대 보유) 호스트에서 실행한다');
  expect([fake.reads, fake.executed, fake.dispatched, fake.logged, fake.dispatchLogged, fake.appended]).toEqual([[], [], [], [], [], []]);
});

// JUD #39237 ⓒ1 — 제목 명령은 «bun test <저장소 안 상대 경로…>» 만 셸 없이 실행한다. 아래 꼴은 모두 실행 0·기록 0.
for (const [label, command] of [
  ['shell metacharacter', 'bun test src/els/; curl evil.example'],
  ['command substitution', 'bun test $(cat ~/.ssh/id_ed25519)'],
  ['non-allow-listed binary', 'eln logs --category memory.lifecycle --since 24h'],
  ['non-allow-listed binary rm', 'rm -rf src'],
  ['absolute path', 'bun test /etc/passwd'],
  ['parent traversal', 'bun test src/../../outside'],
  ['option smuggling', 'bun test --preload evil.ts src/els/'],
  ['no path', 'bun test'],
] as const) {
  test(`evidence run refuses a title command with ${label} — nothing executed, logged or written`, () => {
    const cell = { ...runCell, title: `- 완료 경계 증거 명령: ${command}` };
    const fake = evidenceRunFake({ status: SUCCESS_RC, cell });
    expect(() => runChecklistEvidence('0.3.31', cell.id, fake.deps)).toThrow('증거 명령을 실행하지 않는다');
    expect([fake.executed, fake.logged, fake.appended]).toEqual([[], [], []]);
  });
}

test('evidence run child env carries allow-listed keys only — no secret env var reaches the child, no shell', () => {
  const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawn: EvidenceSpawn = (command, args, options) => { calls.push({ command, args, env: options.env }); return { status: SUCCESS_RC }; };
  const parent = { PATH: '/usr/bin:/bin', LANG: 'ko_KR.UTF-8', HOME: '/Users/operator', GITHUB_TOKEN: 'ghp_fake_secret', ANTHROPIC_API_KEY: 'sk-ant-fake', ELANOUS_NEXUS_TOKEN_FILE: '/Users/operator/.token', SSH_AUTH_SOCK: '/tmp/agent.sock' };
  expect(runInIsolatedUniverse(['bun', 'test', 'src/els/'], process.cwd(), parent, spawn).status).toBe(SUCCESS_RC);
  expect(calls.map(({ command, args }) => [command, ...args])).toEqual([['bun', 'test', 'src/els/']]);
  const env = calls[0]!.env;
  expect(Object.keys(env).sort()).toEqual(['ELANOUS_STATE_DIR', 'ELANOUS_STATE_DIR_SOURCE', 'HOME', 'LANG', 'NODE_ENV', 'PATH', 'TMPDIR']);
  expect(Object.values(env)).not.toContain('ghp_fake_secret');
  expect(Object.values(env)).not.toContain('sk-ant-fake');
  expect(env.HOME).not.toBe(parent.HOME);
  expect(String(env.HOME).startsWith(String(env.ELANOUS_STATE_DIR))).toBe(true);
});

test('E4 never sshes to a host outside the nexus host registry — unmeasurable with zero ssh calls', () => {
  const { deps, logged, appended } = evidenceRunFake({ status: SUCCESS_RC, host: 'evil.example' });
  runChecklistEvidence('0.3.31', runCell.id, deps);
  const calls: { command: string; args: string[] }[] = [];
  const e4 = collectChecklistEvidenceStages({ ...runCell, evidence: appended[0]!.line }, loggedRowRunner(logged, calls), evidenceHosts('mshq')).find((stage) => stage.id === 'E4');
  expect(e4?.state).toBe('unmeasurable');
  expect(e4?.reason).toContain('넥서스 호스트 원장 등록 호스트가 아니다');
  expect(calls).toEqual([]);
});

test('E4 reads a receipt naming another host over ssh on that host (cell binding kept) and is unmeasurable when unreachable', () => {
  const { deps, logged, appended } = evidenceRunFake({ status: SUCCESS_RC, host: 'node-b' });
  runChecklistEvidence('0.3.31', runCell.id, deps);
  const judged = { ...runCell, evidence: appended[0]!.line };
  const calls: { command: string; args: string[] }[] = [];
  const remote = collectChecklistEvidenceStages(judged, loggedRowRunner(logged, calls), evidenceHosts('mshq')).find((stage) => stage.id === 'E4');
  expect(remote?.state).toBe('observed');
  expect(calls.map((call) => call.command)).toEqual(['ssh']);
  expect(calls[0]!.args).toContain('node-b');
  expect(calls[0]!.args.at(-1)).toStartWith('bash -lc ');
  expect(calls[0]!.args.at(-1)).toContain(CHECKLIST_EVIDENCE_RUN_EVENT);
  expect(String(remote?.source)).toContain('ssh node-b ');
  const boundElsewhere = collectChecklistEvidenceStages({ ...judged, id: 'OTHER-CELL' }, loggedRowRunner(logged), evidenceHosts('mshq')).find((stage) => stage.id === 'E4');
  expect(boundElsewhere?.state).toBe('missing');
  const unreachable: ChecklistEvidenceCommandRunner = () => ({ status: SSH_UNREACHABLE_RC, stdout: '', stderr: 'ssh: connect to host node-b: Operation timed out' });
  const e4 = collectChecklistEvidenceStages(judged, unreachable, evidenceHosts('mshq')).find((stage) => stage.id === 'E4');
  expect(e4?.state).toBe('unmeasurable');
  expect(e4?.reason).toContain('원격 호스트 node-b');
});

test('evidence run with two «완료 경계 증거 명령:» lines runs only the last (appended correction)', () => {
  // 리터럴 출처(OP #112499): LLM-SPEND-POLICY-ONE-SHOT — 옛 «bun test src/model-tier/» 줄 뒤에 정정 줄이 덧붙는다.
  const cell = { ...runCell, title: '- 완료 경계 증거 명령: bun test src/model-tier/\n- 완료 경계 증거 명령: bun test src/oauth/llm-call-gate.test.ts' };
  const fake = evidenceRunFake({ status: SUCCESS_RC, cell });
  expect(runChecklistEvidence('0.3.31', cell.id, fake.deps).command).toBe('bun test src/oauth/llm-call-gate.test.ts');
  expect(fake.executed).toEqual([['bun', 'test', 'src/oauth/llm-call-gate.test.ts']]);
  const unsafeLast = { ...cell, title: `${cell.title}\n- 완료 경계 증거 명령: bun test src/els/ && curl evil.example` };
  const refused = evidenceRunFake({ status: SUCCESS_RC, cell: unsafeLast });
  expect(() => runChecklistEvidence('0.3.31', cell.id, refused.deps)).toThrow('증거 명령을 실행하지 않는다');
  expect(refused.executed).toEqual([]);
});

// ── workspace package cwd (OP #113166 ①) — 리터럴 출처: 0.3.31 PWA-INTAKE-N1-N5A-N6A 칸 증거 명령 · apps/pwa 의 자체 package.json ─────────
const pwaCellTest = 'apps/pwa/src/app/intake/page.test.tsx';
const pwaCell = { ...runCell, id: 'PWA-INTAKE-N1-N5A-N6A', title: `대상 경로: apps/pwa/src/app/intake/page.tsx\n- 완료 경계 증거 명령: bun test ${pwaCellTest}` } satisfies ChecklistItem;
const pkgRepo = realpathSync(mkdtempSync(join(tmpdir(), 'evidence-cli-pkg-')));
afterAll(() => { rmSync(pkgRepo, { recursive: true, force: true }); });
for (const [path, text] of [['package.json', '{}'], ['apps/pwa/package.json', '{}'], [pwaCellTest, ''], ['src/els/herdr-import.test.ts', '']] as const) {
  mkdirSync(join(pkgRepo, path, '..'), { recursive: true }); writeFileSync(join(pkgRepo, path), text);
}

test('evidence run of a package test runs from the package dir with the path relative to it — event data and evidence line carry «cwd apps/pwa»', () => {
  const fake = evidenceRunFake({ status: SUCCESS_RC, cell: pwaCell });
  const cwds: string[] = [];
  const deps: ChecklistEvidenceRunDeps = { ...fake.deps, cwd: pkgRepo, execute: (argv, cwd) => { fake.executed.push(argv); cwds.push(cwd); return { status: SUCCESS_RC }; } };
  const result = runChecklistEvidence('0.3.31', pwaCell.id, deps);
  expect(fake.executed).toEqual([['bun', 'test', 'src/app/intake/page.test.tsx']]);
  expect(cwds).toEqual([join(pkgRepo, 'apps/pwa')]);
  expect(fake.logged).toEqual([expect.objectContaining({ cwd: 'apps/pwa', argv: ['bun', 'test', 'src/app/intake/page.test.tsx'], command: `bun test ${pwaCellTest}` })]);
  expect(fake.appended[0]!.line).toBe(`E4 test 층 — runId ${runUuid} · event: ${CHECKLIST_EVIDENCE_RUN_EVENT} · ${runStartedAt} · host node-b · 칸 ${pwaCell.id} · 명령: bun test ${pwaCellTest} · cwd apps/pwa · rc 0 (evidence run · synthetic/test)`);
  expect(result.cwd).toBe('apps/pwa');
});

test('evidence run dispatch of a package test: the test host receipt names the same cwd — HQ line carries «cwd apps/pwa»; a receipt from another cwd is not a receipt', () => {
  const hostLogs: Record<string, unknown>[] = [];
  const hostRuns: { argv: readonly string[]; cwd: string }[] = [];
  const testHost = (request: EvidenceRunRequest): EvidenceDispatchOutcome => {
    const printed: string[] = [];
    const exit = runEvidenceReceipt([request.runId, request.cellId, request.version, request.host, request.ledgerHost, request.commit, ...request.argv], {
      execute: (argv, cwd) => { hostRuns.push({ argv, cwd }); return { status: SUCCESS_RC }; }, log: (data) => { hostLogs.push(data); }, selfReportedHost: () => 'MacStudioB1',
      now: () => new Date(runStartedAt), cwd: pkgRepo, print: (line) => { printed.push(line); },
    });
    return { kind: 'ran', rc: exit, receipt: parseEvidenceReceipt(printed.join('\n')), outputTail: ' 1 pass' };
  };
  const fake = evidenceRunFake({ status: SUCCESS_RC, cell: pwaCell, host: 'mshq', registry: testRegistry, dispatch: testHost });
  const result = runChecklistEvidence('0.3.31', pwaCell.id, { ...fake.deps, cwd: pkgRepo });
  expect(fake.dispatched[0]!.argv).toEqual(['bun', 'test', pwaCellTest]);
  expect(hostRuns.at(-1)).toEqual({ argv: ['bun', 'test', 'src/app/intake/page.test.tsx'], cwd: join(pkgRepo, 'apps/pwa') });
  expect(hostLogs[0]).toMatchObject({ cwd: 'apps/pwa', cellId: pwaCell.id });
  expect(fake.dispatchLogged[0]).toMatchObject({ cwd: 'apps/pwa', receipt: true });
  expect(fake.appended[0]!.line).toContain(`명령: bun test ${pwaCellTest} · cwd apps/pwa · rc 0 · 원장 mshq · 실행 node-b`);
  expect(result.cwd).toBe('apps/pwa');
  // The same receipt without the package cwd (a host that ran from the root) does not count.
  const rootHost = (request: EvidenceRunRequest): EvidenceDispatchOutcome => {
    const outcome = testHost(request);
    return outcome.kind === 'ran' && outcome.receipt ? { ...outcome, receipt: { ...outcome.receipt, cwd: undefined } } : outcome;
  };
  const mismatch = evidenceRunFake({ status: SUCCESS_RC, cell: pwaCell, host: 'mshq', registry: testRegistry, dispatch: rootHost });
  expect(runChecklistEvidence('0.3.31', pwaCell.id, { ...mismatch.deps, cwd: pkgRepo }).evidenceLine).toBeNull();
  expect(mismatch.appended).toEqual([]);
});

test('evidence run refuses a command mixing the root and a package — nothing executed, logged or written', () => {
  const cell = { ...pwaCell, title: `- 완료 경계 증거 명령: bun test src/els/herdr-import.test.ts ${pwaCellTest}` };
  const fake = evidenceRunFake({ status: SUCCESS_RC, cell });
  expect(() => runChecklistEvidence('0.3.31', cell.id, { ...fake.deps, cwd: pkgRepo })).toThrow('서로 다른 패키지');
  expect([fake.executed, fake.logged, fake.appended]).toEqual([[], [], []]);
});

test('nexusRegisteredHost trusts only hosts in the nexus host ledger (aliases included) and nobody when the ledger is unreadable', () => {
  const record = { host: 'node-b', channel: 'dev' as const, installedSha: runUuid, lastHeartbeatMs: Date.parse(runStartedAt), state: 'current' as const };
  const ledger = () => ({ version: 1 as const, hosts: { MacStudioB1: { ...record, host: 'MacStudioB1' } } });
  expect(nexusRegisteredHost('node-b', ledger)).toBe(true);
  expect(nexusRegisteredHost('evil.example', ledger)).toBe(false);
  expect(nexusRegisteredHost('node-b', () => undefined)).toBe(false);
  expect(nexusRegisteredHost('node-b', () => { throw new Error('host ledger corrupt'); })).toBe(false);
});

test('nexusRegisteredHost also trusts a registry alias recorded on the entry (registry data, not a name table)', () => {
  // 가상의 등록 이름·자기 보고 별칭(원장 자료로만 매핑된다 — 이름 표에 없는 쌍).
  const record = { host: 'testhost-a', aliases: ['TestHost-A-Studio'], channel: 'dev' as const, installedSha: hqHeadSha, lastHeartbeatMs: Date.parse(runStartedAt), state: 'current' as const };
  const ledger = () => ({ version: 1 as const, hosts: { 'testhost-a': record } });
  expect(nexusRegisteredHost('TestHost-A-Studio', ledger)).toBe(true);
  expect(nexusRegisteredHost('testhost-a', ledger)).toBe(true);
  expect(nexusRegisteredHost('OtherHost', ledger)).toBe(false);
});

// ── CHECKLIST-E4-RUN-RECEIPT — eln logs 부분 조회(종료 2 + _meta) ───────────────────────────────────────
// 리터럴 출처(2026-11-20 20:10 KST node-b 실측): `eln logs --all --include-test --json` 종료 2 · «test:universe-b 조회 실패 — unable to open database file»
//   · stdout 머리 _meta.type 'log-query-unreadable-instances' (src/cli/logs-cli.ts runLogsCli). 못 읽은 스토어 이름은 그 실측의 test:* 넷.
const unreadableStores = ['test:config', 'test:state', 'test:universe-a', 'test:universe-b'];
const unreadableMetaLine = JSON.stringify({ _meta: { type: 'log-query-unreadable-instances', unreadableInstanceCount: unreadableStores.length, unreadableInstances: unreadableStores } });
const receiptRow = (data: Record<string, unknown>) => JSON.stringify({ event: CHECKLIST_EVIDENCE_RUN_EVENT, data: JSON.stringify(data) });
const boundReceipt = { runId: runUuid, cellId: runCell.id, rc: SUCCESS_RC, host: 'node-b' };

/** prod 인스턴스 조회와 --all 연합 조회에 각각 다른 (종료 코드·stdout) 을 돌려주는 가짜 eln/ssh. */
function scopedLogsRunner(byScope: { prod: { status: number; stdout: string }; all: { status: number; stdout: string } }, calls: string[] = []): ChecklistEvidenceCommandRunner {
  return (command, args) => {
    if (command !== 'ssh' && !(command === 'eln' && args[0] === 'logs')) return { status: FAILURE_RC, stdout: '', stderr: '' };
    const line = command === 'ssh' ? args.at(-1)! : args.join(' ');
    const scope = line.includes('--instance') ? 'prod' : 'all';
    calls.push(`${command}:${scope}`);
    return { ...byScope[scope], stderr: scope === 'all' && byScope.all.status === ELN_LOGS_PARTIAL_READ_EXIT ? 'elanous logs: test:universe-b 조회 실패 — unable to open database file' : '' };
  };
}
const emptyProd = { status: SUCCESS_RC, stdout: '' };

function receiptLineFor(host: string): string {
  const { deps, appended } = evidenceRunFake({ status: SUCCESS_RC, host });
  runChecklistEvidence('0.3.31', runCell.id, deps);
  return appended[0]!.line;
}

test('E4: eln logs partial read (rc 2 + unreadable-instances meta) with the bound row → observed, remote and local', () => {
  const partialWithRow = { status: ELN_LOGS_PARTIAL_READ_EXIT, stdout: `${unreadableMetaLine}\n${receiptRow(boundReceipt)}\n` };
  const calls: string[] = [];
  const remote = collectChecklistEvidenceStages({ ...runCell, evidence: receiptLineFor('node-b') }, scopedLogsRunner({ prod: emptyProd, all: partialWithRow }, calls), evidenceHosts('mshq')).find((stage) => stage.id === 'E4');
  expect(remote?.state).toBe('observed');
  expect(calls).toEqual(['ssh:prod', 'ssh:all']);
  expect(String(remote?.source)).toContain('--all --include-test');
  const localCalls: string[] = [];
  const local = collectChecklistEvidenceStages({ ...runCell, evidence: receiptLineFor('node-b') }, scopedLogsRunner({ prod: emptyProd, all: partialWithRow }, localCalls), evidenceHosts('node-b')).find((stage) => stage.id === 'E4');
  expect(local?.state).toBe('observed');
  expect(localCalls).toEqual(['eln:prod', 'eln:all']);
});

test('E4: the prod instance holding the bound row answers alone — no --all federation query', () => {
  const calls: string[] = [];
  const e4 = collectChecklistEvidenceStages({ ...runCell, evidence: receiptLineFor('node-b') },
    scopedLogsRunner({ prod: { status: SUCCESS_RC, stdout: `${receiptRow(boundReceipt)}\n` }, all: { status: FAILURE_RC, stdout: '' } }, calls), evidenceHosts('mshq')).find((stage) => stage.id === 'E4');
  expect(e4?.state).toBe('observed');
  expect(calls).toEqual(['ssh:prod']);
  expect(String(e4?.source)).toContain('--instance prod');
});

test('E4: partial read without the bound row → unmeasurable naming the unreadable stores (not missing)', () => {
  const e4 = collectChecklistEvidenceStages({ ...runCell, evidence: receiptLineFor('node-b') },
    scopedLogsRunner({ prod: emptyProd, all: { status: ELN_LOGS_PARTIAL_READ_EXIT, stdout: `${unreadableMetaLine}\n` } }), evidenceHosts('mshq')).find((stage) => stage.id === 'E4');
  expect(e4?.state).toBe('unmeasurable');
  expect(e4?.reason).toContain('로그 부분 조회');
  for (const store of unreadableStores) expect(e4?.reason).toContain(store);
});

test('E4: partial read whose row binds another cell stays missing (binding kept)', () => {
  const e4 = collectChecklistEvidenceStages({ ...runCell, evidence: receiptLineFor('node-b') },
    scopedLogsRunner({ prod: emptyProd, all: { status: ELN_LOGS_PARTIAL_READ_EXIT, stdout: `${unreadableMetaLine}\n${receiptRow({ ...boundReceipt, cellId: 'OTHER-CELL' })}\n` } }), evidenceHosts('mshq')).find((stage) => stage.id === 'E4');
  expect(e4?.state).toBe('missing');
  expect(e4?.reason).toContain('칸 OTHER-CELL 에 결속돼 있다');
});

test('E4: rc 1, or rc 2 without the unreadable-instances meta, is still a failed query → unmeasurable as before', () => {
  for (const all of [{ status: FAILURE_RC, stdout: `${receiptRow(boundReceipt)}\n` }, { status: ELN_LOGS_PARTIAL_READ_EXIT, stdout: `${receiptRow(boundReceipt)}\n` }]) {
    const e4 = collectChecklistEvidenceStages({ ...runCell, evidence: receiptLineFor('node-b') }, scopedLogsRunner({ prod: emptyProd, all }), evidenceHosts('mshq')).find((stage) => stage.id === 'E4');
    expect(e4?.state).toBe('unmeasurable');
    expect(e4?.reason).toContain('원격 호스트 node-b 로그 조회 실패');
  }
});

test('dispatch readback: partial read with the bound row → observed; without it, or rc 1 → not observed', () => {
  const receipt = { runId: runUuid, cellId: runCell.id, version: '0.3.31', host: 'node-b', selfReportedHost: 'MacStudioB1', ledgerHost: 'mshq', commit: hqHeadSha, command: 'bun test src/els/', rc: SUCCESS_RC, durationMs: 0, at: runStartedAt };
  const calls: string[] = [];
  expect(remoteEvidenceEventObserved('node-b', receipt, scopedLogsRunner({ prod: emptyProd, all: { status: ELN_LOGS_PARTIAL_READ_EXIT, stdout: `${unreadableMetaLine}\n${receiptRow(boundReceipt)}\n` } }, calls))).toBe(true);
  expect(calls).toEqual(['ssh:prod', 'ssh:all']);
  const prodCalls: string[] = [];
  expect(remoteEvidenceEventObserved('node-b', receipt, scopedLogsRunner({ prod: { status: SUCCESS_RC, stdout: `${receiptRow(boundReceipt)}\n` }, all: { status: FAILURE_RC, stdout: '' } }, prodCalls))).toBe(true);
  expect(prodCalls).toEqual(['ssh:prod']);
  expect(remoteEvidenceEventObserved('node-b', receipt, scopedLogsRunner({ prod: emptyProd, all: { status: ELN_LOGS_PARTIAL_READ_EXIT, stdout: `${unreadableMetaLine}\n` } }))).toBe(false);
  expect(remoteEvidenceEventObserved('node-b', receipt, scopedLogsRunner({ prod: emptyProd, all: { status: FAILURE_RC, stdout: `${receiptRow(boundReceipt)}\n` } }))).toBe(false);
  expect(remoteEvidenceEventObserved('node-b', receipt, scopedLogsRunner({ prod: emptyProd, all: { status: ELN_LOGS_PARTIAL_READ_EXIT, stdout: `${unreadableMetaLine}\n${receiptRow({ ...boundReceipt, cellId: 'OTHER-CELL' })}\n` } }))).toBe(false);
});
