/**
 * ⭐ AUTHOR-NEW-FILE-PATHS — 저작 골 문서가 «새로 만들 파일»로 선언한 경로.
 *
 * 저작(TRACED PATHS 존재 검사)과 실행(orchestrator 범위 검사)이 **같은 함수**로
 * 신설 경로를 읽어야 저작 통과·실행 보류가 다시 갈리지 않는다(TC 13:50).
 */

// SCOPE-NEW-FILES-LINE — 칸 문면은 새로 만들 파일을 «신설:» 줄로 따로 적는다(OP D칸 규칙).
//    저작과 실행이 이 함수를 공유한다(한쪽만 읽으면 저작과 실행이 갈린다).
export const DECLARED_NEW_FILES_LINE = /^\s*(?:신설|new\s*files?)\s*[:：]\s*(.*)$/i;

/** 목록 기호 «- »·굵게 «**» 는 장식이다 — 그것만 벗기고 같은 정규식으로 문는다. */
function bareDeclarationLine(line: string): string {
  return line.replace(/^(?:\s*-\s+)+/, '').replace(/\*\*/g, '');
}

/** 저장소 상대 파일 경로(확장자 있음)만 남긴다 — 디렉토리·절대 경로·「..」는 버린다. */
function isRepositoryFileCandidate(piece: string): boolean {
  if (piece === '' || /\s/.test(piece)) return false;
  if (piece.startsWith('/') || piece.startsWith('~') || /^[A-Za-z]:[\\/]/.test(piece)) return false;
  if (piece.endsWith('/')) return false;
  const segments = piece.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  return /\.[^./]+$/.test(segments[segments.length - 1]!);
}

/** 문서 안 «신설:» 줄의 « · »·쉼표로 나뉜 경로를 모은다. «## NEW FILES» 같은 다른 형식은 읽지 않는다. */
export function declaredNewFilePaths(document: string): string[] {
  const paths: string[] = [];
  for (const rawLine of document.split(/\r?\n/)) {
    const match = DECLARED_NEW_FILES_LINE.exec(bareDeclarationLine(rawLine));
    if (!match) continue;
    for (const fragment of match[1]!.split(/[·,]/)) {
      // 저작·실행 공통 정규화 — 등 코드, ./ 접두.
      const piece = fragment.trim().replace(/^`+|`+$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
      if (!isRepositoryFileCandidate(piece)) continue;
      paths.push(piece);
    }
  }
  return [...new Set(paths)];
}
