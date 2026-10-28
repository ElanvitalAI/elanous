// ── `pty list` 가 workdir 을 보여준다 (2026-08-02) ─────────────────────────────
//
// ⛔ 2026-08-02 에 **두 세션이 각각** 남의 TUI 를 집어 입력을 보냈다. 둘 다 원인이 같다:
//    `pty list` 가 id·kind·alive 만 줘서 *"내가 방금 띄웠으니 이게 내 것"* 이라는 **추론**이
//    유일한 소유 근거였다. workdir 은 registry handle 과 manifest 양쪽에 **이미 있었고**
//    목록이 안 보여줬을 뿐이다. ⇒ 이 파일이 그 회귀를 막는다.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunLedger, runLedgerPath } from '../self-implement/run-ledger.js';
import type { PtyManifestRow } from '../pty-shell/pty-manifest.js';
import { federatedPtyRefs, listPtyRefs, ptyGitDiscoveryEnv, resolvePtyWorktreeProvenance, runLedgerTermination, runPtyList, type PtyTakeoverCommandDeps, type PtyWorktreeProvenance } from './pty-takeover-cli.js';

/** ⭐ `runPtyList` 는 `listRefs`·`log` 만 쓴다. 나머지 필수 deps 는 **불리면 터지는 스텁**으로
 *  채운다 — 그래야 계약을 지우지 않으면서(`as never` 없이) 그 경로만 잰다. 스텁이 터지면
 *  *"이 명령이 안 쓰던 것을 쓰기 시작했다"* 는 뜻이라, 그 자체가 회귀 신호다. */
const listOnlyDeps = (
  listRefs: PtyTakeoverCommandDeps['listRefs'],
): PtyTakeoverCommandDeps => ({
  listRefs,
  log: () => {},
  getPty: () => { throw new Error('runPtyList must not call getPty'); },
  requestPtyTakeover: () => { throw new Error('runPtyList must not call requestPtyTakeover'); },
  requestRemote: () => { throw new Error('runPtyList must not call requestRemote'); },
});

/** ⚠️ 헬퍼가 falsy 를 걸러 버리면 빈 문자열 분기를 **테스트가 못 탄다**(무인 리뷰 must-fix).
 *  ⇒ `workdir` 을 **그대로** 싣는다. 키를 아예 빼려면 인자를 생략한다. */
type LocalHandle = Parameters<typeof listPtyRefs>[0][number];
const handle = (id: string, workdir?: string): LocalHandle => ({
  id,
  kind: 'pty',
  isAlive: () => true,
  accessMode: 'auto' as const,
  workdir,          // ⭐ undefined 도 '' 도 **그대로** 넘긴다 — 걸러 버리면 그 분기를 못 탄다
});

const manifestRow = (id: string, runId: string): PtyManifestRow => ({
  id, kind: 'pty', cmd: 'bun', ownerPid: 1, ptyPid: 1, instance: 'test', startedAt: 0,
  alive: true, exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 0, frame: '', frameAt: 0,
  outputBytesTotal: 0, runId, runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '',
  parentKind: '', parentPid: 0, closedAt: 0, codeSha: '',
});

describe('listPtyRefs — workdir 노출', () => {
  test('⭐ 로컬 handle 의 workdir 이 행에 실린다', () => {
    const [row] = listPtyRefs([handle('pty_a', '/repo/wt-a')], []);
    expect(row!.workdir).toBe('/repo/wt-a');
  });

  test('⭐ manifest 행의 workdir 도 실린다 (원격 소유 PTY)', () => {
    const [row] = listPtyRefs([], [{ id: 'pty_b', kind: 'pty', alive: true, workdir: '/repo/wt-b' }]);
    expect(row!.workdir).toBe('/repo/wt-b');
  });

  // ⚠️ 빈 문자열도 **없음과 같게** 다룬다 — `''` 를 workdir 로 실으면 목록이 빈 칸을 보여 주는데,
  //    그건 *"루트에서 돈다"* 처럼 읽힌다. 없음이 정확하다.
  test('workdir 이 없거나 빈 문자열이면 키를 만들지 않는다', () => {
    expect('workdir' in listPtyRefs([handle('pty_c')], [])[0]!).toBe(false);
    expect('workdir' in listPtyRefs([handle('pty_d', '')], [])[0]!).toBe(false);
    expect('workdir' in listPtyRefs([], [{ id: 'pty_e', kind: 'pty', alive: true, workdir: '' }])[0]!).toBe(false);
  });

  // ⭐⭐ 소유가 갈리는 그 순간 — 같은 alive 두 PTY 를 workdir 로 구별한다.
  test('⭐⭐ 서로 다른 트리의 두 PTY 가 workdir 로 갈린다', () => {
    const rows = listPtyRefs(
      [handle('pty_mine', '/repo/wt-mine'), handle('pty_theirs', '/repo/wt-theirs')],
      [],
    );
    expect(rows.map((r) => r.workdir)).toEqual(['/repo/wt-mine', '/repo/wt-theirs']);
  });

  test('같은 ID의 로컬 handle은 실시간 상태를 유지하고 manifest origin 결정을 병합한다', () => {
    const refs = listPtyRefs(
      [handle('pty_local', '/repo/current')],
      [{
        id: 'pty_local', kind: 'stale-kind', nickname: 'stale-name', alive: false, workdir: '/repo/stale', runId: 'run-elanous',
        terminalOriginCategory: 'elanous', terminalOriginReason: 'inherited-elanous-marker',
      }],
    );
    expect(refs).toEqual([expect.objectContaining({
      id: 'pty_local', kind: 'pty', source: 'local', alive: true, mode: 'auto', workdir: '/repo/current',
      terminalOriginCategory: 'elanous', terminalOriginReason: 'inherited-elanous-marker',
    })]);
    const result = runPtyList(listOnlyDeps(() => refs));
    expect(result.message).toContain('origin=elanous reason=inherited-elanous-marker');
  });
});

// ⛔⭐⭐⭐ 무인 리뷰 must-fix — 중간 객체만 재면 **출력 컬럼을 지워도 통과**한다.
//    사람이 보는 것은 문자열이므로 그 문자열을 잰다.
describe('runPtyList — 출력 문자열에 workdir 이 실린다', () => {
  test('⭐ 행 끝 칸이 workdir 이다', () => {
    const r = runPtyList(listOnlyDeps(() => [
      { id: 'pty_mine', kind: 'pty', source: 'local', alive: true, mode: 'auto', workdir: '/repo/wt-mine' },
      { id: 'pty_theirs', kind: 'pty', source: 'local', alive: true, mode: 'auto', workdir: '/repo/wt-theirs' },
    ]));
    expect(r.exitCode).toBe(0);
    const rows = r.message!.split('\n').map((line) => line.split('\t'));
    expect(rows.slice(0, 2).map((c) => c.slice(-4))).toEqual([['/repo/wt-mine', '-', 'origin=unknown reason=legacy-or-malformed-origin-decision', 'purpose=workdir-missing-path'], ['/repo/wt-theirs', '-', 'origin=unknown reason=legacy-or-malformed-origin-decision', 'purpose=workdir-missing-path']]);
    expect(rows[2]).toEqual(['purpose-known rows: 0/2']);
  });

  test('workdir 이 없으면 그 칸이 - 다 (칸 수는 유지)', () => {
    const r = runPtyList(listOnlyDeps(() => [
      { id: 'pty_x', kind: 'pty', source: 'local', alive: true, mode: 'auto' },
    ]));
    const [line, denominator] = r.message!.split('\n');
    const cells = line!.split('\t');
    expect(cells.slice(-4)).toEqual(['-', '-', 'origin=unknown reason=legacy-or-malformed-origin-decision', 'purpose=workdir-not-recorded']);
    expect(cells).toHaveLength(10);
    expect(denominator).toBe('purpose-known rows: 0/1');
  });
});

describe('resolvePtyWorktreeProvenance — worktree 목적 config', () => {
  const git = (...results: Array<{ status: number | null; stdout?: string; stderr?: string; error?: Error }>) => {
    let index = 0;
    return (_args: readonly string[], _cwd: string) => ({ stdout: '', stderr: '', ...results[index++]! });
  };

  test('세 producer key를 row workdir cwd에서 읽고 부분 성공과 빈 값은 생략한다', () => {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const runGit = git(
      { status: 0, stdout: 'true\n' }, { status: 0, stdout: 'goal-1\n' }, { status: 0, stdout: ' \n' }, { status: 1 },
    );
    const result = resolvePtyWorktreeProvenance('/repo/wt', {
      inspectPath: () => {},
      runGit: (args, cwd) => { calls.push({ args, cwd }); return runGit(args, cwd); },
    });
    expect(result).toEqual({ known: true, goalId: 'goal-1' });
    expect(calls).toEqual([
      { args: ['rev-parse', '--is-inside-work-tree'], cwd: '/repo/wt' },
      { args: ['config', '--worktree', '--get', 'elanous.harness.goalId'], cwd: '/repo/wt' },
      { args: ['config', '--worktree', '--get', 'elanous.harness.goalFile'], cwd: '/repo/wt' },
      { args: ['config', '--worktree', '--get', 'elanous.harness.goalTitle'], cwd: '/repo/wt' },
    ]);
  });

  test('모든 named absence reason과 git 실행 오류를 구분한다', () => {
    const cases: Array<[string | undefined, PtyWorktreeProvenance, Parameters<typeof resolvePtyWorktreeProvenance>[1]]> = [
      [undefined, { known: false, provenanceReason: 'workdir-not-recorded' }, {}],
      ['/gone', { known: false, provenanceReason: 'workdir-missing-path' }, { inspectPath: () => { const error = new Error('missing') as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; } }],
      // ⭐ 아래 셋은 git 이 «똑같이» status 128 로 죽는다 — 가르는 것은 stderr 문면이 아니라 `.git` 의 유무다.
      ['/plain', { known: false, provenanceReason: 'not-git-worktree' }, { inspectPath: () => {}, runGit: git({ status: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' }), hasGitEntry: () => 'absent' as const }],
      ['/broken-linked-worktree', { known: false, provenanceReason: 'git-read-failed' }, { inspectPath: () => {}, runGit: git({ status: 128, stderr: 'fatal: not a git repository: /repo/.git/worktrees/broken' }), hasGitEntry: () => 'present' as const }],
      ['/protected', { known: false, provenanceReason: 'git-read-failed' }, { inspectPath: () => { const error = new Error('denied') as NodeJS.ErrnoException; error.code = 'EACCES'; throw error; } }],
      ['/dubious', { known: false, provenanceReason: 'git-read-failed' }, { inspectPath: () => {}, runGit: git({ status: 128, stderr: 'fatal: detected dubious ownership in repository' }), hasGitEntry: () => 'present' as const }],
      ['/repo', { known: false, provenanceReason: 'config-not-recorded' }, { inspectPath: () => {}, runGit: git({ status: 0, stdout: 'true' }, { status: 1 }, { status: 1 }, { status: 1 }) }],
      ['/repo', { known: false, provenanceReason: 'git-read-failed' }, { inspectPath: () => {}, runGit: git({ status: 0, stdout: 'true' }, { status: null, error: new Error('spawn failed') }) }],
    ];
    for (const [workdir, expected, deps] of cases) expect(resolvePtyWorktreeProvenance(workdir, deps)).toEqual(expected);
  });

  // ⛔ 리뷰가 3라운드 연속 지적하고 자식이 «정규식만 고쳐» 넘지 못한 자리 — 회귀로 못 박는다.
  test('git 이 «무엇이라 쓰든» 판정이 안 바뀐다 — 로케일·판본 독립', () => {
    const stderrs = [
      'fatal: not a git repository (or any of the parent directories): .git',
      'fatal: 깃 저장소가 아닙니다',                       // 한국어 로케일
      'schwerwiegend: kein Git-Repository',                // 독일어 로케일
      '',                                                  // 아무 말도 안 한 경우
    ];
    for (const stderr of stderrs) {
      expect(resolvePtyWorktreeProvenance('/x', { inspectPath: () => {}, runGit: git({ status: 128, stderr }), hasGitEntry: () => 'absent' as const }))
        .toEqual({ known: false, provenanceReason: 'not-git-worktree' });
      expect(resolvePtyWorktreeProvenance('/x', { inspectPath: () => {}, runGit: git({ status: 128, stderr }), hasGitEntry: () => 'present' as const }))
        .toEqual({ known: false, provenanceReason: 'git-read-failed' });
    }
  });

  // ⛔ 리뷰 must-fix — 「못 봤다」를 「없다」로 접으면 권한 오류인 «진짜 저장소»가 not-git-worktree 로 둔갑한다.
  test('probe 가 「모른다」면 «없다»로 단정하지 않는다', () => {
    expect(resolvePtyWorktreeProvenance('/x', { inspectPath: () => {}, runGit: git({ status: 128 }), hasGitEntry: () => 'unknown' as const }))
      .toEqual({ known: false, provenanceReason: 'git-read-failed' });
  });

  // ⛔⭐ 리뷰 should-fix — 위 시험들은 probe 를 «주입»해 resolver 분기만 잰다.
  //   그러면 production probe 가 통째로 망가져도 통과한다. ⇒ 주입 «없이» 실제 파일시스템으로 한 번 문다.
  test('주입 없이 — 실제 파일시스템에서 상위 `.git` 을 찾는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'pty-provenance-'));
    try {
      mkdirSync(join(root, 'repo', 'wt'), { recursive: true });
      writeFileSync(join(root, 'repo', '.git'), 'gitdir: /elsewhere\n');
      // git 이 status 128 로 죽어도, `.git` 이 «실제로 있으므로» 「저장소가 아니다」가 아니라 「못 읽었다」다.
      expect(resolvePtyWorktreeProvenance(join(root, 'repo', 'wt'), { runGit: git({ status: 128, stderr: 'fatal: whatever' }) }))
        .toEqual({ known: false, provenanceReason: 'git-read-failed' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ⛔⭐ 리뷰 must-fix — git 은 «실경로»에서 조상을 훑는다. 링크의 «어휘상» 부모는 실제 조상이 아니다.
  test('주입 없이 — 심볼릭 링크 workdir 에서도 «실제» 조상의 `.git` 을 본다', () => {
    const root = mkdtempSync(join(tmpdir(), 'pty-provenance-link-'));
    try {
      mkdirSync(join(root, 'repo', 'wt'), { recursive: true });
      writeFileSync(join(root, 'repo', '.git'), 'gitdir: /elsewhere\n');
      mkdirSync(join(root, 'elsewhere'), { recursive: true });      // 링크가 놓일 «다른» 가지 — 여기엔 .git 이 없다
      symlinkSync(join(root, 'repo', 'wt'), join(root, 'elsewhere', 'link'));
      // 어휘상 부모(root/elsewhere)에는 .git 이 없다 ⇒ realpath 를 안 쓰면 not-git-worktree 로 «틀린다».
      expect(resolvePtyWorktreeProvenance(join(root, 'elsewhere', 'link'), { runGit: git({ status: 128, stderr: 'fatal: whatever' }) }))
        .toEqual({ known: false, provenanceReason: 'git-read-failed' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ⛔⭐ 리뷰 must-fix — git 의 «탐색 정책»을 바꾸는 환경변수가 상속되면 git 과 probe 가 다른 규칙으로
  //   저장소를 찾아 「저장소가 아니다」와 「못 읽었다」가 어긋난다. ⇒ 그 노브만 걷어낸 환경에서 돌린다.
  test('git 탐색 노브 환경변수를 걷어내고, 나머지는 그대로 둔다', () => {
    const before = { PATH: '/usr/bin', HOME: '/home/x', GIT_DIR: '/hijack/.git', GIT_WORK_TREE: '/hijack', GIT_CEILING_DIRECTORIES: '/', GIT_DISCOVERY_ACROSS_FILESYSTEM: '1', GIT_COMMON_DIR: '/hijack/.git' };
    const after = ptyGitDiscoveryEnv(before);
    expect(after).toEqual({ PATH: '/usr/bin', HOME: '/home/x' });
    expect(before.GIT_DIR).toBe('/hijack/.git');   // ⛔ 원본을 «변형하지 않는다»
  });

  // ⛔⭐⭐ 리뷰 should-fix — 위 시험은 «순수 함수»만 잰다. 그러면 정규화가 spawn 에 «안 배선돼도» 통과한다.
  //   ⇒ 진짜 git 저장소를 만들고 GIT_DIR 을 «납치»한 뒤, 실제 runner 경로가 그것에 안 속는지 «실물»로 문다.
  test('배선 확인 — 납치된 GIT_DIR 이 있어도 실제 git 호출이 안 속는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'pty-provenance-env-'));
    const saved = { dir: process.env.GIT_DIR, ceiling: process.env.GIT_CEILING_DIRECTORIES };
    try {
      const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
      // ⛔ 준비 실패를 «조용히 통과»시키지 않는다 — 「측정 불가」를 「통과」로 위장하면 이 시험은 영영 안 문다
      //   (리뷰 must-fix · 이 저장소가 반복해 적은 그 형태다).
      expect({ status: init.status, stderr: (init.stderr ?? '').slice(0, 200) }).toEqual({ status: 0, stderr: '' });
      process.env.GIT_DIR = join(root, 'nonexistent-hijack.git');
      process.env.GIT_CEILING_DIRECTORIES = root;
      // 납치를 안 걷어내면 git 이 이 저장소를 «못 찾아» not-git-worktree / git-read-failed 가 된다.
      expect(resolvePtyWorktreeProvenance(root)).toEqual({ known: false, provenanceReason: 'config-not-recorded' });
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
      if (saved.ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = saved.ceiling;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ⛔⭐⭐⭐ 리뷰 should-fix — 여기까지의 실물 시험은 «부재» 갈래만 잰다. 「값이 실제로 읽히나」는 «안 쟀다».
  //   ⇒ 진짜 저장소에 producer 세 키를 «실제로» 쓰고, 주입 «없는» resolver 와 목록 산출이 그것을 읽는지 문다.
  test('배선 확인 — 진짜 워크트리 config 세 키를 주입 없이 읽어 목록까지 싣는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'pty-provenance-known-'));
    try {
      const run = (...args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
      expect(spawnSync('git', ['init', '-q', root], { encoding: 'utf8' }).status).toBe(0);
      expect(run('config', 'extensions.worktreeConfig', 'true').status).toBe(0);
      for (const [key, value] of [['goalId', 'g-1'], ['goalFile', '/goals/g-1.md'], ['goalTitle', 'Purpose\there']] as const) {
        expect(run('config', '--worktree', `elanous.harness.${key}`, value).status).toBe(0);
      }
      // ⑴ resolver 를 «주입하지 않고» — 실제 git 이 값을 돌려준다
      expect(resolvePtyWorktreeProvenance(root)).toEqual({ known: true, goalId: 'g-1', goalFile: '/goals/g-1.md', goalTitle: 'Purpose\there' });
      // ⑵ 그 값이 «목록 산출»까지 닿는다 ⊕ 탭이 행을 안 깬다 ⊕ 분모가 같이 움직인다
      const text = runPtyList(listOnlyDeps(() => [{ id: 'x', kind: 'pty', source: 'local', alive: true, mode: 'auto', workdir: root }])).message!;
      const lines = text.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]!.split('\t')).toHaveLength(10);
      expect(lines[0]).toContain('goalId=g-1 goalFile=/goals/g-1.md goalTitle=Purpose here');
      expect(lines[1]).toBe('purpose-known rows: 1/1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ⛔ 리뷰 must-fix — 타입이 허용하는 «빈 known» 이 골 칸도 사유도 없는 행을 만든다.
  test('골 칸이 하나도 없는 known 은 config-not-recorded 로 정규화된다', () => {
    const empty = (): PtyWorktreeProvenance => ({ known: true });
    const r = runPtyList({
      ...listOnlyDeps(() => [{ id: 'x', kind: 'pty', source: 'local', alive: true, mode: 'auto', workdir: '/repo/x' }]),
      resolveWorktreeProvenance: empty,
    });
    const [line, denominator] = r.message!.split('\n');
    expect(line!.split('\t').slice(-1)).toEqual(['purpose=config-not-recorded']);   // 빈 칸이 아니다
    expect(denominator).toBe('purpose-known rows: 0/1');                            // «앎» 계수도 같이 움직인다
  });
});

describe('runPtyList — worktree provenance output', () => {
  const provenance = (workdir?: string): PtyWorktreeProvenance => workdir === '/repo/known'
    ? { known: true, goalId: 'goal-1', goalFile: 'goals/goal-1.md', goalTitle: 'Purpose' }
    : { known: false, provenanceReason: workdir ? 'config-not-recorded' : 'workdir-not-recorded' };

  test('explicit shell purpose fills absent goal while a recorded git goal keeps precedence', () => {
    const refs = () => [
      { id: 'shell_new', kind: 'shell', source: 'remote' as const, alive: true, workdir: '/repo/no-goal', purpose: 'tui-shell' },
      { id: 'shell_goal', kind: 'shell', source: 'remote' as const, alive: true, workdir: '/repo/known', purpose: 'tui-shell' },
    ];
    const result = runPtyList({ ...listOnlyDeps(refs), resolveWorktreeProvenance: provenance });
    const [shell, goal, count] = result.message!.split('\n');
    expect(shell).toContain('purpose=tui-shell');
    expect(goal).toContain('goalId=goal-1');
    expect(goal).not.toContain('purpose=tui-shell');
    expect(count).toBe('purpose-known rows: 2/2');
  });

  test('JSON current and federated paths project values or exactly one named absence reason', () => {
    const base: Omit<PtyManifestRow, 'id' | 'workdir'> = { kind: 'pty', cmd: 'bun', ownerPid: 1, ptyPid: 1, instance: 'test', startedAt: 0, alive: true, exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 0, frame: '', frameAt: 0, outputBytesTotal: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentKind: '', parentPid: 0, closedAt: 0, codeSha: '' };
    const deps: PtyTakeoverCommandDeps = {
      ...listOnlyDeps(() => []), currentManifestDbPath: () => '/test/pty/manifest.db', manifestTargets: () => [{ name: 'test', dbPath: '/test/pty/manifest.db' }],
      listManifestRowsAt: () => [{ ...base, id: 'known', workdir: '/repo/known' }, { ...base, id: 'absent' }], isProcessAlive: () => true, now: () => 0, resolveWorktreeProvenance: provenance,
    };
    const rows = JSON.parse(runPtyList(deps, { json: true }).message);
    expect(rows).toEqual([expect.objectContaining({ id: 'known', goalId: 'goal-1', goalFile: 'goals/goal-1.md', goalTitle: 'Purpose' }), expect.objectContaining({ id: 'absent', provenanceReason: 'workdir-not-recorded' })]);
    expect(rows.every((row: { goalId?: string; goalFile?: string; goalTitle?: string; provenanceReason?: string }) => Boolean(row.goalId || row.goalFile || row.goalTitle) !== Boolean(row.provenanceReason))).toBe(true);
    const text = runPtyList({ ...deps, listRefs: () => [{ id: 'known', kind: 'pty', source: 'local', alive: true, mode: 'auto', workdir: '/repo/known' }, { id: 'absent', kind: 'pty', source: 'local', alive: true, mode: 'auto' }] }).message!;
    expect(text).toContain('goalId=goal-1 goalFile=goals/goal-1.md goalTitle=Purpose');
    expect(text).toContain('purpose-known rows: 1/2');
  });

  test('연합 JSON과 text path 모두 모든 goal 필드를 보존하고 zero rows have denominator', () => {
    const base: Omit<PtyManifestRow, 'id' | 'workdir'> = { kind: 'pty', cmd: 'bun', ownerPid: 1, ptyPid: 1, instance: 'test', startedAt: 0, alive: true, exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 0, frame: '', frameAt: 0, outputBytesTotal: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentKind: '', parentPid: 0, closedAt: 0, codeSha: '' };
    const federatedDeps: PtyTakeoverCommandDeps = {
      ...listOnlyDeps(() => []), currentManifestDbPath: () => '/test/pty/manifest.db', manifestTargets: () => [{ name: 'test', dbPath: '/test/pty/manifest.db' }],
      listManifestRowsAt: () => [{ ...base, id: 'known', workdir: '/repo/known' }, { ...base, id: 'absent' }], isProcessAlive: () => true, now: () => 0,
      listFederatedRefs: () => ({ refs: [{ instance: 'test', id: 'known', kind: 'pty', alive: true, workdir: '/repo/known' }], unreadable: [] }), resolveWorktreeProvenance: provenance,
    };
    const json = JSON.parse(runPtyList(federatedDeps, { all: true, json: true }).message);
    expect(json).toEqual([expect.objectContaining({ id: 'known', goalId: 'goal-1', goalFile: 'goals/goal-1.md', goalTitle: 'Purpose' }), expect.objectContaining({ id: 'absent', provenanceReason: 'workdir-not-recorded' })]);
    const result = runPtyList(federatedDeps, { all: true });
    expect(result.message).toContain('goalId=goal-1 goalFile=goals/goal-1.md goalTitle=Purpose\npurpose-known rows: 1/1');
    expect(runPtyList(listOnlyDeps(() => [])).message).toBe('pty list: no PTYs found (scope: current instance only)\npurpose-known rows: 0/0');
  });

  // ⛔ 리뷰 should-fix — config 값은 «사람이 쓴 문서»에서 온다. 탭이면 칸이 늘고 개행이면 행이 «위조»된다.
  test('goal 값의 탭·개행이 행을 깨거나 위조하지 않는다', () => {
    const nasty = (): PtyWorktreeProvenance => ({ known: true, goalTitle: 'first\tcol\nfake\trow' });
    const text = runPtyList({
      ...listOnlyDeps(() => [{ id: 'x', kind: 'pty', source: 'local', alive: true, mode: 'auto', workdir: '/repo/known' }]),
      resolveWorktreeProvenance: nasty,
    }).message!;
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);                            // 데이터 1행 ⊕ 분모 1줄 — «위조된 행이 없다»
    expect(lines[0]!.split('\t')).toHaveLength(10);            // 칸 수가 안 늘었다
    expect(text).toContain('goalTitle=first col fake row');   // 값은 «버리지 않고» 한 줄로 접었다
    expect(lines[1]).toBe('purpose-known rows: 1/1');
  });
});

describe('runPtyList — runId 노출', () => {
  test('지정한 두 매니페스트 행의 비어 있지 않은 runId만 JSON과 사람 목록에 싣는다', () => {
    const rows = [manifestRow('pty_run', 'run-11111111'), manifestRow('pty_legacy', '')];
    const refs = listPtyRefs([], rows);
    const text = runPtyList(listOnlyDeps(() => refs));
    expect(text.exitCode).toBe(0);
    expect(text.message).toBe('pty_run\tpty\t-\tremote\talive\t?\t-\trun-11111111\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded\npty_legacy\tpty\t-\tremote\talive\t?\t-\t-\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded\npurpose-known rows: 0/2');

    const json = runPtyList({
      ...listOnlyDeps(() => refs),
      currentManifestDbPath: () => '/test/pty/manifest.db',
      manifestTargets: () => [{ name: 'test', dbPath: '/test/pty/manifest.db' }],
      listManifestRowsAt: () => rows,
      isProcessAlive: () => true,
      now: () => 0,
    }, { json: true });
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.message)).toEqual([
      expect.objectContaining({ id: 'pty_run', runId: 'run-11111111' }),
      expect.not.objectContaining({ runId: expect.anything() }),
    ]);
  });

  test('로컬 PTY는 같은 id의 매니페스트 runId를 조인하지 않는다', () => {
    const [row] = listPtyRefs([handle('pty_run')], [manifestRow('pty_run', 'run-11111111')]);
    expect(row).toEqual(expect.not.objectContaining({ runId: expect.anything() }));
  });

  test('연합 사람 목록은 매니페스트 원본 행의 비어 있지 않은 runId만 싣는다', () => {
    const listing = federatedPtyRefs(
      [{ name: 'test', dbPath: '/test/pty/manifest.db' }],
      () => [
        { id: 'pty_run', kind: 'pty', alive: true, ownerPid: 1, runId: 'run-11111111' },
        { id: 'pty_legacy', kind: 'pty', alive: true, ownerPid: 1, runId: '' },
      ],
      () => true,
    );
    const result = runPtyList({
      ...listOnlyDeps(() => []),
      listFederatedRefs: () => listing,
      runTerminated: (runId) => runId === 'run-11111111' ? false : 'no-run-id',
    }, { all: true });
    expect(result.exitCode).toBe(0);
    expect(result.message).toBe('test\t-\tpty_run\tpty\t-\talive\trun-11111111\trunning\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded\ntest\t-\tpty_legacy\tpty\t-\talive\t-\tno-run-id\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded\npurpose-known rows: 0/2');
  });
});

describe('runPtyList terminal origin projection', () => {
  test('preserves JSON fields and renders distinct non-empty human, elanous, and external origins locally and federated', () => {
    const refs = [
      { id: 'human', kind: 'pty', source: 'local' as const, alive: true, mode: 'auto' as const, terminalOriginCategory: 'direct-human' as const, terminalOriginReason: 'inherited-human-cli-marker' },
      { id: 'harness', kind: 'pty', source: 'local' as const, alive: true, mode: 'auto' as const, terminalOriginCategory: 'elanous' as const, terminalOriginReason: 'inherited-elanous-marker' },
      { id: 'tool', kind: 'pty', source: 'remote' as const, alive: true, terminalOriginCategory: 'external-tool' as const, terminalOriginReason: 'inherited-external-agent-marker', externalToolName: 'codex' },
    ];
    const json = JSON.parse(runPtyList({
      ...listOnlyDeps(() => []),
      currentManifestDbPath: () => '/test/pty/manifest.db',
      manifestTargets: () => [{ name: 'test', dbPath: '/test/pty/manifest.db' }],
      listManifestRowsAt: () => refs.map((ref, index) => ({ id: ref.id, kind: ref.kind, cmd: 'bun', ownerPid: 1, ptyPid: index + 1, instance: 'test', startedAt: 0, alive: true, exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 0, frame: '', frameAt: 0, outputBytesTotal: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '', terminalOriginCategory: ref.terminalOriginCategory, terminalOriginReason: ref.terminalOriginReason, ...(ref.externalToolName ? { externalToolName: ref.externalToolName } : {}) })),
      isProcessAlive: () => true,
      now: () => 0,
    }, { json: true }).message!);
    expect(json.map((row: { terminalOriginCategory: string; terminalOriginReason: string }) => [row.terminalOriginCategory, row.terminalOriginReason])).toEqual([
      ['direct-human', 'inherited-human-cli-marker'], ['elanous', 'inherited-elanous-marker'], ['external-tool', 'inherited-external-agent-marker'],
    ]);
    expect(json[2].externalToolName).toBe('codex');
    const localText = runPtyList(listOnlyDeps(() => refs)).message!;
    expect(localText).toContain('origin=direct-human reason=inherited-human-cli-marker');
    expect(localText).toContain('origin=elanous reason=inherited-elanous-marker');
    const federatedRefs = refs.map((ref) => ({ ...ref, instance: 'test', sourceRoot: '/test/pty/manifest.db' }));
    const federatedText = runPtyList({ ...listOnlyDeps(() => []), listFederatedRefs: () => ({ refs: federatedRefs, unreadable: [] }) }, { all: true }).message!;
    expect(federatedText).toContain('origin=external-tool reason=inherited-external-agent-marker tool=codex');
  });
});

describe('runPtyList --json — 회수 판단 관측값', () => {
  test('기존 은퇴 증명의 생존·경과와 실행 종결 상태를 구조화 행에 낸다', () => {
    const deps: PtyTakeoverCommandDeps = {
      ...listOnlyDeps(() => []),
      currentManifestDbPath: () => '/test/pty/manifest.db',
      manifestTargets: () => [{ name: 'test', dbPath: '/test/pty/manifest.db' }],
      listManifestRowsAt: () => [{
        id: 'pty_observed', kind: 'tui', cmd: 'bun', ownerPid: 123, ptyPid: 456, instance: 'test', startedAt: 10,
        alive: true, exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 900, frame: '', frameAt: 0, outputBytesTotal: 0, lastControlAt: 800,
        runId: 'run-observed', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '', workdir: '/repo/wt',
      }],
      isProcessAlive: (pid) => pid === 456,
      now: () => 1_000,
      runTerminated: (runId) => runId === 'run-observed',
    };
    const result = runPtyList(deps, { json: true });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.message)).toEqual([{
      id: 'pty_observed', kind: 'tui', instance: 'test', sourceRoot: { name: 'test', dbPath: '/test/pty/manifest.db' }, alive: true, workdir: '/repo/wt',
      ownerProcessAlive: true, updatedAgeMs: 100, ageMs: 990, outputBytesTotal: 0, lastControlAt: 800, runId: 'run-observed', runTerminated: true, runTerminationSource: 'unknown', runStoreIo: 'not-checked', ownerRunUsage: 'terminated-live-owner', provenanceReason: 'workdir-missing-path', terminalOriginCategory: 'unknown', terminalOriginReason: 'legacy-or-malformed-origin-decision',
      // ⭐ #14980 이 원격·로컬 «키 대칭»을 위해 더한 셋 — null 은 「모른다」이지 「없다」가 아니다.
      webUrl: null, webUrlSource: null, pwaUnavailableReason: null,
      // ⭐ H10 — 턴·판 칸은 «언제나» 실린다(턴 기록 없는 행 = unknown/null).
      turn: { state: 'unknown', at: null, sinceSec: null }, progress: 'unknown', build: null,
    }]);
  });

  test('실행 원장을 알 수 없으면 unknown을 명시하고 기본 표는 바이트 동일하다', () => {
    const textDeps = listOnlyDeps(() => [{ id: 'pty_text', kind: 'pty', source: 'local', alive: true, mode: 'auto', workdir: '/repo/wt' }]);
    expect(runPtyList(textDeps).message).toBe('pty_text\tpty\t-\tlocal\talive\tauto\t/repo/wt\t-\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-missing-path\npurpose-known rows: 0/1');

    const jsonDeps: PtyTakeoverCommandDeps = {
      ...textDeps,
      currentManifestDbPath: () => '/test/pty/manifest.db',
      manifestTargets: () => [{ name: 'test', dbPath: '/test/pty/manifest.db' }],
      listManifestRowsAt: () => [{
        id: 'pty_unknown', kind: 'pty', cmd: 'bun', ownerPid: 1, ptyPid: 0, instance: 'test', startedAt: 0,
        alive: true, exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 0, frame: '', frameAt: 0, outputBytesTotal: 0,
        runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentKind: '', parentPid: 0, closedAt: 0, codeSha: '',
      }],
      isProcessAlive: () => true,
      now: () => 0,
    };
    expect(JSON.parse(runPtyList(jsonDeps, { json: true }).message)[0].runTerminated).toBe('no-run-id');
  });

  test('빈 workdir은 보존하고 부재 workdir은 생략한다', () => {
    const base: Omit<PtyManifestRow, 'id' | 'workdir'> = { kind: 'pty', cmd: 'bun', ownerPid: 1, ptyPid: 1, instance: 'test', startedAt: 0, alive: true, exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 0, frame: '', frameAt: 0, outputBytesTotal: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentKind: '', parentPid: 0, closedAt: 0, codeSha: '' };
    const deps: PtyTakeoverCommandDeps = {
      ...listOnlyDeps(() => []),
      currentManifestDbPath: () => '/test/pty/manifest.db',
      manifestTargets: () => [{ name: 'test', dbPath: '/test/pty/manifest.db' }],
      listManifestRowsAt: () => [{ ...base, id: 'pty_empty', workdir: '' }, { ...base, id: 'pty_missing' }],
      isProcessAlive: () => true,
      now: () => 0,
    };
    expect(JSON.parse(runPtyList(deps, { json: true }).message)).toEqual([
      expect.objectContaining({ id: 'pty_empty', workdir: '' }),
      expect.not.objectContaining({ workdir: expect.anything() }),
    ]);
  });

  test('--all은 SSOT가 제외한 현재 test-root를 물리 경로 중복 없이 읽고 살아있는 행만 낸다', () => {
    const base: Omit<PtyManifestRow, 'id' | 'alive' | 'ptyPid'> = {
      kind: 'pty', cmd: 'bun', ownerPid: 1, instance: 'test:current', startedAt: 0, exitCode: null,
      snapshot: '', snapshotAt: 0, updatedAt: 0, frame: '', frameAt: 0, outputBytesTotal: 0, runId: '', runIdSource: '',
      spaceId: '', sessionId: '', parentPtyId: '', parentKind: '', parentPid: 0, closedAt: 0, codeSha: '',
    };
    const reads: string[] = [];
    const deps: PtyTakeoverCommandDeps = {
      ...listOnlyDeps(() => []),
      listManifestRows: () => [],
      currentManifestDbPath: () => '/test-link/pty/manifest.db',
      realpath: (path) => path.replace('/test-link', '/test-real'),
      manifestTargets: () => [
        { name: 'prod', dbPath: '/prod/pty/manifest.db' },
      ],
      listManifestRowsAt: (path) => {
        reads.push(path);
        if (path === '/test-real/pty/manifest.db') return [
          { ...base, id: 'pty_current_alive', alive: true, ptyPid: 2 },
          { ...base, id: 'pty_current_dead', alive: true, ptyPid: 3 },
        ];
        return [];
      },
      isProcessAlive: (pid) => pid === 2,
      now: () => 0,
    };

    const result = runPtyList(deps, { all: true, json: true });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.message).map((row: { id: string }) => row.id)).toEqual(['pty_current_alive']);
    expect(reads).toEqual(['/prod/pty/manifest.db', '/test-real/pty/manifest.db']);
  });

  test('--all은 realpath가 같은 현재 manifest를 두 번 읽지 않는다', () => {
    const reads: string[] = [];
    const deps: PtyTakeoverCommandDeps = {
      ...listOnlyDeps(() => []),
      listManifestRows: () => [],
      currentManifestDbPath: () => '/test-link/pty/manifest.db',
      realpath: (path) => path.replace('/test-link', '/test-real'),
      manifestTargets: () => [{ name: 'registered-current', dbPath: '/test-real/pty/manifest.db' }],
      listManifestRowsAt: (path) => { reads.push(path); return []; },
      isProcessAlive: () => true,
      now: () => 0,
    };

    expect(runPtyList(deps, { all: true, json: true }).exitCode).toBe(0);
    expect(reads).toEqual(['/test-real/pty/manifest.db']);
  });

  test('실제 원장 상태가 terminal, running, missing, malformed일 때 구조화 종결값을 구분한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'pty-list-ledger-'));
    const ledgerDir = join(root, 'run-ledger');
    const entry = (runId: string, data: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-08-06T00:00:00.000Z', runId, event: 'run-status', data });
    const base: Omit<PtyManifestRow, 'id' | 'runId'> = { kind: 'pty', cmd: 'bun', ownerPid: 1, ptyPid: 1, instance: 'test', startedAt: 0, alive: true, exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 0, frame: '', frameAt: 0, outputBytesTotal: 0, runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentKind: '', parentPid: 0, closedAt: 0, codeSha: '' };
    try {
      mkdirSync(ledgerDir, { recursive: true });
      writeFileSync(runLedgerPath('terminal', ledgerDir), `${entry('terminal', { runStatus: 'completed' })}\n`);
      writeFileSync(runLedgerPath('running', ledgerDir), `${entry('running', { runStatus: 'running' })}\n`);
      writeFileSync(runLedgerPath('malformed', ledgerDir), '{not json}\n');
      const deps: PtyTakeoverCommandDeps = {
        ...listOnlyDeps(() => []),
        currentManifestDbPath: () => '/test/pty/manifest.db',
        manifestTargets: () => [{ name: 'test', dbPath: '/test/pty/manifest.db' }],
        listManifestRowsAt: () => ['terminal', 'running', 'missing', 'malformed'].map((runId) => ({ ...base, id: `pty_${runId}`, runId })),
        isProcessAlive: () => true,
        now: () => 0,
        runTerminated: (runId) => {
          try {
            const termination = runLedgerTermination(loadRunLedger(runId, ledgerDir));
            return termination === 'ledger-indeterminate'
              ? 'ledger-indeterminate'
              : termination;
          } catch { return 'ledger-read-failed'; }
        },
      };
      expect(JSON.parse(runPtyList(deps, { json: true }).message).map((row: { runTerminated: boolean | 'ledger-indeterminate' | 'ledger-read-failed' }) => row.runTerminated))
        .toEqual([true, false, 'ledger-indeterminate', 'ledger-read-failed']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
