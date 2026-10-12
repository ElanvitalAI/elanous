import { describe, expect, test } from 'bun:test';
import { declaredNewFilePaths } from './goal-new-paths.js';
import { lintGoalFile } from './goal-author.js';

describe('declaredNewFilePaths', () => {
  test('① «신설:» 줄의 « · »·쉼표로 나뉜 경로를 모은다', () => {
    expect(declaredNewFilePaths('신설: a.ts · a.test.ts\n신설: b.ts, c.ts')).toEqual(['a.ts', 'a.test.ts', 'b.ts', 'c.ts']);
  });

  test('② 목록 기호·굵게·영문·전각 콜론 꼴도 읽는다', () => {
    expect(declaredNewFilePaths('- **신설:** x.ts\nnew files: y.ts\n신설：z.ts')).toEqual(['x.ts', 'y.ts', 'z.ts']);
  });

  test('② «## NEW FILES» 절은 읽지 않는다', () => {
    expect(declaredNewFilePaths('## NEW FILES\n- src/section-only.ts\n- section-only.ts')).toEqual([]);
  });

  test('③ 디렉토리·상위 경로·절대 경로는 버린다', () => {
    expect(declaredNewFilePaths('신설: docs/new-dir · src/ · ../x.ts · /abs/path.ts\n신설: real.ts')).toEqual(['real.ts']);
  });
});

describe('lintGoalFile traced-path × «신설:» 선언 (AUTHOR-NEW-FILE-PATHS ④⑤)', () => {
  const doc = (declaration: string) => [
    declaration,
    '## PROBLEM', 'x', '', '## WHAT TO BUILD', 'x', '',
    '## ACCEPTANCE CRITERIA', 'x', '', '## REQUIRED EVIDENCE', '- [t] proof', '',
    '## TRACED PATHS', '- src/new-a.ts — 새 모듈', '- src/absent.ts — 없는 기존 경로', '',
    '## SCOPE BOUNDARY', 'x', '', '## 불변식', 'x', '', '## 판정 신호', 'x', '',
  ].join('\n');
  const traced = (document: string) => lintGoalFile(document, 'main', { readReferencedFile: () => null })
    .filter((finding) => finding.tag === 'traced-path' || finding.tag === 'traced-path-new')
    .map(({ level, tag, message }) => ({ level, tag, message }));

  test('④ 선언된 없는 경로는 WARN traced-path-new · 선언 안 된 없는 경로는 여전히 ERROR traced-path', () => {
    expect(traced(doc('신설: src/new-a.ts'))).toEqual([
      { level: 'WARN', tag: 'traced-path-new', message: 'traced path is declared new: src/new-a.ts' },
      { level: 'ERROR', tag: 'traced-path', message: 'traced path does not exist: src/absent.ts' },
    ]);
  });

  test('⑤ 선언이 없는 문서는 지금처럼 없는 경로 전부 ERROR(traced-path-new 0)', () => {
    expect(traced(doc('대상 경로: src/new-a.ts'))).toEqual([
      { level: 'ERROR', tag: 'traced-path', message: 'traced path does not exist: src/new-a.ts' },
      { level: 'ERROR', tag: 'traced-path', message: 'traced path does not exist: src/absent.ts' },
    ]);
  });
});
