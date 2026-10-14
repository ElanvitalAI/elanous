import { describe, expect, test } from 'bun:test';
import { declaredNewFilePaths } from './goal-new-paths.js';
import { lintGoalFile } from './goal-author.js';
import { detectDeclaredScopeDiff } from './orchestrator.js';

describe('declaredNewFilePaths', () => {
  test('① «신설:» 줄의 « · »·쉼표로 나뉜 경로를 모은다', () => {
    expect(declaredNewFilePaths('신설: a.ts · a.test.ts\n신설: b.ts, c.ts')).toEqual(['a.ts', 'a.test.ts', 'b.ts', 'c.ts']);
  });

  test('② 목록 기호·굵게·영문·전각 콜론 꼴도 읽는다', () => {
    expect(declaredNewFilePaths('- **신설:** x.ts\nnew files: y.ts\n신설：z.ts')).toEqual(['x.ts', 'y.ts', 'z.ts']);
  });

  test('장식·전각·쉼표/가운데점 신설 줄을 같은 경로로 정규화하고 중복을 제거한다', () => {
    const ask = '대상 경로: src/a.ts\n- **신설：** `./src/new.ts`, `src/new.test.ts` · `src/extra.ts`\nnew files: src/new.ts';
    expect(declaredNewFilePaths(ask)).toEqual(['src/new.ts', 'src/new.test.ts', 'src/extra.ts']);
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
    '## PROBLEM', 'x', '', '## WHAT TO BUILD', 'x', '',
    'Original ask (verbatim, unmodified):', '```', declaration, '```', '',
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

  test('Original ask가 없으면 문서 다른 절의 신설 줄은 선언이 아니다', () => {
    const withoutAsk = doc('대상 경로: src/new-a.ts').replace(
      'Original ask (verbatim, unmodified):\n```\n대상 경로: src/new-a.ts\n```',
      '신설: src/new-a.ts',
    );
    expect(traced(withoutAsk)).toEqual([
      { level: 'ERROR', tag: 'traced-path', message: 'traced path does not exist: src/new-a.ts' },
      { level: 'ERROR', tag: 'traced-path', message: 'traced path does not exist: src/absent.ts' },
    ]);
  });

  test('Original ask 바깥 NOTES의 신설 줄은 선언이 아니다', () => {
    expect(traced(`${doc('대상 경로: src/new-a.ts')}\n## NOTES\n신설: src/new-a.ts`)).toEqual([
      { level: 'ERROR', tag: 'traced-path', message: 'traced path does not exist: src/new-a.ts' },
      { level: 'ERROR', tag: 'traced-path', message: 'traced path does not exist: src/absent.ts' },
    ]);
  });

  test('같은 골 문서에서 저작과 실행은 Original ask 신설만 인정한다', () => {
    const document = `${doc('대상 경로: src/new-a.ts\n신설: src/new-a.ts')}\n## NOTES\n신설: src/absent.ts`;
    expect(traced(document)).toEqual([
      { level: 'WARN', tag: 'traced-path-new', message: 'traced path is declared new: src/new-a.ts' },
      { level: 'ERROR', tag: 'traced-path', message: 'traced path does not exist: src/absent.ts' },
    ]);
    expect(detectDeclaredScopeDiff({ goalDocument: document, changedFiles: ['src/new-a.ts', 'src/absent.ts'] })).toMatchObject({
      status: 'known', outsideNames: ['src/absent.ts'],
    });
  });
});
