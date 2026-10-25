import { readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path/posix';
import ts from 'typescript';

const IMPORTER_TEST_DISPLAY_LIMIT = 20;

/** 런타임 간선 클래스 — 시험이 소스를 **실제 프로세스**·`git`·파일 상태로 건드리는 경우다.
 *  임포트 그래프에는 이 간선이 «없다»: `import` 문이 없으니 `testsBySource` 에도 안 잡힌다. */
export type RuntimeEdgeKind = 'spawn' | 'git' | 'file-state';

/** 시험 1건이 만든 런타임 간선 1건. `source` 가 `null` 이면 그 명령은 파일을 지목하지 않는다(`git`). */
export interface RuntimeEdge {
  readonly test: string;
  readonly kind: RuntimeEdgeKind;
  readonly source: string | null;
}

/** 런타임 간선의 **영향 크기** — 임포트 그래프가 표현할 수 없는 간선이 변경 감시에 «얼마나 더하는가».
 *
 *  ⛔ #28322 착지분(BFS 분포·사람용 표)을 재구현하지 않는다 — 여기는 **수**만 낸다. */
export interface RuntimeEdgeImpact {
  /** 변경 소스에 «임포트가 아니라 런타임으로» 닿는 (시험, 소스) 짝의 수 — 임포트 그래프 위에 더해지는 크기. */
  readonly pairs: number;
  /** 클래스별 크기 — 그 클래스의 런타임 간선**만**이 변경 소스에 닿는 시험 수. */
  readonly byKind: Readonly<Record<RuntimeEdgeKind, number>>;
  /** 손으로 관리하는 착지 열차 spawn-lane 목록(`GATE_SPAWN_LANE_FILES`)이 **빠뜨린** 실측 시험들.
   *  ⛔ 손 목록은 구조적으로 드리프트한다 — 그 드리프트 «크기»를 재는 자리다(고치지는 않는다). */
  readonly unlistedSpawnLaneTests: readonly string[];
  /** 실재 소스로 풀리지 않은 런타임 경로 리터럴 수 — `unresolvedRelativeSpecifiers` 와 «같은» 정직성 계수. */
  readonly unresolvedRuntimeTargets: number;
  /** 「쟀다」표 — `runtimeEdges` 가 없는 색인은 «못 잰 것»이므로 `measured: false` 다(`pairs: 0` 과 섞지 않는다). */
  readonly measured: boolean;
}

export interface ImporterTestIndex {
  readonly testsBySource: ReadonlyMap<string, readonly string[]>;
  readonly testPaths?: readonly string[];
  readonly unresolvedRelativeSpecifiers: number;
  /** 측정된 런타임 간선(선택) — 없으면 「안 쟀다」이지 「0건」이 아니다(`measureRuntimeEdgeImpact` 참조). */
  readonly runtimeEdges?: readonly RuntimeEdge[];
  /** 소스로 풀리지 않은 런타임 경로 리터럴 수(선택 · 위와 같은 이유로 optional). */
  readonly unresolvedRuntimeTargets?: number;
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

/** Candidate repo paths of a relative specifier from `testPath` (any importer works — GATE-REUSE-BY-DIFF reuses it for
 *  the release gate's import closure). */
export function sourceCandidates(testPath: string, specifier: string): readonly string[] {
  const base = normalize(join(dirname(testPath), stripModuleQuery(specifier)));
  const suffix = extname(base);
  if (suffix) return (EMITTED_SOURCE_SUFFIXES[suffix] ?? [suffix]).map((extension) => `${base.slice(0, -suffix.length)}${extension}`);
  return [
    ...SOURCE_SUFFIXES.map((extension) => `${base}${extension}`),
    ...SOURCE_SUFFIXES.map((extension) => `${base}/index${extension}`),
  ];
}

/** 실물 자식 프로세스·파일 상태를 만드는 «런타임 모듈 임포트»의 호출 이름 → 클래스. ⛔⭐ 호출 이름의
 *  마지막 조각만 보지 않는다(무인 리뷰 must-fix) — 수신 객체·맨살 callee 의 **임포트 바인딩** 출처를
 *  확인한다(`runtimeEdgeImports`·`declaredRuntimeEdgeKind`). 그래서 `/re/.exec(str)`·`db.exec(...)`·
 *  `fsMock.readFile(...)` 같은 일반 호출은 이 표와 «이름이 같아도» 간선이 되지 않는다. */
const RUNTIME_EDGE_CALLS: Readonly<Record<string, RuntimeEdgeKind>> = {
  spawn: 'spawn', spawnSync: 'spawn', exec: 'spawn', execSync: 'spawn', execFile: 'spawn', execFileSync: 'spawn',
  readFile: 'file-state', readFileSync: 'file-state', writeFile: 'file-state', writeFileSync: 'file-state',
  appendFileSync: 'file-state', copyFileSync: 'file-state', cpSync: 'file-state', renameSync: 'file-state',
  existsSync: 'file-state', statSync: 'file-state', lstatSync: 'file-state', readdir: 'file-state',
  readdirSync: 'file-state', mkdirSync: 'file-state', rmSync: 'file-state', unlinkSync: 'file-state',
  accessSync: 'file-state', openSync: 'file-state', chmodSync: 'file-state', truncateSync: 'file-state',
  readlinkSync: 'file-state', realpathSync: 'file-state',
};

/** URL·절대경로는 저장소 경로가 아니다 — 후보 해석에도, 「못 풀었다」에도 넣지 않는다. */
function isRepoRelativeLiteral(literal: string): boolean {
  if (!literal.includes('/')) return false;
  if (literal.startsWith('/')) return false;
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(literal);
}

/** 런타임 리터럴 → 실재 소스. 루트 기준 리터럴(`bin/elanous.mjs`)은 «상대 지정자»가 아니므로 `''` 를 기준점으로
 *  쓴다 — 그래야 확장자·쿼리 규칙이 임포트 해석(`sourceCandidates`)과 **갈리지 않는다**. */
function resolveRuntimeTarget(testPath: string, literal: string, sources: ReadonlySet<string>): string | null {
  if (!isRepoRelativeLiteral(literal)) return null;
  const candidates = literal.startsWith('.')
    ? sourceCandidates(testPath, literal)
    : [normalize(stripModuleQuery(literal)), ...sourceCandidates('', literal)];
  return candidates.find((candidate) => sources.has(candidate)) ?? null;
}

interface RuntimeEdgeCall { readonly kind: RuntimeEdgeKind; readonly literals: readonly string[] }

/** 런타임 간선을 만드는 모듈 — `node:` 접두사는 벗겨 비교한다. `Bun` 은 전역이라 임포트가 없고, 수신
 *  객체 이름으로만 허용한다(`declaredRuntimeEdgeKind`). */
const RUNTIME_EDGE_MODULES: ReadonlySet<string> = new Set(['child_process', 'fs', 'fs/promises', 'bun']);

function isRuntimeEdgeModule(specifier: string): boolean {
  return RUNTIME_EDGE_MODULES.has(specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier);
}

/** 시험 파일의 런타임 모듈 임포트 바인딩 — 로컬 이름 → 임포트된 이름(네임스페이스·기본 임포트는 `'*'`).
 *  ⛔⭐ 임포트 출처를 알 수 없는 수신 객체는 간선을 만들지 «않는다»(무인 리뷰 must-fix) — `db.exec(...)`·
 *  `fsMock.readFile(...)` 같은 호출 이름이 spawn·file-state 간선으로 승격되던 오탐을 고치는 자리다. */
function runtimeEdgeImports(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!isRuntimeEdgeModule(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) bindings.set(clause.name.text, '*');
    const named = clause.namedBindings;
    if (!named) continue;
    if (ts.isNamespaceImport(named)) bindings.set(named.name.text, '*');
    else for (const element of named.elements) {
      if (element.isTypeOnly) continue;
      bindings.set(element.name.text, element.propertyName?.text ?? element.name.text);
    }
  }
  return bindings;
}

/** 수신 객체·맨살 callee 가 런타임 모듈에서 왔는지 임포트 바인딩으로 확인하고, 그럴 때만 클래스를 낸다.
 *  - `obj.method`: 수신 객체가 런타임 모듈 바인딩이거나 전역 `Bun` 일 때만.
 *  - 맨살 `fn(...)`: 런타임 모듈의 named import 이고 «임포트된 이름»이 표에 있을 때만(`as` 별칭도 잡는다).
 *  - 정규식 리터럴(`/re/.exec`)·출처를 알 수 없는 수신 객체는 `undefined` — 간선이 아니다. */
function declaredRuntimeEdgeKind(callee: ts.Expression, imports: ReadonlyMap<string, string>): RuntimeEdgeKind | undefined {
  if (ts.isPropertyAccessExpression(callee)) {
    const receiver = callee.expression;
    if (!ts.isIdentifier(receiver)) return undefined;
    if (receiver.text !== 'Bun' && !imports.has(receiver.text)) return undefined;
    return RUNTIME_EDGE_CALLS[callee.name.text];
  }
  if (ts.isIdentifier(callee)) {
    const imported = imports.get(callee.text);
    if (imported === undefined || imported === '*') return undefined;
    return RUNTIME_EDGE_CALLS[imported];
  }
  return undefined;
}

/** 시험 소스에서 런타임 호출을 찾아 «무엇을 지목했는지»까지 모은다. */
function runtimeEdgeCalls(text: string, path: string): RuntimeEdgeCall[] {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  const calls: RuntimeEdgeCall[] = [];
  const literalsOf = (node: ts.Node, out: string[]): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else ts.forEachChild(node, (child) => literalsOf(child, out));
  };
  const runtimeImports = runtimeEdgeImports(sourceFile);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const declared = declaredRuntimeEdgeKind(node.expression, runtimeImports);
      if (declared) {
        const literals: string[] = [];
        for (const argument of node.arguments) literalsOf(argument, literals);
        // `git` 은 파일을 «지목하지 않는» 별도 클래스다(`spawnSync('git', ['diff', …])` · `execSync('git …')`).
        const command = literals[0] ?? '';
        calls.push({ kind: /^git\b/.test(command) ? 'git' : declared, literals });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

/** 시험 1건의 런타임 간선과 «못 푼» 경로 리터럴. 지목한 소스가 하나도 없으면 `source: null` 간선 하나를 남긴다
 *  — 파일을 안 지목해도 실물 프로세스를 띄운 사실은 사라지지 않는다. */
function runtimeEdgesOfTest(text: string, testPath: string, sources: ReadonlySet<string>): { edges: RuntimeEdge[]; unresolved: readonly string[] } {
  const edges: RuntimeEdge[] = [];
  const unresolved: string[] = [];
  for (const call of runtimeEdgeCalls(text, testPath)) {
    const targets = call.literals.map((literal) => resolveRuntimeTarget(testPath, literal, sources));
    call.literals.forEach((literal, position) => {
      if (targets[position] !== null) return;
      if (!isRepoRelativeLiteral(literal) || !isSourceLikeSpecifier(literal)) return;
      // `.json`·`.css` 같은 자원은 «런타임 대상»이지 못 푼 소스가 아니다(`isSourceLikeSpecifier` 가 이미 거른다).
      if (!unresolved.includes(literal)) unresolved.push(literal);
    });
    const resolved = targets.filter((target): target is string => target !== null);
    for (const source of resolved.length > 0 ? resolved : [null]) edges.push({ test: testPath, kind: call.kind, source });
  }
  return { edges, unresolved };
}

/** 경로 정렬 — 기존 표시 순서(`localeCompare` 수치)와 같은 자를 쓴다. */
function comparePaths(left: string, right: string): number { return left.localeCompare(right, undefined, { numeric: true }); }

export function buildImporterTestIndex(cwd: string, testPaths: readonly string[], sourcePaths: readonly string[]): ImporterTestIndex | null {
  const sources = new Set(sourcePaths);
  const testsBySource = new Map<string, string[]>();
  let unresolvedRelativeSpecifiers = 0;
  const runtimeEdges: RuntimeEdge[] = [];
  const seenRuntimeEdges = new Set<string>();
  const unresolvedRuntimeTargets = new Set<string>();
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
    const runtime = runtimeEdgesOfTest(text, testPath, sources);
    for (const edge of runtime.edges) {
      const key = `${edge.test}\u0000${edge.kind}\u0000${edge.source ?? ''}`;
      if (seenRuntimeEdges.has(key)) continue;
      seenRuntimeEdges.add(key);
      runtimeEdges.push(edge);
    }
    for (const literal of runtime.unresolved) unresolvedRuntimeTargets.add(`${testPath}\u0000${literal}`);
  }
  return { testsBySource, testPaths, unresolvedRelativeSpecifiers, runtimeEdges, unresolvedRuntimeTargets: unresolvedRuntimeTargets.size };
}

export function importerTestsNotInRunSet(
  index: ImporterTestIndex,
  changed: readonly string[],
  runSet: readonly string[],
): { readonly total: number; readonly files: readonly string[]; readonly truncated: boolean; readonly unresolvedRelativeSpecifiers: number } {
  const names = [...new Set(changed.flatMap((source) => index.testsBySource.get(source) ?? []).filter((test) => !runSet.includes(test)))]
    .sort(comparePaths);
  const files = names.slice(0, IMPORTER_TEST_DISPLAY_LIMIT);
  return { total: names.length, files, truncated: names.length > files.length, unresolvedRelativeSpecifiers: index.unresolvedRelativeSpecifiers };
}

/** ⭐ 런타임 간선의 **영향 크기 실측** — 임포트 그래프가 «표현할 수 없는» 간선이 변경 감시에 얼마나 더하는가.
 *
 *  ⛔ #28322 착지분(BFS 분포·사람용 표 렌더링)은 여기서 재구현하지 않는다 — 이 함수는 **수**만 낸다.
 *  ⛔ «색인이 안 실렸다»와 «런타임 간선 0건»은 다른 값이다: `runtimeEdges` 가 없는 색인은 `pairs: 0` 이
 *    아니라 **못 잰 것**이므로 `measured: false` 로 드러낸다.
 *
 *  `handListed` 는 «손으로 관리하는 목록»이다(착지 열차의 `GATE_SPAWN_LANE_FILES`). 그 목록이 빠뜨린
 *  실측 시험 수가 곧 착지 열차 소비자의 영향 크기다.
 */
export function measureRuntimeEdgeImpact(
  index: ImporterTestIndex,
  changed: readonly string[],
  opts: { readonly handListed?: readonly string[] } = {},
): RuntimeEdgeImpact {
  const edges = index.runtimeEdges;
  const changedSet = new Set(changed);
  const pairs = new Set<string>();
  const testsByKind: Record<RuntimeEdgeKind, Set<string>> = { spawn: new Set(), git: new Set(), 'file-state': new Set() };
  for (const edge of edges ?? []) {
    if (edge.source === null || !changedSet.has(edge.source)) continue;
    // 이미 «임포트» 간선이 있는 짝은 런타임 간선의 몫이 아니다 — 같은 커버리지를 두 번 세지 않는다.
    if ((index.testsBySource.get(edge.source) ?? []).includes(edge.test)) continue;
    pairs.add(`${edge.test}\u0000${edge.source}`);
    testsByKind[edge.kind].add(edge.test);
  }
  const handListed = new Set(opts.handListed ?? []);
  const unlistedSpawnLaneTests = [...new Set((edges ?? [])
    .filter((edge) => edge.kind === 'spawn' || edge.kind === 'git')
    .map((edge) => edge.test))]
    .filter((test) => !handListed.has(test))
    .sort(comparePaths);
  return {
    measured: edges !== undefined,
    pairs: pairs.size,
    byKind: { spawn: testsByKind.spawn.size, git: testsByKind.git.size, 'file-state': testsByKind['file-state'].size },
    unlistedSpawnLaneTests,
    unresolvedRuntimeTargets: index.unresolvedRuntimeTargets ?? 0,
  };
}
