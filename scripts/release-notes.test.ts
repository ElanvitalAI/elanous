import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftReleaseNotes, readLandedCommits, renderReleaseNotes, sectionOf, splitPr } from './release-notes.js';

describe('release-notes — 릴리스 변경 기록 초안', () => {
  test('바뀐 경로로 묶는다: 문서만 → docs · 시험(⊕문서)만 → test · 그 밖 → change', () => {
    expect(sectionOf(['docs/manual/a.md', 'CLAUDE.md', '.rules/x.md'])).toBe('docs');
    expect(sectionOf(['src/a.test.ts', 'docs/b.md'])).toBe('test');
    expect(sectionOf(['src/a.ts', 'src/a.test.ts'])).toBe('change');
    expect(sectionOf([])).toBe('change');   // 경로를 못 얻은 착지는 «숨기지» 않는다
  });

  test('제목 끝 (#N) 을 PR 번호로 떼고, 없으면 짧은 sha 로 적는다', () => {
    expect(splitPr('설치기 자가 해석 (#20497)')).toEqual({ title: '설치기 자가 해석', pr: 20497 });
    expect(splitPr('직접 커밋')).toEqual({ title: '직접 커밋', pr: null });
    const d = draftReleaseNotes([
      { sha: 'a'.repeat(40), subject: '설치기 자가 해석 (#20497)', files: ['scripts/install.sh'] },
      { sha: 'b'.repeat(40), subject: '버전 매뉴얼 (#20507)', files: ['docs/manual/m.md'] },
      { sha: 'c'.repeat(40), subject: 'hostId 회귀 시험', files: ['test/x.test.ts'] },
    ], 'v0.1.0', 'v0.1.1');
    expect(d.total).toBe(3);
    const text = renderReleaseNotes(d);
    expect(text).toContain('## 변경 (1)\n\n- 설치기 자가 해석 (#20497)');
    expect(text).toContain('## 문서 (1)\n\n- 버전 매뉴얼 (#20507)');
    expect(text).toContain(`- hostId 회귀 시험 (${'c'.repeat(12)})`);
    expect(text).toContain('v0.1.0..v0.1.1 · 착지 3건');
  });

  // ⛔ 작업 트리의 «이력»을 빌리지 않는다 — 게이트 Pod 의 얕은 클론엔 HEAD~3 이 없어 rc=128 로 죽었다(0.2.20 컷).
  //    실물 git 으로 «자기» 저장소를 만들어 같은 계약(수가 git 과 같다)을 잰다.
  test('실물 저장소에서 두 ref 사이 착지를 읽는다 — 수가 git 과 같다', () => {
    const repo = mkdtempSync(join(tmpdir(), 'release-notes-repo-'));
    try {
      const g = (...args: string[]) => {
        const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
        return r.stdout;
      };
      g('init', '-q');
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(repo, `f${i}.txt`), String(i));
        g('add', '.');
        g('commit', '-q', '-m', `착지 ${i} (#${100 + i})`);
      }
      const count = Number(g('rev-list', '--first-parent', '--count', 'HEAD~3..HEAD').trim());
      expect(count).toBe(3);
      // readLandedCommits 는 작업 디렉토리의 저장소를 읽는다 — 이 시험 동안만 자기 저장소로 옮긴다.
      const prevCwd = process.cwd();
      let commits: ReturnType<typeof readLandedCommits>;
      try { process.chdir(repo); commits = readLandedCommits('HEAD~3', 'HEAD'); } finally { process.chdir(prevCwd); }
      expect(commits).toHaveLength(count);
      expect(commits.every((c) => /^[0-9a-f]{40}$/.test(c.sha) && c.subject.length > 0)).toBe(true);
      expect(commits.map((c) => c.files)).toEqual([['f2.txt'], ['f3.txt'], ['f4.txt']]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});
