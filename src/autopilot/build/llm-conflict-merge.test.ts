// LLM 지능형 충돌 해결 시퀀서 — seam 주입(merge 성공/충돌·LLM 해결/실패·마커 검출).
import { test, expect, describe, afterEach } from 'bun:test';
import { mergeMainWithLlmResolve, hasConflictMarkers, conflictResolvePrompt, remoteFetchSpec, defaultGitMergeSeam, LEGACY_MERGE_TARGET, formatLlmMergeOutcome, type MergeGitSeam, type LlmMergeOutcome } from './llm-conflict-merge.js';
import { countTestDeclarations } from '../../self-implement/test-declarations.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CONFLICTED = '<<<<<<< ours\nwalker line\n=======\nmain line\n>>>>>>> theirs\n';
const RESOLVED = 'walker line\nmain line\n'; // LLM 종합(마커 없음)

function gitSeam(over: Partial<MergeGitSeam> & { mergeConflict?: boolean; mergeOk?: boolean; upToDate?: boolean; files?: string[]; fetchOk?: boolean; fetchErrorDetail?: string; mergeErrorDetail?: string; commitErrorDetail?: string; fileContents?: Record<string, string>; indexStageContents?: Record<string, string> } = {}): {
  git: MergeGitSeam; calls: string[]; written: Record<string, string>;
} {
  const calls: string[] = [];
  const written: Record<string, string> = {};
  const git: MergeGitSeam = {
    isConfiguredRemote: (_wt, remote) => over.isConfiguredRemote?.('', remote) ?? true,
    fetch: (_wt, remote, branch) => {
      calls.push(`fetch:${remote}/${branch}`);
      const ok = over.fetchOk ?? true;
      return over.fetchErrorDetail === undefined ? ok : { ok, errorDetail: over.fetchErrorDetail };
    },
    merge: (_wt, mergeTarget) => {
      calls.push(`merge:${mergeTarget}`);
      return {
        ok: over.mergeOk ?? false,
        conflict: over.mergeConflict ?? true,
        stdout: over.upToDate ? 'Already up to date.' : '',
        ...(over.mergeErrorDetail === undefined ? {} : { errorDetail: over.mergeErrorDetail }),
      };
    },
    conflictedFiles: () => over.files ?? ['src/a.ts'],
    readIndexStage: (_wt, stage, file) => {
      const key = `:${stage}:${file}`;
      if (over.indexStageContents && !(key in over.indexStageContents)) throw new Error(`missing ${key}`);
      return over.indexStageContents?.[key] ?? '';
    },
    readFile: (p) => over.fileContents?.[p] ?? CONFLICTED,
    writeFile: (p, c) => { written[p] = c; calls.push('write'); },
    add: () => calls.push('add'),
    commit: () => {
      calls.push('commit');
      const ok = over.commit ? over.commit('') : true;
      return over.commitErrorDetail === undefined ? ok : { ok: ok === true, errorDetail: over.commitErrorDetail };
    },
    abort: () => calls.push('abort'),
  };
  return { git, calls, written };
}

describe('mergeMainWithLlmResolve — LLM 지능형 충돌 해결', () => {
  test('충돌 없이 merge 성공 → merged', async () => {
    const { git, calls } = gitSeam({ mergeOk: true, mergeConflict: false });
    const r = await mergeMainWithLlmResolve('/wt', 'main', async () => RESOLVED, git);
    expect(r.status).toBe('merged');
    expect(calls).toEqual(['merge:main']);   // 충돌 없으면 resolve 안 함
  });

  test('up-to-date', async () => {
    const { git } = gitSeam({ mergeOk: true, mergeConflict: false, upToDate: true });
    expect((await mergeMainWithLlmResolve('/wt', 'main', async () => RESOLVED, git)).status).toBe('up-to-date');
  });

  // ⛔⭐⭐ 이 자리에 있던 시험은 *"원격 fetch는 하지 않는다"* 를 «계약»으로 박고 있었다.
  //   그것은 대상 일반화를 하며 fetch 를 «지운» 회귀를 규범으로 굳힌 것이다(리뷰 must-fix).
  //   ⇒ 아래 셋이 진짜 계약이다: 원격이면 «그 원격을» 갱신 · 갱신 실패면 병합 «안 함» · 로컬이면 갱신 «없음».
  test('대상이 «원격»이면 그 원격/브랜치를 갱신한 «뒤» merge 한다 — stale 병합 금지', async () => {
    const { git, calls } = gitSeam({ mergeOk: true, mergeConflict: false });
    await mergeMainWithLlmResolve('/wt', 'origin/master', async () => RESOLVED, git);
    expect(calls).toEqual(['fetch:origin/master', 'merge:origin/master']);   // 순서가 계약이다
  });

  test('원격 갱신이 «실패»하면 병합하지 않고 error — 옛 「stale merge 금지」 계약 그대로', async () => {
    const { git, calls } = gitSeam({ mergeOk: true, mergeConflict: false, fetchOk: false, fetchErrorDetail: 'fatal: unable to access' });
    const r = await mergeMainWithLlmResolve('/wt', 'origin/main', async () => RESOLVED, git);
    expect(r).toEqual({ status: 'error', errorStep: 'fetch', errorDetail: 'fatal: unable to access' });
    expect(calls).toEqual(['fetch:origin/main']);          // merge 가 «안 불린다»
  });

  test('대상이 «로컬»이면 갱신할 것이 없다 — 원격 없는 새 저장소가 이 자리에서 죽지 않는다', async () => {
    const { git, calls } = gitSeam({ mergeOk: true, mergeConflict: false });
    await mergeMainWithLlmResolve('/wt', 'master', async () => RESOLVED, git);
    expect(calls).toEqual(['merge:master']);               // fetch 가 «안 불린다»
  });

  test('슬래시가 있어도 «설정된 원격»이 아니면 갱신하지 않는다 — feature/foo 오인 방지', async () => {
    const { git, calls } = gitSeam({ mergeOk: true, mergeConflict: false, isConfiguredRemote: () => false });
    await mergeMainWithLlmResolve('/wt', 'feature/foo', async () => RESOLVED, git);
    expect(calls).toEqual(['merge:feature/foo']);           // fetch 가 «안 불린다»
  });

  // ⛔⭐⭐ 「옛 호출자 + 새 피호출자」 — 동적 import 라 한 프로세스에 공존한다.
  //   📏 2026-08-21 실물: 남의 런이 리뷰까지 pass 하고 «정합 직전»에 undefined.indexOf 로 죽었다.
  test('대상을 «안 준» 옛 호출자에게는 옛 기본으로 돈다 — 던지지 않는다', async () => {
    const { git, calls } = gitSeam({ mergeOk: true, mergeConflict: false });
    const r = await mergeMainWithLlmResolve('/wt', undefined as unknown as string, async () => RESOLVED, git);
    expect(r.status).toBe('merged');
    expect(calls).toEqual([`fetch:${LEGACY_MERGE_TARGET.replace('/', '/')}`, `merge:${LEGACY_MERGE_TARGET}`]);
  });

  test('빈 문자열도 같은 하위호환 경로로 간다', async () => {
    const { git } = gitSeam({ mergeOk: true, mergeConflict: false });
    expect((await mergeMainWithLlmResolve('/wt', '', async () => RESOLVED, git)).status).toBe('merged');
  });

  test('remoteFetchSpec 은 «전역»이다 — 문자열이 아니어도 던지지 않는다', () => {
    expect(remoteFetchSpec(undefined as unknown as string)).toBeNull();
    expect(remoteFetchSpec(null as unknown as string)).toBeNull();
    expect(remoteFetchSpec('')).toBeNull();
  });

  test('remoteFetchSpec — 원격과 로컬을 가른다 (순수)', () => {
    expect(remoteFetchSpec('origin/main')).toEqual({ remote: 'origin', branch: 'main' });
    expect(remoteFetchSpec('upstream/master')).toEqual({ remote: 'upstream', branch: 'master' });
    expect(remoteFetchSpec('origin/feature/x')).toEqual({ remote: 'origin', branch: 'feature/x' });
    expect(remoteFetchSpec('main')).toBeNull();
    expect(remoteFetchSpec('master')).toBeNull();
    expect(remoteFetchSpec('origin/')).toBeNull();         // 브랜치가 비면 갱신 대상이 아니다
    expect(remoteFetchSpec('/main')).toBeNull();
  });

  test('★ 충돌 → LLM 종합 해결 → llm-resolved (write→add→commit 순서)', async () => {
    const { git, calls, written } = gitSeam({ mergeConflict: true, files: ['src/a.ts'] });
    const r = await mergeMainWithLlmResolve('/wt', 'main', async () => RESOLVED, git);
    expect(r.status).toBe('llm-resolved');
    expect(r.resolvedFiles).toEqual(['src/a.ts']);
    expect(r.sizeChange).toEqual({
      files: [{ file: 'src/a.ts', beforeLines: 5, afterLines: 2, deltaLines: -3 }],
      totalBeforeLines: 5,
      totalAfterLines: 2,
      totalDeltaLines: -3,
    });
    expect(written['/wt/src/a.ts']).toBe(RESOLVED);                   // 해결본 기록
    expect(calls).toEqual(['merge:main', 'write', 'add', 'commit']); // 순서
  });

  test('성공 결과 shape 는 resolvedFiles 에 sizeChange 를 더한다', async () => {
    const { git } = gitSeam({ mergeConflict: true, files: ['src/a.ts'] });
    const r = await mergeMainWithLlmResolve('/wt', 'main', async () => RESOLVED, git);
    expect(Object.keys(r).sort()).toEqual(['resolvedFiles', 'sizeChange', 'status']);
    expect(r).toMatchObject({ status: 'llm-resolved', resolvedFiles: ['src/a.ts'], sizeChange: { totalBeforeLines: 5, totalAfterLines: 2, totalDeltaLines: -3 } });
  });

  test('사람 산출 포맷에 규모 변화가 나온다', async () => {
    const { git } = gitSeam({ mergeConflict: true, files: ['src/a.ts'] });
    const r = await mergeMainWithLlmResolve('/wt', 'main', async () => RESOLVED, git);
    expect(formatLlmMergeOutcome(r)).toBe('llm-resolved (LLM 종합 1파일: src/a.ts); 규모 변화: 5→2줄(-3) [src/a.ts 5→2줄(-3)]');
  });

  test('시험 선언이 양쪽보다 적으면 abort하고 commit하지 않는다', async () => {
    const declarations = (count: number) => Array.from({ length: count }, (_, i) => `test('case ${i}', () => {});`).join('\n');
    const { git, calls } = gitSeam({
      mergeConflict: true,
      files: ['src/x.test.ts'],
      indexStageContents: { ':2:src/x.test.ts': declarations(3), ':3:src/x.test.ts': declarations(3) },
    });
    const result = await mergeMainWithLlmResolve('/wt', 'main', async () => declarations(1), git);
    expect(result).toEqual({
      status: 'conflict-unresolved',
      resolvedFiles: [],
      testDeclarationLoss: [{ file: 'src/x.test.ts', ours: 3, theirs: 3, merged: 1 }],
    });
    expect(calls).toContain('abort');
    expect(calls).not.toContain('commit');
  });

  test('먼저 못 잰 파일 뒤 선언 손실이면 abort 결과에도 unmeasured를 보존한다', async () => {
    const declarations = (count: number) => Array.from({ length: count }, (_, i) => `test('case ${i}', () => {});`).join('\n');
    const { git, calls } = gitSeam({
      mergeConflict: true,
      files: ['src/unmeasured.test.ts', 'src/lost.test.ts'],
      indexStageContents: {
        ':2:src/unmeasured.test.ts': declarations(3),
        ':2:src/lost.test.ts': declarations(3),
        ':3:src/lost.test.ts': declarations(3),
      },
    });
    const result = await mergeMainWithLlmResolve('/wt', 'main', async (file) => file === 'src/lost.test.ts' ? declarations(1) : declarations(3), git);
    expect(result).toEqual({
      status: 'conflict-unresolved',
      resolvedFiles: ['src/unmeasured.test.ts'],
      testDeclarationLoss: [{ file: 'src/lost.test.ts', ours: 3, theirs: 3, merged: 1 }],
      testDeclarationUnmeasured: ['src/unmeasured.test.ts'],
    });
    expect(calls).toContain('abort');
    expect(calls).not.toContain('commit');
  });

  test('해소본이 양쪽 중 작은 선언 수를 지키면 진행한다', async () => {
    const declarations = (count: number) => Array.from({ length: count }, (_, i) => `test('case ${i}', () => {});`).join('\n');
    const { git } = gitSeam({
      mergeConflict: true,
      files: ['src/x.test.ts'],
      indexStageContents: { ':2:src/x.test.ts': declarations(3), ':3:src/x.test.ts': declarations(5) },
    });
    const result = await mergeMainWithLlmResolve('/wt', 'main', async () => declarations(3), git);
    expect(result.status).toBe('llm-resolved');
    expect('testDeclarationLoss' in result).toBe(false);
  });

  test('한쪽 index stage를 읽지 못하면 차단하지 않고 unmeasured로 남긴다', async () => {
    const { git } = gitSeam({
      mergeConflict: true,
      files: ['src/x.test.ts'],
      indexStageContents: { ':2:src/x.test.ts': "test('ours', () => {});" },
    });
    const result = await mergeMainWithLlmResolve('/wt', 'main', async () => "test('merged', () => {});", git);
    expect(result).toMatchObject({ status: 'llm-resolved', testDeclarationUnmeasured: ['src/x.test.ts'] });
  });

  test('대규모 삭제도 막지 않고 llm-resolved 로 진행한다', async () => {
    const before = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const after = 'kept\n';
    const { git, calls } = gitSeam({ mergeConflict: true, files: ['src/huge.ts'], fileContents: { '/wt/src/huge.ts': before } });
    const r = await mergeMainWithLlmResolve('/wt', 'main', async () => after, git);
    expect(r.status).toBe('llm-resolved');
    expect(r.sizeChange?.totalDeltaLines).toBe(-119);
    expect(calls).toEqual(['merge:main', 'write', 'add', 'commit']);
  });

  test('못 잰 성공 결과는 사람 산출에서 0이 아니라 못 쟀다로 말한다', () => {
    const outcome: LlmMergeOutcome = { status: 'llm-resolved', resolvedFiles: ['src/a.ts'] };
    expect(formatLlmMergeOutcome(outcome)).toBe('llm-resolved (LLM 종합 1파일: src/a.ts); 규모 변화: 못 쟀다');
  });

  test('미해결·오류 경로 shape 는 기존처럼 sizeChange 를 싣지 않는다', async () => {
    const unresolved = await mergeMainWithLlmResolve('/wt', 'main', async () => CONFLICTED, gitSeam({ mergeConflict: true }).git);
    const error = await mergeMainWithLlmResolve('/wt', 'main', async () => RESOLVED, gitSeam({ mergeOk: false, mergeConflict: false }).git);
    expect(unresolved).toEqual({ status: 'conflict-unresolved', resolvedFiles: [] });
    expect(error).toEqual({ status: 'error', errorStep: 'merge' });
  });

  test('★ 여러 충돌 파일 각각 해결', async () => {
    const { git, calls } = gitSeam({ mergeConflict: true, files: ['a.ts', 'b.ts'] });
    const r = await mergeMainWithLlmResolve('/wt', 'main', async () => RESOLVED, git);
    expect(r.status).toBe('llm-resolved');
    expect(r.resolvedFiles).toEqual(['a.ts', 'b.ts']);
    expect(calls.filter((c) => c === 'add').length).toBe(2);
  });

  test('★ LLM 이 마커 못 지움(종합 실패) → conflict-unresolved·abort(base 유지)', async () => {
    const { git, calls } = gitSeam({ mergeConflict: true });
    const r = await mergeMainWithLlmResolve('/wt', 'main', async () => CONFLICTED, git); // 마커 잔존 반환
    expect(r.status).toBe('conflict-unresolved');
    expect(calls).toContain('abort');
    expect(calls).not.toContain('commit');   // 커밋 안 함
  });

  test('★ LLM 예외 → conflict-unresolved·abort', async () => {
    const { git, calls } = gitSeam({ mergeConflict: true });
    const r = await mergeMainWithLlmResolve('/wt', 'main', async () => { throw new Error('llm fail'); }, git);
    expect(r.status).toBe('conflict-unresolved');
    expect(calls).toContain('abort');
  });

  test('전달받은 대상의 비-충돌 merge 오류 → error·abort', async () => {
    const { git, calls } = gitSeam({ mergeOk: false, mergeConflict: false, mergeErrorDetail: 'fatal: refusing to merge unrelated histories' });
    expect(await mergeMainWithLlmResolve('/wt', 'main', async () => RESOLVED, git)).toEqual({
      status: 'error',
      errorStep: 'merge',
      errorDetail: 'fatal: refusing to merge unrelated histories',
    });
    expect(calls).toEqual(['merge:main', 'abort']);
  });

  test('비-충돌 merge 에러 → error·abort', async () => {
    const { git, calls } = gitSeam({ mergeOk: false, mergeConflict: false });
    expect(await mergeMainWithLlmResolve('/wt', 'main', async () => RESOLVED, git)).toEqual({ status: 'error', errorStep: 'merge' });
    expect(calls).toContain('abort');
  });

  test('충돌인데 파일 목록이 0이면 conflicted-files 단계로 error·abort', async () => {
    const { git, calls } = gitSeam({ mergeConflict: true, files: [] });
    expect(await mergeMainWithLlmResolve('/wt', 'main', async () => RESOLVED, git)).toEqual({ status: 'error', errorStep: 'conflicted-files' });
    expect(calls).toEqual(['merge:main', 'abort']);
  });

  test('commit 실패 → error·abort, 앞선 stage 미측정을 보존한다', async () => {
    const { git, calls } = gitSeam({
      mergeConflict: true,
      files: ['src/x.test.ts'],
      indexStageContents: { ':2:src/x.test.ts': "test('ours', () => {});" },
      commit: () => false,
      commitErrorDetail: 'error: Unable to create commit',
    });
    await expect(mergeMainWithLlmResolve('/wt', 'main', async () => "test('merged', () => {});", git)).resolves.toEqual({
      status: 'error',
      errorStep: 'commit',
      errorDetail: 'error: Unable to create commit',
      resolvedFiles: ['src/x.test.ts'],
      testDeclarationUnmeasured: ['src/x.test.ts'],
    });
    expect(calls).toContain('abort');
  });
});

describe('countTestDeclarations', () => {
  test('줄 머리 test·it 및 only/skip/todo/if/skipIf/todoIf 변형만 센다', () => {
    const source = [
      "test('plain', () => {});",
      "it.only('only', () => {});",
      "test.skip('skip', () => {});",
      "it.todo('todo');",
      "test.if(true)('if', () => {});",
      "it.skipIf(true)('skipIf', () => {});",
      "test.todoIf(true)('todoIf');",
      "const inline = test('ignored', () => {});",
      "// test('comment', () => {});",
      "describe('suite', () => {});",
    ].join('\n');
    expect(countTestDeclarations(source)).toBe(7);
  });
});

describe('hasConflictMarkers', () => {
  test('마커 검출', () => {
    expect(hasConflictMarkers(CONFLICTED)).toBe(true);
    expect(hasConflictMarkers('<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs')).toBe(true);
    expect(hasConflictMarkers('|||||||  base')).toBe(true);   // 3-way base 마커
  });
  test('깨끗한 파일 → false', () => {
    expect(hasConflictMarkers(RESOLVED)).toBe(false);
    expect(hasConflictMarkers('const x = 1 < 2 && 3 > 2;')).toBe(false); // 부등호 오탐 아님
  });
});

describe('conflictResolvePrompt', () => {
  test('ours/theirs 종합 지시 + 호출자가 전달한 대상과 파일 포함', () => {
    const p = conflictResolvePrompt('src/x.ts', CONFLICTED, 'master');
    expect(p).toContain('ours');
    expect(p).toContain('theirs');
    expect(p).toContain('master');
    expect(p).not.toContain('origin/main');
    expect(p).toContain('src/x.ts');
    expect(p).toContain(CONFLICTED);
    expect(p).toContain('보존');   // 양쪽 의도 보존 원칙
  });
});


// ⛔⭐⭐ **실 git 회귀** — 위 시험들은 seam «호출»만 본다. 그것만으로는
//   「`origin/*` 가 «실제로» 갱신됐나」를 못 답한다(리뷰가 그 점을 Goodhart 로 지적했다).
//   ⇒ 여기서는 진짜 저장소를 만들어 «ref 값»을 본다. LLM 은 안 부른다(fetch 어댑터만 잰다).
describe('defaultGitMergeSeam — 실 git 으로 원격추적 ref 가 «갱신되나»', () => {
  const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
  const gitTest = gitAvailable ? test : test.skip;
  const g = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const mustGit = (cwd: string, ...args: string[]) => {
    const result = g(cwd, ...args);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
    return result;
  };
  // ⛔ 만든 저장소는 «반드시» 걷는다 — 안 걷으면 /tmp 에 쌓인다(리뷰 should-fix).
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  });

  function makeRepos(withRefspec: boolean): { work: string; head: string } {
    const root = mkdtempSync(`${tmpdir()}/merge-fetch-`);
    roots.push(root);
    const remote = `${root}/remote.git`;
    mustGit(root, 'init', '-q', '--bare', remote);
    const work = `${root}/work`;
    mkdirSync(work);
    mustGit(work, 'init', '-q');
    mustGit(work, 'checkout', '-qb', 'main');
    mustGit(work, 'config', 'user.email', 't@t');
    mustGit(work, 'config', 'user.name', 't');
    writeFileSync(`${work}/f.txt`, 'one\n');
    mustGit(work, 'add', 'f.txt');
    mustGit(work, 'commit', '-qm', 'one');
    mustGit(work, 'remote', 'add', 'origin', remote);
    mustGit(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    mustGit(work, 'fetch', 'origin', '--quiet');
    // 원격을 앞세운 뒤 로컬 원격추적 ref만 이전 SHA로 되돌려 stale fetch를 만든다.
    const staleHead = (g(work, 'rev-parse', 'refs/remotes/origin/main').stdout ?? '').trim();
    appendFileSync(`${work}/f.txt`, 'two\n');
    g(work, 'commit', '-qam', 'two');
    g(work, 'push', '-q', 'origin', 'main');
    const head = (g(work, 'rev-parse', 'HEAD').stdout ?? '').trim();
    g(work, 'update-ref', 'refs/remotes/origin/main', staleHead);
    // ⭐ refspec 을 «지운» 원격에서도 갱신돼야 한다 — 그것이 이 수리의 핵심이다.
    if (!withRefspec) g(work, 'config', '--unset-all', 'remote.origin.fetch');
    return { work, head };
  }

  gitTest('기본 refspec 이 «있을 때» origin/main 이 갱신된다', () => {
    const { work, head } = makeRepos(true);
    const before = (g(work, 'rev-parse', 'refs/remotes/origin/main').stdout ?? '').trim();
    expect(before).not.toBe(head);                       // 전제 — 정말 뒤처져 있다
    expect(defaultGitMergeSeam().fetch(work, 'origin', 'main')).toBe(true);
    expect((g(work, 'rev-parse', 'refs/remotes/origin/main').stdout ?? '').trim()).toBe(head);
  });

  gitTest('⭐ 기본 refspec 이 «없어도» origin/main 이 갱신된다 — 명시 refspec 이라서', () => {
    const { work, head } = makeRepos(false);
    expect((g(work, 'config', '--get', 'remote.origin.fetch').stdout ?? '').trim()).toBe('');  // 전제
    const before = (g(work, 'rev-parse', 'refs/remotes/origin/main').stdout ?? '').trim();
    expect(before).not.toBe(head);
    expect(defaultGitMergeSeam().fetch(work, 'origin', 'main')).toBe(true);
    // ⛔ 여기가 회귀 지점 — refspec 없는 fetch 였다면 이 값이 «안 움직인다».
    expect((g(work, 'rev-parse', 'refs/remotes/origin/main').stdout ?? '').trim()).toBe(head);
  });

  gitTest('실제 충돌 시험 파일에서 선언 손실이면 merge를 abort해 충돌 상태를 남기지 않는다', async () => {
    const root = mkdtempSync(`${tmpdir()}/merge-test-declaration-loss-`);
    roots.push(root);
    g(root, 'init', '-q');
    g(root, 'checkout', '-qb', 'main');
    g(root, 'config', 'user.email', 't@t');
    g(root, 'config', 'user.name', 't');
    const declarations = (label: string, count: number) => [
      `const version = '${label}';`,
      ...Array.from({ length: count }, (_, i) => `test('${label}-${i}', () => {});`),
      '',
    ].join('\n');
    writeFileSync(`${root}/src.test.ts`, declarations('base', 3));
    g(root, 'add', 'src.test.ts');
    g(root, 'commit', '-qm', 'base');
    g(root, 'checkout', '-qb', 'feature');
    writeFileSync(`${root}/src.test.ts`, declarations('ours', 3));
    g(root, 'commit', '-am', 'ours');
    g(root, 'checkout', '-q', 'main');
    writeFileSync(`${root}/src.test.ts`, declarations('theirs', 4));
    g(root, 'commit', '-am', 'theirs');
    g(root, 'checkout', '-q', 'feature');

    const result = await mergeMainWithLlmResolve(root, 'main', async () => declarations('merged', 1), defaultGitMergeSeam());

    expect(result).toMatchObject({
      status: 'conflict-unresolved',
      testDeclarationLoss: [{ file: 'src.test.ts', ours: 3, theirs: 4, merged: 1 }],
    });
    expect((g(root, 'status', '--porcelain').stdout ?? '').trim()).toBe('');
  });

  gitTest('추적되지 않은 x.txt 가 병합 대상의 같은 경로와 겹치면 merge 단계 error 와 untracked 를 싣는다', async () => {
    const root = mkdtempSync(`${tmpdir()}/merge-untracked-`);
    roots.push(root);
    mustGit(root, 'init', '-q');
    mustGit(root, 'checkout', '-qb', 'main');
    mustGit(root, 'config', 'user.email', 't@t');
    mustGit(root, 'config', 'user.name', 't');
    writeFileSync(`${root}/keep.txt`, 'base\n');
    mustGit(root, 'add', 'keep.txt');
    mustGit(root, 'commit', '-qm', 'base');
    mustGit(root, 'checkout', '-qb', 'target');
    writeFileSync(`${root}/x.txt`, 'from-target\n');
    mustGit(root, 'add', 'x.txt');
    mustGit(root, 'commit', '-qm', 'target adds x.txt');
    mustGit(root, 'checkout', '-q', 'main');
    writeFileSync(`${root}/x.txt`, 'untracked-local\n');

    const result = await mergeMainWithLlmResolve(root, 'target', async () => 'unused\n', defaultGitMergeSeam());

    expect(result.status).toBe('error');
    expect(result.errorStep).toBe('merge');
    expect(result.errorDetail).toContain('untracked');
  });

  gitTest('isConfiguredRemote — 설정된 이름만 참', () => {
    const { work } = makeRepos(true);
    const seam = defaultGitMergeSeam();
    expect(seam.isConfiguredRemote(work, 'origin')).toBe(true);
    expect(seam.isConfiguredRemote(work, 'feature')).toBe(false);
  });
});

// 🅢 2026-09-27 #21086 — 라우터가 공급자 전부 실패 시 돌려준 오류 문구가 2만 줄 파일의 «내용»이 됐다.
describe('해결본이 파일이 아닐 때 — 공급자 오류 문구 · 크기 붕괴', () => {
  const lines = (n: number, tag = 'x') => Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`).join('\n');
  const PROVIDER_TEXT = '[LLM PROVIDER BLOCKED] fallback candidates exhausted\n- openai-codex: Codex API 429: usage_limit_reached\n';

  test('해결기가 공급자 오류 문구를 돌려주면 abort 하고 쓰지도 commit 하지도 않는다', async () => {
    const { git, calls, written } = gitSeam({ mergeConflict: true, files: ['src/dashboard/index.ts'] });
    const result = await mergeMainWithLlmResolve('/wt', 'main', async () => PROVIDER_TEXT, git);
    expect(result).toMatchObject({ status: 'conflict-unresolved', resolvedFiles: [], providerFailure: ['src/dashboard/index.ts'] });
    expect(calls).toContain('abort');
    expect(calls).not.toContain('commit');
    expect(written['/wt/src/dashboard/index.ts']).toBeUndefined();
  });

  test('양쪽 판보다 절반 넘게 작아지면 abort 한다 — 50줄 미만 파일은 판정하지 않는다', async () => {
    const big = gitSeam({ mergeConflict: true, files: ['src/big.ts'], indexStageContents: { ':2:src/big.ts': lines(400, 'a'), ':3:src/big.ts': lines(420, 'b') } });
    const collapsed = await mergeMainWithLlmResolve('/wt', 'main', async () => `${lines(3)}\n`, big.git);
    expect(collapsed).toMatchObject({ status: 'conflict-unresolved', sizeCollapse: [{ file: 'src/big.ts', ours: 400, theirs: 420, merged: 3 }] });
    expect(big.calls).not.toContain('commit');

    const ok = gitSeam({ mergeConflict: true, files: ['src/big.ts'], indexStageContents: { ':2:src/big.ts': lines(400, 'a'), ':3:src/big.ts': lines(420, 'b') } });
    expect((await mergeMainWithLlmResolve('/wt', 'main', async () => `${lines(410)}\n`, ok.git)).status).toBe('llm-resolved');

    const small = gitSeam({ mergeConflict: true, files: ['src/small.ts'], indexStageContents: { ':2:src/small.ts': lines(20, 'a'), ':3:src/small.ts': lines(20, 'b') } });
    expect((await mergeMainWithLlmResolve('/wt', 'main', async () => `${lines(2)}\n`, small.git)).status).toBe('llm-resolved');
  });
});
