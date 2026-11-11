#!/usr/bin/env bun
/**
 * Build a case-level inventory from Bun JUnit gate reports and the matching
 * test source. JUnit is authoritative for which cases actually ran; source
 * analysis adds static structure and a short contract cue.
 * An immediately preceding `// @oracle-axis X2:I1 X3:I4` declares the RFC axis/invariant
 * pairs backed by an assertion call in a uniquely matched case with a passing attempt. This is static
 * source evidence, not proof that a particular branch reached the assertion at runtime.
 * Failed-only, skipped, unmatched or missing source stays unknown;
 * a matched case without a supported declaration and assertion stays unclassified.
 *
 *   bun scripts/test-census.ts [gate-logs/cut] [--source-root repo] [--format tsv|markdown|json] [--out path]
 */
import { existsSync, realpathSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { XMLParser } from 'fast-xml-parser';
import { spawnSyncText } from '../src/util/spawn-sync-output.js';

type CaseAttempt = { report: string; document: number; seconds: number | null; result: 'passed' | 'failed' | 'skipped' };

type JunitCase = {
  file: string;
  classname: string;
  name: string;
  suitePath: string[];
  line: number | null;
  seconds: number | null;
  attempts: CaseAttempt[];
  result: 'passed' | 'failed' | 'skipped';
};

type CaseSource = {
  title: string;
  templateFragments: string[];
  suite: string[];
  body: ts.Node | undefined;
  line: number;
  assertions: string[];
  oracleAxes?: string[];
};

type SourceFacts = {
  imports: number;
  dynamicImports: number;
  fileSignals: string[];
  cases: CaseSource[];
};

export type NumericCandidateLocation = { literal: string; line: number };
export type NumericCandidateProvenance = NumericCandidateLocation & {
  blameCommit: string | null;
  reason: string | null;
};

type CensusRow = JunitCase & {
  sourceStatus: 'parsed' | 'missing';
  caseMatch: 'matched' | 'unmatched';
  imports: number | null;
  dynamicImports: number | null;
  spawn: boolean | null;
  sleep: boolean | null;
  network: boolean | null;
  loops: number | null;
  numericCandidates: string[];
  numericCandidateProvenance: NumericCandidateProvenance[] | null;
  contract: string;
  sourceLine: number | null;
  oracleAxes: string[] | null;
};

function repositoryFile(file: string): string {
  const normalized = file.replaceAll('\\', '/');
  const knownRoot = '/elanous-source/';
  const rootAt = normalized.lastIndexOf(knownRoot);
  if (rootAt >= 0) return normalized.slice(rootAt + knownRoot.length);
  return file;
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function junitCases(reportPaths: string[], gateDir: string): JunitCase[] {
  const cases = new Map<string, JunitCase>();
  const retryNumber = (path: string): number => Number(/\.retry-(\d+)\.junit\.xml$/.exec(path)?.[1] ?? -1);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'testsuite' || name === 'testcase',
  });
  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined ? [] : [value];
  const caseElements = (root: unknown): Array<{ attrs: Record<string, unknown>; suitePath: string[] }> => {
    const found: Array<{ attrs: Record<string, unknown>; suitePath: string[] }> = [];
    const visit = (node: unknown, suitePath: string[] = []): void => {
      if (Array.isArray(node)) { for (const item of node) visit(item, suitePath); return; }
      const object = asRecord(node);
      if (!object) return;
      for (const [name, value] of Object.entries(object)) {
        if (name === 'testcase') {
          for (const item of asArray(value)) { const testcase = asRecord(item); if (testcase) found.push({ attrs: testcase, suitePath }); }
        } else if (name === 'testsuite') {
          for (const item of asArray(value)) {
            const suite = asRecord(item);
            if (!suite) continue;
            const suiteName = String(suite['@_name'] ?? '');
            const suiteFile = String(suite['@_file'] ?? '');
            const isFileSuite = suiteName === suiteFile || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(suiteName);
            visit(suite, suiteName && !isFileSuite ? [...suitePath, suiteName] : suitePath);
          }
        } else if (!name.startsWith('@_')) visit(value, suitePath);
      }
    };
    visit(root);
    return found;
  };
  for (const report of reportPaths.sort((a, b) => retryNumber(a) - retryNumber(b) || a.localeCompare(b))) {
    const xml = readFileSync(report, 'utf8');
    const documents = xml.split(/(?=<\?xml\b)/g).filter((part) => part.trim());
    for (const [documentIndex, document] of documents.entries()) {
      const parsed = parser.parse(document) as unknown;
      for (const { attrs, suitePath } of caseElements(parsed)) {
        const rawName = String(attrs['@_name'] ?? '<missing-name>');
        const nameParts = rawName.split(' > ');
        const nameHasFile = nameParts.length > 1 && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(nameParts[0]!);
        const file = repositoryFile(String(attrs['@_file'] ?? (nameHasFile ? nameParts[0] : '<missing-file>')));
        const name = nameHasFile ? nameParts.slice(1).join(' > ') : rawName;
        const classname = String(attrs['@_classname'] ?? '');
        const line = Number(attrs['@_line']);
        const time = Number(attrs['@_time']);
        const key = `${file}\0${suitePath.join('\0')}\0${classname}\0${name}`;
        const hasChild = (tag: string): boolean => Object.hasOwn(attrs, tag);
        const result = hasChild('failure') || hasChild('error') ? 'failed' : hasChild('skipped') ? 'skipped' : 'passed';
        const attempt: CaseAttempt = {
          report: relative(gateDir, report).replaceAll('\\', '/'),
          document: documentIndex + 1,
          seconds: Number.isFinite(time) ? time : null,
          result,
        };
        const existing = cases.get(key);
        if (existing) {
          existing.attempts.push(attempt);
          existing.result = result;
          continue;
        }
        cases.set(key, {
          file,
          classname,
          name,
          suitePath,
          line: Number.isInteger(line) && line > 0 ? line : null,
          seconds: attempt.seconds,
          attempts: [attempt],
          result,
        });
      }
    }
  }
  return [...cases.values()].sort((a, b) => a.file.localeCompare(b.file) || a.classname.localeCompare(b.classname) || a.name.localeCompare(b.name));
}

const callName = (expression: ts.Expression): string => expression.getText().replace(/\s+/g, '');
const isString = (node: ts.Expression | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

function apiRoot(expression: ts.Expression): string | undefined {
  let current = expression;
  while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = ts.isCallExpression(current) ? current.expression : current.expression;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function titleFrom(node: ts.Expression | undefined): { title: string; fragments: string[] } | undefined {
  if (isString(node)) return { title: node.text, fragments: [node.text] };
  if (!node || !ts.isTemplateExpression(node)) return undefined;
  const fragments = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].filter(Boolean);
  return { title: node.getText(), fragments };
}

function assertionKinds(body: ts.Node | undefined): string[] {
  const kinds = new Set<string>();
  if (!body) return [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      const matcher = /\.(to[A-Z]\w*|rejects|resolves)$/.exec(name)?.[1];
      if (matcher) kinds.add(matcher);
      if (/^(expect|assert|assert\.[\w$]+)$/.test(name)) kinds.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return [...kinds].sort();
}

// Source: 내부 문서 `RFC-sim-edge-creator` §3b–3c maps X1–X4 to I1–I7.
const ORACLE_AXIS_PAIRS = new Set(['X1:I1', 'X1:I3', 'X2:I1', 'X2:I2', 'X2:I7', 'X3:I1', 'X3:I3', 'X3:I4', 'X4:I5', 'X4:I6']);
class InvalidOracleAxisError extends Error {}

function hasOracleAssertion(body: ts.Node | undefined): boolean {
  if (!body) return false;
  let found = false;
  const objectMethods = new Set(['toString', 'toLocaleString', 'toJSON', 'toISOString', 'toUTCString', 'toFixed', 'toLowerCase', 'toUpperCase', 'toPrecision', 'toExponential']);
  const assertMethods = new Set(['ok', 'equal', 'notEqual', 'strictEqual', 'notStrictEqual', 'deepEqual', 'notDeepEqual', 'deepStrictEqual', 'notDeepStrictEqual', 'throws', 'doesNotThrow', 'rejects', 'doesNotReject', 'match', 'doesNotMatch', 'ifError', 'fail']);
  const isExpectReceiver = (expression: ts.Expression): boolean => {
    let current = expression;
    while (ts.isPropertyAccessExpression(current) && ['not', 'resolves', 'rejects'].includes(current.name.text)) current = current.expression;
    return ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === 'expect';
  };
  const visit = (node: ts.Node): void => {
    if (node !== body && (ts.isClassDeclaration(node) || ts.isClassExpression(node))) return;
    if (node !== body && ts.isFunctionLike(node)) {
      let invocation: ts.Node = node;
      while (ts.isParenthesizedExpression(invocation.parent)) invocation = invocation.parent;
      const parent = invocation.parent;
      const guaranteedArrayCallback = ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)
        && ts.isPropertyAccessExpression(parent.expression)
        && ['forEach', 'map', 'flatMap', 'filter'].includes(parent.expression.name.text)
        && ts.isArrayLiteralExpression(parent.expression.expression)
        && parent.expression.expression.elements.some((element) => !ts.isSpreadElement(element) && !ts.isOmittedExpression(element));
      const invoked = ts.isCallExpression(parent) && (parent.expression === invocation
        || guaranteedArrayCallback);
      if (!invoked) return;
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const expectMatcher = ts.isPropertyAccessExpression(expression)
        && /^to[A-Z]/.test(expression.name.text)
        && !objectMethods.has(expression.name.text)
        && isExpectReceiver(expression.expression);
      const assertCall = ts.isIdentifier(expression) && expression.text === 'assert'
        || ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'assert' && assertMethods.has(expression.name.text);
      if (expectMatcher || assertCall) found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

function declaredOracleAxes(node: ts.CallExpression, source: ts.SourceFile, body: ts.Node | undefined): string[] {
  const statement = ts.isExpressionStatement(node.parent) ? node.parent : node;
  const comments = ts.getLeadingCommentRanges(source.text, statement.getFullStart()) ?? [];
  const comment = comments.at(-1);
  if (!comment || comment.kind !== ts.SyntaxKind.SingleLineCommentTrivia) return [];
  const gap = source.text.slice(comment.end, statement.getStart(source));
  if (!/^[ \t]*\r?\n[ \t]*$/.test(gap)) return [];
  const axes = new Set<string>();
  const text = source.text.slice(comment.pos, comment.end);
  const declaration = /^\/\/\s*@oracle-axis\s+(.+)$/.exec(text);
  if (declaration) {
    for (const pair of declaration[1]!.split(/[\s,]+/).filter(Boolean)) {
      if (!ORACLE_AXIS_PAIRS.has(pair)) throw new InvalidOracleAxisError(`invalid oracle axis ${pair} at ${source.fileName}`);
      axes.add(pair);
    }
  }
  return hasOracleAssertion(body) ? [...axes].sort() : [];
}

function parseSource(path: string): SourceFacts {
  const source = readFileSync(path, 'utf8');
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const cases: CaseSource[] = [];
  const suites: string[] = [];
  let imports = 0;
  let dynamicImports = 0;
  const fileSignals = new Set<string>();
  for (const statement of sf.statements) if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) imports += 1;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const rawName = callName(node.expression);
      if (rawName === 'import' || rawName.startsWith('import(')) dynamicImports += 1;
      if (/\b(?:Bun\.)?spawn(?:Sync)?\b|\b(?:exec|execSync|execFile|execFileSync|fork)\b|\.spawn\(/.test(rawName)) fileSignals.add('spawn');
      if (/\b(?:sleep|delay)\b|\b(?:setTimeout|setInterval)\b|Bun\.sleep/.test(rawName)) fileSignals.add('sleep');
      if (/\bfetch\b|\brequest\b|\b(?:https?|http|WebSocket)\.(?:request|get|connect)\b|\bnewWebSocket\b|\baxios\.(?:get|post|put|patch|delete)\b/.test(rawName)) fileSignals.add('network');
      const root = apiRoot(node.expression);
      const titleArg = node.arguments[0];
      const title = titleFrom(titleArg);
      if ((root === 'describe' || root === 'suite') && title?.fragments.length === 1) {
        suites.push(title.fragments[0]!);
        const callback = node.arguments[1];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          visit(callback.body);
        }
        suites.pop();
        for (const arg of node.arguments.slice(2)) visit(arg);
        return;
      }
      if (root === 'test' || root === 'it') {
        const callback = node.arguments.find((arg, index) => index > 0 && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)));
        const body = callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback.body : undefined;
        const assertions = assertionKinds(body);
        cases.push({ title: title?.title ?? '<dynamic-title>', templateFragments: title?.fragments ?? [], suite: [...suites], body, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, assertions, oracleAxes: declaredOracleAxes(node, sf, body) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { imports, dynamicImports, fileSignals: [...fileSignals].sort(), cases };
}

export function caseFor(row: JunitCase, cases: CaseSource[]): CaseSource | undefined {
  const sameIdentity = cases.filter((item) => {
    const suiteMatches = item.suite.length === row.suitePath.length && item.suite.every((part, index) => part === row.suitePath[index]);
    const classnameMatches = row.classname === item.suite.join(' > ');
    return suiteMatches && classnameMatches;
  });
  const sameTitle = sameIdentity.filter((item) => {
    if (item.templateFragments.length === 0) return false;
    if (/%[sdifjpoO#]/.test(item.title)) {
      const fragments = item.title.split(/%[sdifjpoO#]/g);
      let cursor = 0;
      for (let index = 0; index < fragments.length; index += 1) {
        const fragment = fragments[index]!;
        if (!fragment) continue;
        const found = row.name.indexOf(fragment, cursor);
        if (found < 0 || (index === 0 && found !== 0)) return false;
        cursor = found + fragment.length;
        if (index === fragments.length - 1 && cursor !== row.name.length) return false;
      }
      return cursor < row.name.length || fragments.at(-1) !== '';
    }
    if (item.title === row.name) return true;
    if (item.templateFragments.length < 2) return false;
    let cursor = 0;
    for (let index = 0; index < item.templateFragments.length; index += 1) {
      const fragment = item.templateFragments[index]!;
      const found = row.name.indexOf(fragment, cursor);
      if (found < 0 || (index === 0 && found !== 0)) return false;
      cursor = found + fragment.length;
      if (index === item.templateFragments.length - 1 && cursor !== row.name.length) return false;
    }
    return true;
  });
  return sameTitle.length === 1 ? sameTitle[0] : undefined;
}

export function sourcePathFor(file: string, sourceRoot: string): string | undefined {
  const root = resolve(sourceRoot);
  const path = isAbsolute(file) ? resolve(file) : resolve(root, file);
  const fromRoot = relative(root, path);
  if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) return undefined;
  return path;
}

function bodyMetrics(body: ts.Node | undefined): { loops: number | null; numericCandidates: string[]; candidateLocations: NumericCandidateLocation[] } {
  if (!body) return { loops: null, numericCandidates: [], candidateLocations: [] };
  let loops = 0;
  const numbers = new Map<string, NumericCandidateLocation>();
  const visit = (node: ts.Node): void => {
    if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) loops += 1;
    if (ts.isNumericLiteral(node)) {
      const n = Number(node.text.replace(/_/g, ''));
      if (Number.isFinite(n) && Math.abs(n) > 1) {
        const source = node.getSourceFile();
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        numbers.set(`${node.text}\0${line}`, { literal: node.text, line });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  const candidateLocations = [...numbers.values()].sort((a, b) => a.line - b.line || Number(a.literal.replace(/_/g, '')) - Number(b.literal.replace(/_/g, '')) || a.literal.localeCompare(b.literal));
  const numericCandidates = [...new Set(candidateLocations.map(({ literal }) => literal))]
    .sort((a, b) => Number(a.replace(/_/g, '')) - Number(b.replace(/_/g, '')) || a.localeCompare(b));
  return { loops, numericCandidates, candidateLocations };
}

const blameCache = new Map<string, Map<number, string>>();
const reasonCache = new Map<string, string | null>();
const repositoryRootCache = new Map<string, string | null>();
const shallowRepositoryCache = new Map<string, boolean>();

/** Attribute each candidate literal to its introducing commit without guessing when history is unavailable. */
export function numericCandidateEvidence(
  sourcePath: string,
  candidates: NumericCandidateLocation[],
  sourceRoot: string,
): NumericCandidateProvenance[] {
  if (!candidates.length) return [];
  const rootPath = resolve(sourceRoot);
  const rootKey = existsSync(rootPath) ? realpathSync(rootPath) : rootPath;
  if (!repositoryRootCache.has(rootKey)) {
    try { repositoryRootCache.set(rootKey, spawnSyncText('git', ['rev-parse', '--show-toplevel'], { cwd: rootKey, encoding: 'utf8' }).trim()); }
    catch { repositoryRootCache.set(rootKey, null); }
  }
  const repositoryRoot = repositoryRootCache.get(rootKey);
  if (!repositoryRoot) {
    return candidates.map((candidate) => ({ ...candidate, blameCommit: null, reason: null }));
  }
  if (!shallowRepositoryCache.has(repositoryRoot)) {
    try {
      shallowRepositoryCache.set(repositoryRoot, spawnSyncText('git', ['rev-parse', '--is-shallow-repository'], { cwd: repositoryRoot, encoding: 'utf8' }).trim() === 'true');
    } catch { shallowRepositoryCache.set(repositoryRoot, true); }
  }
  const shallowRepository = shallowRepositoryCache.get(repositoryRoot) ?? true;
  const sourceAbsolute = resolve(sourcePath);
  const canonicalSource = existsSync(sourceAbsolute) ? realpathSync(sourceAbsolute) : sourceAbsolute;
  const pathFromRepository = relative(repositoryRoot, canonicalSource).replaceAll('\\', '/');
  if (!pathFromRepository || pathFromRepository === '..' || pathFromRepository.startsWith('../') || isAbsolute(pathFromRepository)) {
    return candidates.map((candidate) => ({ ...candidate, blameCommit: null, reason: null }));
  }
  const cacheKey = `${repositoryRoot}\0${pathFromRepository}`;
  let blameByLine = blameCache.get(cacheKey);
  if (!blameByLine) {
    blameByLine = new Map<number, string>();
    blameCache.set(cacheKey, blameByLine);
  }
  const missingLines = [...new Set(candidates.map(({ line }) => line).filter((line) => Number.isInteger(line) && line > 0 && !blameByLine!.has(line)))].sort((a, b) => a - b);
  if (missingLines.length) {
    const ranges: Array<[number, number]> = [];
    for (const line of missingLines) {
      const last = ranges.at(-1);
      if (last && line === last[1] + 1) last[1] = line;
      else ranges.push([line, line]);
    }
    try {
      const args = ['blame', '--line-porcelain'];
      for (const [start, end] of ranges) args.push('-L', `${start},${end}`);
      args.push('--', pathFromRepository);
      const blame = spawnSyncText('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
      let record: { commit: string; line: number; boundary: boolean } | undefined;
      for (const line of blame.split('\n')) {
        const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
        if (header) {
          record = { commit: header[1]!, line: Number(header[2]), boundary: false };
          continue;
        }
        if (!record) continue;
        if (line === 'boundary') record.boundary = true;
        if (line.startsWith('\t')) {
          blameByLine.set(record.line, record.boundary && shallowRepository ? '' : record.commit);
          record = undefined;
        }
      }
    } catch { /* Untracked or unavailable lines have no blame evidence. */ }
    for (const line of missingLines) if (!blameByLine.has(line)) blameByLine.set(line, '');
  }
  return candidates.map((candidate) => {
    const commit = blameByLine!.get(candidate.line);
    if (!commit || /^0+$/.test(commit)) return { ...candidate, blameCommit: null, reason: null };
    if (!reasonCache.has(commit)) {
      try {
        const message = spawnSyncText('git', ['show', '-s', '--format=%B', commit], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
        reasonCache.set(commit, message || null);
      } catch { reasonCache.set(commit, null); }
    }
    return { ...candidate, blameCommit: commit, reason: reasonCache.get(commit) ?? null };
  });
}

function provenanceCell(row: CensusRow, field: 'blameCommit' | 'reason'): string {
  if (row.caseMatch === 'unmatched' || row.sourceStatus === 'missing' || row.numericCandidateProvenance === null) return '미확인';
  return row.numericCandidateProvenance.map((candidate) => {
    const value = candidate[field];
    return `${candidate.literal}@${candidate.line}=${value?.replaceAll('|', '\\|').replaceAll('\n', ' ') ?? '미확인'}`;
  }).join('<br>') || '없음';
}

function markdown(rows: CensusRow[], reportCount: number, gateDir: string, sourceRoot: string, shardStates?: Record<string, number>): string {
  const esc = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const numeric = (row: CensusRow): string => row.caseMatch === 'unmatched' || row.sourceStatus === 'missing'
    ? '미확인' : row.numericCandidates.map(esc).join(', ') || '없음';
  const attempts = (row: CensusRow): string => row.attempts.map((attempt) => `${attempt.report}#${attempt.document}:${attempt.seconds?.toFixed(4) ?? '미측정'}s/${attempt.result}`).join('<br>');
  const lines = [
    `# Test census — gate 0.3.5 cut`,
    '',
    `Source: \`${gateDir}\` · code: \`${sourceRoot}\` · JUnit reports ${reportCount} · shards ${JSON.stringify(shardStates ?? 'unknown')} · unique cases ${rows.length}. Oracle axes are explicit source declarations with assertion calls in matched cases with a passing attempt; branch-level assertion reach is not measured. Import counts and call signals are static file-level indicators; loops and numeric candidates are scoped to uniquely matched case bodies. Numeric literals greater than one are candidates, not confirmed expected values. Blame commit and its full message are provenance only; human review decides whether the rationale still justifies the assertion.`,
    '',
    '| 파일 | suite 경로 | classname | 케이스 | 게이트 소요(s, 첫 실행) | 시도별 소요·결과 | import 수(정적/동적) | spawn/sleep/네트워크(정적 신호) | 반복 루프 | 기대값 리터럴 후보(>1) | git blame 커밋 | 사유(커밋 메시지) | 판정 오라클 축 | 계약 요약 | 소스 상태 | 케이스 연결 |',
    '|---|---|---|---|---:|---|---:|---|---:|---|---|---|---|---|---|---|',
  ];
  for (const row of rows) {
    const signalNames = ['spawn', 'sleep', 'network'].filter((key) => row[key as 'spawn' | 'sleep' | 'network']);
    const staticSignals = row.sourceStatus === 'missing' ? '미확인' : signalNames.join(', ') || '없음';
    lines.push(`| ${esc(row.file)} | ${esc(row.suitePath.join(' > '))} | ${esc(row.classname)} | ${esc(row.name)} | ${row.seconds?.toFixed(4) ?? '미측정'} | ${attempts(row)} | ${row.imports ?? '미확인'}/${row.dynamicImports ?? '미확인'} | ${staticSignals} | ${row.loops ?? '미확인'} | ${numeric(row)} | ${provenanceCell(row, 'blameCommit')} | ${provenanceCell(row, 'reason')} | ${row.oracleAxes === null ? '미확인' : row.oracleAxes.join(', ') || '미분류'} | ${esc(row.contract)} | ${row.sourceStatus} | ${row.caseMatch} |`);
  }
  return `${lines.join('\n')}\n`;
}

function tsv(rows: CensusRow[], reportCount: number, gateDir: string, sourceRoot: string, shardStates?: Record<string, number>): string {
  const escape = (value: unknown): string => String(value ?? '').replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\r', '').replaceAll('\n', '\\n');
  const columns: Array<keyof CensusRow> = ['file', 'suitePath', 'classname', 'name', 'line', 'seconds', 'result', 'attempts', 'sourceStatus', 'caseMatch', 'imports', 'dynamicImports', 'spawn', 'sleep', 'network', 'loops', 'numericCandidates', 'numericCandidateProvenance', 'oracleAxes', 'contract', 'sourceLine'];
  const cellValue = (row: CensusRow, column: keyof CensusRow): unknown => {
    if (column === 'attempts') return JSON.stringify(row.attempts);
    if (column === 'suitePath') return row.suitePath.join(' > ');
    if (['imports', 'dynamicImports', 'spawn', 'sleep', 'network', 'loops'].includes(column) && row[column] === null) return 'unknown';
    if (column === 'numericCandidates' && (row.caseMatch === 'unmatched' || row.sourceStatus === 'missing')) return 'unknown';
    if (column === 'numericCandidateProvenance' && (row.caseMatch === 'unmatched' || row.sourceStatus === 'missing')) return 'unknown';
    if (column === 'numericCandidateProvenance') return JSON.stringify(row.numericCandidateProvenance);
    if (column === 'oracleAxes') return row.oracleAxes === null ? 'unknown' : row.oracleAxes.join(',') || 'unclassified';
    return Array.isArray(row[column]) ? (row[column] as string[]).join(',') : row[column];
  };
  return [
    `# gateDir=${gateDir} sourceRoot=${sourceRoot} reports=${reportCount} cases=${rows.length} shards=${JSON.stringify(shardStates ?? 'unknown')}; oracleAxes=declared source pair + assertion call in matched case with passing attempt (branch reach unmeasured); imports/call-signals are static file-level indicators; loops/numeric-candidates are from uniquely matched case bodies; numericCandidateProvenance is candidate literal + blame SHA + full commit message (unknown differs from none); seconds=first report, result=last parsed attempt, attempts=all report/document timings and outcomes`,
    columns.join('\t'),
    ...rows.map((row) => columns.map((column) => escape(cellValue(row, column))).join('\t')),
  ].join('\n') + '\n';
}

export function renderTestCensus(args: string[]): string {
  const root = process.cwd();
  const positional = args[0] && !args[0]!.startsWith('--') ? args[0] : undefined;
  const gateDir = resolve(positional ?? join(process.env.HOME ?? '', '.elanous/release/0.3.5/gate-logs/cut'));
  const sourceRootIndex = args.indexOf('--source-root');
  if (sourceRootIndex >= 0 && !args[sourceRootIndex + 1]) throw new Error('--source-root requires a directory');
  const sourceRoot = resolve(sourceRootIndex >= 0 ? args[sourceRootIndex + 1]! : root);
  const formatIndex = args.indexOf('--format');
  const format = formatIndex >= 0 ? args[formatIndex + 1] : 'tsv';
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (format !== 'markdown' && format !== 'json' && format !== 'tsv') throw new Error('--format must be markdown, tsv or json');
  const reportPaths = filesUnder(gateDir).filter((path) => path.endsWith('.junit.xml'));
  if (!reportPaths.length) throw new Error(`no JUnit reports under ${gateDir}`);
  const manifestPath = join(gateDir, 'shards.json');
  const manifest = (() => {
    try { return JSON.parse(readFileSync(manifestPath, 'utf8')) as { shards?: Array<{ state?: string }> }; }
    catch { return undefined; }
  })();
  const shardStates = manifest?.shards?.reduce<Record<string, number>>((counts, shard) => {
    const state = shard.state ?? 'unknown';
    counts[state] = (counts[state] ?? 0) + 1;
    return counts;
  }, {});
  const cases = junitCases(reportPaths, gateDir);
  const sourceCache = new Map<string, SourceFacts | null>();
  const rows: CensusRow[] = cases.map((row) => {
    const sourcePath = sourcePathFor(row.file, sourceRoot);
    let facts = sourcePath ? sourceCache.get(sourcePath) : null;
    if (sourcePath && facts === undefined) {
      try { facts = parseSource(sourcePath); } catch (error) { if (error instanceof InvalidOracleAxisError) throw error; facts = null; }
      sourceCache.set(sourcePath, facts);
    }
    const matched = facts ? caseFor(row, facts.cases) : undefined;
    const metrics = bodyMetrics(matched?.body);
    const signals = new Set(facts?.fileSignals ?? []);
    const contract = matched ? `${row.name}${matched.assertions.length ? ` · 확인: ${matched.assertions.join(', ')}` : ''}` : row.name;
    return {
      ...row,
      sourceStatus: facts ? 'parsed' : 'missing',
      caseMatch: matched ? 'matched' : 'unmatched',
      imports: facts?.imports ?? null,
      dynamicImports: facts?.dynamicImports ?? null,
      spawn: facts ? signals.has('spawn') : null,
      sleep: facts ? signals.has('sleep') : null,
      network: facts ? signals.has('network') : null,
      loops: metrics.loops,
      numericCandidates: metrics.numericCandidates,
      numericCandidateProvenance: sourcePath && matched ? numericCandidateEvidence(sourcePath, metrics.candidateLocations, sourceRoot) : matched ? [] : null,
      contract,
      sourceLine: matched?.line ?? null,
      oracleAxes: matched && row.attempts.some((attempt) => attempt.result === 'passed') ? matched.oracleAxes ?? [] : null,
    };
  });
  const output = format === 'json'
    ? `${JSON.stringify({ gateDir, sourceRoot, reports: reportPaths.length, shardStates, complete: !!shardStates && Object.entries(shardStates).every(([state, count]) => state === 'done' || count === 0), cases: rows.length, rows }, null, 2)}\n`
    : format === 'tsv' ? tsv(rows, reportPaths.length, gateDir, sourceRoot, shardStates) : markdown(rows, reportPaths.length, gateDir, sourceRoot, shardStates);
  if (out) writeFileSync(out, output);
  return out ? '' : output;
}

if (import.meta.main) process.stdout.write(renderTestCensus(process.argv.slice(2)));
