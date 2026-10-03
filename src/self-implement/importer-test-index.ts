import { readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path/posix';
import ts from 'typescript';

const IMPORTER_TEST_DISPLAY_LIMIT = 20;

export interface ImporterTestIndex {
  readonly testsBySource: ReadonlyMap<string, readonly string[]>;
  readonly testPaths?: readonly string[];
  readonly unresolvedRelativeSpecifiers: number;
}

// ⛔⭐ `\S+` 를 쓰지 않는다(무인 리뷰 should-fix) — 공백이 든 «유효한» 추적 경로가 «조용히» 빠진다.
//   ⇒ 「색인에 없다」와 「경로에 공백이 있었다」가 같은 값이 되므로, 파일명 부분만 보고 판정한다.
/** 상대 import 중 «소스일 수 있는» 것 — 소스 확장자를 달았거나, 확장자가 «아예 없거나»(TS 관례).
 *  ⛔ `.json`·`.css` 같은 «자원» import 는 제외한다 — 그것을 미해결로 세면 수가 부풀어
 *  「내 해석기가 못 읽은 소스」라는 뜻이 흐려진다.
 *  ⛔⭐ **경로 전체가 아니라 «마지막 조각»만 본다**(무인 리뷰 must-fix · 내가 만든 버그) —
 *  종전 판 `^[^.]*$` 는 `../src/missing` 처럼 «앞에 점이 있는» 상대 경로를 못 물어
 *  ***과소 집계***했다. 설명은 「확장자 없으면 포함」인데 동작은 아니었다. */
export function isSourceLikeSpecifier(specifier: string): boolean {
  // ⛔ 쿼리·프래그먼트를 «먼저» 벗긴다 — `./x.ts?mock` 의 마지막 조각은 `x.ts?mock` 이라
  //   확장자 판정이 «둘 다» 빗나간다(소스 확장자로도, 자원 확장자로도 안 읽힌다).
  //   ⇒ `sourceCandidates` 와 «같은 자»를 써야 두 판정이 안 갈린다.
  const last = stripModuleQuery(specifier).split('/').pop() ?? specifier;
  if (/\.(?:[cm]?[jt]sx?)$/.test(last)) return true;
  return !/\.[A-Za-z0-9]+$/.test(last);
}
const TEST_PATH_RE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

/** ⛔⭐ **호출부가 자기 정규식을 갖지 않게 한다**(무인 리뷰 must-fix) — 종전엔 `seams.ts` 가 «따로»
 *  `\S+` 판정을 들고 있어, 여기만 고치니 ***실물 seam 은 여전히 공백 경로를 버렸다.***
 *  ⇒ 「고쳤다」와 「실물이 달라졌다」가 갈리는 자리라, 판정을 «한 곳»으로 모은다. */
export function isTestPath(path: string): boolean { return TEST_PATH_RE.test(path); }
const SOURCE_SUFFIXES = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mtsx', '.mjs', '.mjsx', '.cts', '.ctsx', '.cjs', '.cjsx'];
const EMITTED_SOURCE_SUFFIXES: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'], '.jsx': ['.tsx', '.jsx'], '.mjs': ['.mts', '.mjs'], '.mjsx': ['.mtsx', '.mjsx'],
  '.cjs': ['.cts', '.cjs'], '.cjsx': ['.ctsx', '.cjsx'],
};

function importedSpecifiers(text: string, path: string): string[] {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/** ⛔⭐ 모듈 «쿼리·프래그먼트»를 벗긴다 — `./SubjectList?terminal-frame` 은 `./SubjectList` 다.
 *
 *  📏 2026-08-25 실측: 못 푼 지정자 **20건 중 16건(80%)**이 이 한 가지였다. 전부
 *  `apps/pwa/**` 의 시험이 «같은 모듈을 다른 목으로 여러 번» 부르려고 쓰는 Bun 쿼리다
 *  (`./SubjectList?terminal-frame` · `../../app/observatory/page?empty` …).
 *  ⛔ 그 접미사를 안 벗기면 해석기가 실재하는 `SubjectList.tsx` 를 «못 찾고»,
 *  그 실패가 「내 해석기의 사각」이 아니라 「소스가 없다」로 잘못 세어진다.
 *
 *  🔑 그리고 그 수가 «거의 항상 켜져» 있어서 그 신호의 효과를 잴 «대조군»이 안 생겼다
 *  ⇒ [[FINDING-you-cannot-measure-a-signal-that-is-always-on-2026-08-25]]. */
function stripModuleQuery(specifier: string): string {
  const cut = specifier.search(/[?#]/);
  return cut === -1 ? specifier : specifier.slice(0, cut);
}

function sourceCandidates(testPath: string, specifier: string): readonly string[] {
  const base = normalize(join(dirname(testPath), stripModuleQuery(specifier)));
  const suffix = extname(base);
  if (suffix) return (EMITTED_SOURCE_SUFFIXES[suffix] ?? [suffix]).map((extension) => `${base.slice(0, -suffix.length)}${extension}`);
  return [
    ...SOURCE_SUFFIXES.map((extension) => `${base}${extension}`),
    ...SOURCE_SUFFIXES.map((extension) => `${base}/index${extension}`),
  ];
}

export function buildImporterTestIndex(cwd: string, testPaths: readonly string[], sourcePaths: readonly string[]): ImporterTestIndex | null {
  const sources = new Set(sourcePaths);
  const testsBySource = new Map<string, string[]>();
  let unresolvedRelativeSpecifiers = 0;
  for (const testPath of testPaths) {
    if (!TEST_PATH_RE.test(testPath)) continue;
    let text: string;
    try {
      text = readFileSync(resolve(cwd, testPath), 'utf8');
    } catch {
      return null;
    }
    for (const specifier of importedSpecifiers(text, testPath)) {
      if (!specifier.startsWith('.')) continue;
      const source = sourceCandidates(testPath, specifier).find((candidate) => sources.has(candidate));
      if (!source) {
        // ⛔⭐ **「미해결」을 과장하지 않는다**(무인 리뷰 should-fix) — 종전엔 «모든» 상대 import 의
        //   실패를 셌다. 그러면 `./fixtures/x.json`·디렉터리 import 처럼 ***애초에 소스가 아닌 것***까지
        //   「해석 못 함」으로 들어가 그 수가 「내 해석기의 사각」을 안 가리킨다.
        //   ⇒ **소스 «확장자»를 가진 것만** 센다. 나머지는 미해결이 아니라 «대상이 아니다».
        if (isSourceLikeSpecifier(specifier)) unresolvedRelativeSpecifiers += 1;
        continue;
      }
      const importers = testsBySource.get(source) ?? [];
      if (!importers.includes(testPath)) importers.push(testPath);
      testsBySource.set(source, importers);
    }
  }
  return { testsBySource, testPaths, unresolvedRelativeSpecifiers };
}

export function importerTestsNotInRunSet(
  index: ImporterTestIndex,
  changed: readonly string[],
  runSet: readonly string[],
): { readonly total: number; readonly files: readonly string[]; readonly truncated: boolean; readonly unresolvedRelativeSpecifiers: number } {
  const names = [...new Set(changed.flatMap((source) => index.testsBySource.get(source) ?? []).filter((test) => !runSet.includes(test)))]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const files = names.slice(0, IMPORTER_TEST_DISPLAY_LIMIT);
  return { total: names.length, files, truncated: names.length > files.length, unresolvedRelativeSpecifiers: index.unresolvedRelativeSpecifiers };
}
