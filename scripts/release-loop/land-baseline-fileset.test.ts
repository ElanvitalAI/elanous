import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeLandBaselineReuse, landBaselineGit, recordLandBaselineFileBlobs, runLandBaselineFilesetCli, type LandBaselineGit } from './land-baseline-fileset';

// 커밋 · blob 은 리터럴 고정값(규칙 11) — 실제 git·네트워크 없음.
const M0 = '1111111111111111111111111111111111111111'; // 영수증을 잰 main
const M1 = '2222222222222222222222222222222222222222'; // PR A(파일 X) 착지 뒤 main
const B_Y = '3333333333333333333333333333333333333333'; // PR B head — Y 만 바꿈
const B_X = '4444444444444444444444444444444444444444'; // PR B head — X 를 바꿈
const X0 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const X1 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const Y0 = 'cccccccccccccccccccccccccccccccccccccccc';

const trees: Record<string, Record<string, string>> = {
  [M0]: { 'src/x.ts': X0, 'src/y.ts': Y0 },
  [M1]: { 'src/x.ts': X1, 'src/y.ts': Y0 },
};
const changedByHead: Record<string, string[]> = { [B_Y]: ['src/y.ts'], [B_X]: ['src/x.ts'] };

function fakeGit(calls: string[] = []): LandBaselineGit {
  return {
    changedFiles(base, head) { calls.push(`changed ${base.slice(0, 4)} ${head.slice(0, 4)}`); return changedByHead[head] ?? null; },
    blob(commit, file) {
      calls.push(`blob ${commit.slice(0, 4)} ${file}`);
      const tree = trees[commit];
      return tree ? (tree[file] ?? null) : undefined;
    },
    isAncestor(ancestor, descendant) { return ancestor === M0 && (descendant === M0 || descendant === M1); },
  };
}

describe('LAND-BASELINE-BY-FILESET', () => {
  test('영수증을 만들 때 바뀐 파일과 base blob 을 적는다', () => {
    expect(recordLandBaselineFileBlobs(fakeGit(), M0, B_Y)).toEqual({ 'src/y.ts': 'cccccccccccccccccccccccccccccccccccccccc' });
    expect(recordLandBaselineFileBlobs(fakeGit(), M0, B_X)).toEqual({ 'src/x.ts': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  });

  test('A 가 X 를 바꿔 main 이 움직여도 Y 만 바꾼 B 는 기존 영수증을 쓴다(재측정 0)', () => {
    const calls: string[] = [];
    const verdict = judgeLandBaselineReuse({ receipt: { base: M0, baseFileBlobs: { 'src/y.ts': Y0 } }, main: M1, head: B_Y, git: fakeGit(calls) });
    expect(verdict).toEqual({ reuse: true, rule: 'fileset-blob', files: ['src/y.ts'] });
    expect(calls).toEqual(['changed 2222 3333', 'blob 2222 src/y.ts']);
  });

  test('B 가 A 와 같은 X 를 바꿨으면 재측정', () => {
    const verdict = judgeLandBaselineReuse({ receipt: { base: M0, baseFileBlobs: { 'src/x.ts': X0 } }, main: M1, head: B_X, git: fakeGit() });
    expect(verdict).toEqual({ reuse: false, rule: 'fileset-blob', reason: 'main changed files of this PR since the receipt', files: ['src/x.ts'] });
  });

  test('blob 지도가 없는 옛 영수증은 정확한 main sha 규칙만 — 다르면 재측정 · 같으면 재사용', () => {
    expect(judgeLandBaselineReuse({ receipt: { base: M0 }, main: M1, head: B_Y, git: fakeGit() }))
      .toEqual({ reuse: false, rule: 'exact-sha', reason: 'receipt base is not the freshly fetched origin/main', files: [] });
    expect(judgeLandBaselineReuse({ receipt: { base: M0 }, main: M0, head: B_Y, git: fakeGit() }))
      .toEqual({ reuse: true, rule: 'exact-sha', files: [] });
  });

  test('지도에 없는 바뀐 파일 · 조상 아님 · 깨진 지도 · 못 읽는 blob 은 모두 재측정', () => {
    expect(judgeLandBaselineReuse({ receipt: { base: M0, baseFileBlobs: { 'src/z.ts': Y0 } }, main: M1, head: B_Y, git: fakeGit() }))
      .toEqual({ reuse: false, rule: 'fileset-blob', reason: 'changed files missing from baseFileBlobs', files: ['src/y.ts'] });
    expect(judgeLandBaselineReuse({ receipt: { base: B_X, baseFileBlobs: { 'src/y.ts': Y0 } }, main: M1, head: B_Y, git: fakeGit() }))
      .toEqual({ reuse: false, rule: 'fileset-blob', reason: 'receipt base is not an ancestor of main', files: [] });
    expect(judgeLandBaselineReuse({ receipt: { base: M0, baseFileBlobs: { 'src/y.ts': 'not-a-sha' } }, main: M1, head: B_Y, git: fakeGit() }))
      .toEqual({ reuse: false, rule: 'fileset-blob', reason: 'baseFileBlobs is malformed', files: [] });
    const unreadable: LandBaselineGit = { ...fakeGit(), blob: () => undefined };
    expect(judgeLandBaselineReuse({ receipt: { base: M0, baseFileBlobs: { 'src/y.ts': Y0 } }, main: M1, head: B_Y, git: unreadable }))
      .toEqual({ reuse: false, rule: 'fileset-blob', reason: 'main blob unreadable', files: ['src/y.ts'] });
  });

  test('운영 도구 입구(check) — 재사용 rc 0 · 겹침 rc 1', () => {
    const receipts: Record<string, string> = {
      '/r/b-y.json': JSON.stringify({ head: B_Y, base: M0, baseFileBlobs: { 'src/y.ts': Y0 } }),
      '/r/b-x.json': JSON.stringify({ head: B_X, base: M0, baseFileBlobs: { 'src/x.ts': X0 } }),
    };
    const read = (path: string) => receipts[path]!;
    expect(runLandBaselineFilesetCli(['check', '/r/b-y.json', M1, B_Y], fakeGit(), read))
      .toEqual({ code: 0, out: 'REUSE rule=fileset-blob base=111111111111 files=1' });
    expect(runLandBaselineFilesetCli(['check', '/r/b-x.json', M1, B_X], fakeGit(), read))
      .toEqual({ code: 1, out: 'REMEASURE rule=fileset-blob main changed files of this PR since the receipt: src/x.ts' });
    expect(runLandBaselineFilesetCli(['record', M0, B_Y], fakeGit(), read))
      .toEqual({ code: 0, out: '{"src/y.ts":"cccccccccccccccccccccccccccccccccccccccc"}' });
  });

  test('실제 로컬 git 읽기(네트워크 없음) — A 가 X 착지 · B 는 공백 든 Y 만 → 재사용 · X 를 건드린 B → 재측정', () => {
    const repo = mkdtempSync(join(tmpdir(), 'land-baseline-fileset-'));
    try {
      const git = (...args: string[]) => {
        const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(result.stderr);
        return result.stdout.trim();
      };
      const commit = (file: string, body: string) => { mkdirSync(join(repo, 'src'), { recursive: true }); writeFileSync(join(repo, file), body); git('add', '-A'); git('commit', '-q', '-m', file); return git('rev-parse', 'HEAD'); };
      git('init', '-q', '-b', 'main');
      commit('src/x.ts', 'x0\n');
      const m0 = commit('src/y y.ts', 'y0\n');
      git('checkout', '-q', '-b', 'b-y'); const bY = commit('src/y y.ts', 'y1\n');
      git('checkout', '-q', '-b', 'b-x', m0); const bX = commit('src/x.ts', 'xb\n');
      git('checkout', '-q', 'main'); const m1 = commit('src/x.ts', 'xa\n');
      const real = landBaselineGit(repo);
      const yBlobs = recordLandBaselineFileBlobs(real, m0, bY);
      expect(Object.keys(yBlobs ?? {})).toEqual(['src/y y.ts']);
      expect(judgeLandBaselineReuse({ receipt: { base: m0, baseFileBlobs: yBlobs }, main: m1, head: bY, git: real }))
        .toEqual({ reuse: true, rule: 'fileset-blob', files: ['src/y y.ts'] });
      const xBlobs = recordLandBaselineFileBlobs(real, m0, bX);
      expect(judgeLandBaselineReuse({ receipt: { base: m0, baseFileBlobs: xBlobs }, main: m1, head: bX, git: real }))
        .toEqual({ reuse: false, rule: 'fileset-blob', reason: 'main changed files of this PR since the receipt', files: ['src/x.ts'] });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
