import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  doneLineIdsFrom, formatGoalDoneLines, goalDoneLinesForChangedFiles, parseJudgeVerdictFile,
  readGoalScopedJudgeVerdict, resolveGoalScopedVerdict, writeJudgeVerdictFile,
} from './goal-scoped-verdict.js';

const PR_BODY = [
  '요약 한 줄',
  '',
  '## 골 계약',
  '',
  '### 완료선',
  '- M1: ask 가 거절한다 · 증거: 시험',
  '- M2: say 가 채운다 · 증거: 시험',
  '',
  '### 범위 밖=FU',
  '- 옛 골 이관',
  '',
].join('\n');

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'goal-scoped-verdict-'));
  temporary.push(dir);
  return dir;
}

describe('JUDGE-SCOPE-FROM-GOAL', () => {
  test('done-line ids are read from the PR body contract', () => {
    expect(doneLineIdsFrom(PR_BODY)).toEqual(['M1', 'M2']);
    expect(doneLineIdsFrom('완료선 없는 본문\n')).toEqual([]);
  });

  test('a finding outside the done line (fu, even a hold-style mustFix) leaves PASS', () => {
    const file = parseJudgeVerdictFile(JSON.stringify({
      verdict: 'hold', head: 'abc123', mustFix: ['범위 밖 지적'], fu: ['범위 밖 지적 — FU 칸'],
      goalLines: [{ id: 'M1', verdict: 'pass' }, { id: 'M2', verdict: 'pass' }],
    }));
    expect(resolveGoalScopedVerdict(file, ['M1', 'M2'])).toEqual({ verdict: 'pass', scoped: true, failed: [], missing: [] });
  });

  test('a done-line id that fails gives HOLD', () => {
    expect(resolveGoalScopedVerdict({ verdict: 'pass', goalLines: [{ id: 'M1', verdict: 'pass' }, { id: 'M2', verdict: 'fail' }] }, ['M1', 'M2']))
      .toEqual({ verdict: 'hold', scoped: true, failed: ['M2'], missing: [] });
  });

  test('a done-line id the judge did not rule on gives HOLD', () => {
    expect(resolveGoalScopedVerdict({ verdict: 'pass', goalLines: [{ id: 'M1', verdict: 'pass' }] }, ['M1', 'M2']))
      .toEqual({ verdict: 'hold', scoped: true, failed: [], missing: ['M2'] });
  });

  test('no done-line ids → the judge verdict is kept (old verdict files)', () => {
    expect(resolveGoalScopedVerdict({ verdict: 'hold' }, [])).toEqual({ verdict: 'hold', scoped: false, failed: [], missing: [] });
  });

  test('writer stores goalLines and fu and rewrites verdict from the done line; reader agrees', () => {
    const path = join(tempDir(), 'judb-1-abc123.json');
    writeJudgeVerdictFile(path, { verdict: 'hold', head: 'abc123', reviewer: 'JUD-B', tier: 'T1', goalLines: [{ id: 'M1', verdict: 'pass' }, { id: 'M2', verdict: 'pass' }], fu: ['엣지'] }, ['M1', 'M2']);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      verdict: 'pass', head: 'abc123', reviewer: 'JUD-B', tier: 'T1',
      goalLines: [{ id: 'M1', verdict: 'pass' }, { id: 'M2', verdict: 'pass' }], fu: ['엣지'],
    });
    expect(readGoalScopedJudgeVerdict(path, ['M1', 'M2', 'M3']).verdict).toBe('hold');
  });

  test('malformed goalLines are refused', () => {
    expect(() => parseJudgeVerdictFile('{"verdict":"pass","head":"h","goalLines":[{"id":"M1","verdict":"ok"}]}'))
      .toThrow('judge verdict: goalLines[] needs {id, verdict: pass|fail}');
  });

  test('self gate reads the same ids from a changed linked goal doc', () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, 'docs', 'goals'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'goals', 'GOAL-x.md'), `# 골\n\n${PR_BODY.slice(PR_BODY.indexOf('## 골 계약'))}`);
    writeFileSync(join(cwd, 'docs', 'goals', 'GOAL-old.md'), '# 옛 골\n');
    const linked = goalDoneLinesForChangedFiles(cwd, ['src/a.ts', 'docs/goals/GOAL-x.md', 'docs/goals/GOAL-old.md', 'docs/goals/GOAL-gone.md']);
    expect(linked).toEqual([{ path: 'docs/goals/GOAL-x.md', ids: ['M1', 'M2'] }]);
    expect(formatGoalDoneLines(linked)).toEqual(['goal done-lines: docs/goals/GOAL-x.md → M1, M2']);
  });
});
