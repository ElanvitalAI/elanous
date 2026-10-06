/** Changed-file tsc gate with a visible ratchet for pre-existing test-only debt. */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import {
  TYPECHECK_GATE_CONFIG,
  classifyTypecheckErrors,
  diffTypecheckDiagnostics,
  parseTypecheckErrors,
  readTestTypecheckBaseline,
  type TypecheckError,
} from '../src/typecheck-ratchet.js';
import { debug } from '../src/debug/log.js';
import { tscEnv } from '../src/typecheck-ratchet.js';

/** Inherited GIT_DIR / GIT_WORK_TREE would make `--cwd <other tree>` still read the launcher's repo. */
function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  return env;
}

/** git 조회용 — 명령 실패는 호출자가 빈 출력과 구분할 수 있게 전파한다. */
function sh(cmd: string, cwd = process.cwd()): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd, env: gitEnv() });
}

export type TscRun = { out: string; ran: boolean; why?: string };

export { TSC_HEAP_MB, tscEnv } from '../src/typecheck-ratchet.js';
/** V8 힙 부족의 얼굴 — 「타입 에러」와 «다른 값»이다. */
const OOM = /heap out of memory|Ineffective mark-compacts near heap limit/;

/** tsc 실행 결과 — 실행 여부와 진단 출력을 분리한다. */
export function runTsc(cmd: string, exec = execSync): TscRun {
  try {
    const out = exec(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: tscEnv(), maxBuffer: 64 * 1024 * 1024 }) as unknown as string;
    return { out: String(out ?? ''), ran: true };
  } catch (error: unknown) {
    const e = error as { status?: number | null; signal?: string | null; stdout?: string; stderr?: string; code?: string };
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    if (OOM.test(out)) return { out, ran: false, why: `tsc 가 V8 힙 부족(OOM)으로 죽었다 — 타입 에러가 아니다 (NODE_OPTIONS=${tscEnv().NODE_OPTIONS})` };
    if (e.signal || e.code === 'ENOENT' || e.status === null || e.status === undefined) {
      return { out, ran: false, why: `tsc 실행 실패 (signal=${String(e.signal)} code=${String(e.code)} status=${String(e.status)})` };
    }
    if (e.status !== 1 && e.status !== 2) return { out, ran: false, why: `tsc 종료코드 ${e.status}` };
    if (/error TS\d+/.test(out) && parseTypecheckErrors(out).length === 0) {
      return { out, ran: false, why: 'tsc 가 에러를 냈으나 파서가 한 건도 읽지 못했다(형식 불일치)' };
    }
    if (!/error TS\d+/.test(out)) {
      return { out, ran: false, why: `tsc 가 종료코드 ${e.status} 로 끝났는데 TS 진단이 한 건도 없다(래퍼 실패로 본다)` };
    }
    return { out, ran: true };
  }
}

export type ChangedTsFiles = {
  files: Set<string>;
  base: string;
  baseSource: string;
  head?: string;
  diffFiles?: Set<string>;
  warnings?: string[];
  failures?: { command: string; why: string }[];
};

/** 선택한 base와 파일 수를 함께 보존한다. 0개도 base 기준 관측값이다.
 *  `cwd` 는 착지 트리다 — `pr land --cwd` 가 프로세스 cwd 가 아니라 그 트리를 재게 한다. */
export function changedTsFiles(run: (cmd: string) => string = sh, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), baseRef?: string): ChangedTsFiles {
  let base: string;
  let baseSource: string;
  const pinned = baseRef ?? env.TSC_BASE_REF;
  if (pinned) {
    base = pinned;
    baseSource = baseRef ? 'baseRef' : 'TSC_BASE_REF';
  } else if (env.GITHUB_BASE_REF) {
    base = `origin/${env.GITHUB_BASE_REF}`;
    baseSource = 'GITHUB_BASE_REF';
  } else {
    let mergeBase = '';
    try { mergeBase = run('git merge-base HEAD origin/main').trim(); } catch { /* HEAD~1 fallback below */ }
    if (mergeBase) {
      base = mergeBase;
      baseSource = 'merge-base(origin/main)';
    } else {
      base = 'HEAD~1';
      baseSource = 'HEAD~1 fallback (origin/main merge-base unavailable)';
    }
  }

  const failures: { command: string; why: string }[] = [];
  // Revision reads are observational: an unreadable HEAD/base must not turn into a collection failure.
  const quietRevision = (command: string): string => { try { return run(command).trim(); } catch { return ''; } };
  const head = quietRevision('git rev-parse HEAD') || undefined;
  const warnings: string[] = [];
  if (head && quietRevision(`git rev-parse ${base}`) === head) {
    const main = quietRevision('git rev-parse origin/main');
    const merged = main && main !== head ? quietRevision('git merge-base HEAD origin/main') : '';
    if (merged && merged !== head) {
      warnings.push(`base=${base} 가 HEAD 와 같은 커밋 — origin/main (${main})과 달라 merge-base 로 재계산`);
      base = merged;
      baseSource = 'recomputed merge-base(origin/main)';
    } else if (main && main !== head) {
      failures.push({ command: `git rev-parse ${base}`, why: `base 가 HEAD(${head}) 와 같아 변경을 셀 수 없다 — TSC_BASE_REF 로 base 를 주라 (못 셌음 ≠ 0)` });
    }
  }

  const files = new Set<string>();
  const diffFiles = new Set<string>();
  const commands = [`git diff --name-only ${base}...HEAD`, 'git diff --name-only HEAD', 'git ls-files --others --exclude-standard'];
  for (const command of commands) {
    try {
      for (const line of run(command).split('\n')) {
        const file = line.trim().replace(/^\.\//, '');
        if (!file) continue;
        const ts = /\.tsx?$/.test(file);
        // A deleted .ts is not a compile candidate, so it must not count as «should have been collected».
        // existsSync is bound to the landing tree — process.cwd() would count the launcher's files.
        const present = existsSync(join(cwd, file));
        if (!ts || present) diffFiles.add(file);
        if (ts && present) files.add(file);
      }
    } catch (cause) {
      failures.push({ command, why: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return { files, base, baseSource, head, diffFiles, warnings, failures };
}

type RequiredExportField = { typeName: string; fieldName: string };
type RemovedExportedSymbol = { name: string; file?: string };
type AddedFunctionParameter = { name: string; from: number; to: number; file?: string };
type RequiredExportFieldCheck = {
  fields: RequiredExportField[];
  removedSymbols: RemovedExportedSymbol[];
  parameterIncreases: AddedFunctionParameter[];
  failure?: string;
};
type ChangedPathResult = {
  fields: RequiredExportField[];
  paths?: Map<string, string>;
  failure?: string;
};
type LiteralUnionMember = { typeName: string; literal: string; propertyName?: string };
type LiteralUnionAddition = LiteralUnionMember & { file: string };
type LiteralUnionRemoval = LiteralUnionMember & { file: string };
type LiteralUnionReference = LiteralUnionRemoval & { referenceFile: string; line: number };
type LiteralUnionMemberCheck = { additions: LiteralUnionAddition[]; removals?: LiteralUnionReference[]; failure?: string };
type RepositorySources = ReadonlyMap<string, string>;
type Field = { optional: boolean; type: string; method?: boolean; methodTypes?: string[] };
type FunctionShape = { parameterCount: number };
type DeclarationShapes = Map<string, Map<string, Field>>;
type LiteralUnions = Map<string, Set<string>>;
type DiscriminantLiterals = Map<string, Map<string, Set<string>>>;
type ExportShape = {
  declarations: DeclarationShapes;
  exported: Set<string>;
  literalUnions: LiteralUnions;
  discriminantLiterals: DiscriminantLiterals;
  discriminantUnions: Set<string>;
  functions: Map<string, FunctionShape>;
  publicExported: Set<string>;
};

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  // computed name(`['required']`·`[7]`)은 정적 문자열·숫자 리터럴이면 그 값이 곧 필드 이름이다.
  // 동적 표현식(`[Symbol.iterator]`·`[key]`)은 이름을 정할 수 없어 제외한다.
  if (ts.isComputedPropertyName(name) && (ts.isStringLiteral(name.expression) || ts.isNumericLiteral(name.expression))) return name.expression.text;
  return undefined;
}

/** object type literal의 멤버를 낸다. 교차 타입(`Base & { … }`)은 각 구성요소를 재귀 순회해 모든
 * object literal의 멤버를 합친다. object가 하나도 없으면(순수 union·문자열·type reference) undefined 로
 * 미지원 문법임을 알린다 — 기존 비-object type alias 처리와 같은 결이다. */
function collectTypeMembers(type: ts.TypeNode | undefined): ts.TypeElement[] | undefined {
  if (!type) return undefined;
  if (ts.isTypeLiteralNode(type)) return [...type.members];
  if (ts.isParenthesizedTypeNode(type)) return collectTypeMembers(type.type);
  if (ts.isIntersectionTypeNode(type)) {
    const collected: ts.TypeElement[] = [];
    let sawObject = false;
    for (const part of type.types) {
      const partMembers = collectTypeMembers(part);
      if (partMembers) { sawObject = true; collected.push(...partMembers); }
    }
    return sawObject ? collected : undefined;
  }
  return undefined;
}

/** 직접 문자열 리터럴 union만 낸다. 괄호는 벗기고, 숫자·식별자·혼합 union은 제외한다. */
function collectStringLiteralUnion(type: ts.TypeNode | undefined): Set<string> | undefined {
  if (!type) return undefined;
  if (ts.isParenthesizedTypeNode(type)) return collectStringLiteralUnion(type.type);
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) return new Set([type.literal.text]);
  if (!ts.isUnionTypeNode(type)) return undefined;
  const literals = new Set<string>();
  for (const part of type.types) {
    const nested = collectStringLiteralUnion(part);
    if (!nested) return undefined;
    for (const literal of nested) literals.add(literal);
  }
  return literals.size > 0 ? literals : undefined;
}

/** object 타입 또는 object union의 각 갈래에서 문자열 리터럴 속성을 속성명별 존재 집합으로 모은다.
 * 단일 object·문자열 판별값 없는 object union은 빈 집합으로 표현해 base의 삭제를 비교할 수 있다. */
function collectDiscriminantLiterals(type: ts.TypeNode | undefined): Map<string, Set<string>> | undefined {
  if (!type) return undefined;
  const branches = ts.isUnionTypeNode(type) ? type.types : [type];
  const literals = new Map<string, Set<string>>();
  let sawObject = false;
  for (const branch of branches) {
    const members = collectTypeMembers(branch);
    if (!members) continue;
    sawObject = true;
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.name || !member.type) continue;
      const name = propertyName(member.name);
      if (name === undefined || !ts.isLiteralTypeNode(member.type) || !ts.isStringLiteral(member.type.literal)) continue;
      const values = literals.get(name) ?? new Set<string>();
      values.add(member.type.literal.text);
      literals.set(name, values);
    }
  }
  return sawObject ? literals : undefined;
}

function assertParsed(source: string, fileName: string): void {
  const diagnostics = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.Latest },
    fileName,
    reportDiagnostics: true,
  }).diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  if (diagnostics.length > 0) throw new Error(`TypeScript 파싱 실패: ${ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, '\n')}`);
}

function hasExportKeyword(node: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function hasDefaultKeyword(node: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

/** 괄호·as·satisfies 는 값을 바꾸지 않으므로 반복해서 벗긴 뒤 함수 여부를 본다. */
function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** `export const { foo, bar: baz, nested: { qux }, ...rest } = source` 의 실제 바인딩 이름을 재귀로 펼친다. */
function collectBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    names.push(...collectBindingNames(element.name));
  }
  return names;
}

function functionDeclKey(statement: ts.FunctionDeclaration): string | undefined {
  return statement.name?.text ?? (hasDefaultKeyword(statement) ? 'default' : undefined);
}

function functionLikeParameterCount(node: ts.Expression | ts.FunctionDeclaration | undefined): number | undefined {
  if (!node) return undefined;
  const unwrapped = ts.isFunctionDeclaration(node) ? node : unwrapExpression(node);
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped) || ts.isFunctionDeclaration(unwrapped)) return unwrapped.parameters.length;
  return undefined;
}

function recordFunctionShape(functions: Map<string, FunctionShape>, name: string, parameterCount: number): void {
  const previous = functions.get(name);
  if (!previous || parameterCount > previous.parameterCount) functions.set(name, { parameterCount });
}

function recordLocalFunctionShape(
  localFunctions: Map<string, FunctionShape>,
  name: string,
  node: ts.Expression | ts.FunctionDeclaration | undefined,
): void {
  const parameterCount = functionLikeParameterCount(node);
  if (parameterCount === undefined) return;
  recordFunctionShape(localFunctions, name, parameterCount);
}

function bindPublicFunction(
  functions: Map<string, FunctionShape>,
  publicName: string,
  localFunctions: Map<string, FunctionShape>,
  localName: string | undefined,
  node?: ts.Expression | ts.FunctionDeclaration,
): void {
  const fromNode = functionLikeParameterCount(node);
  if (fromNode !== undefined) {
    recordFunctionShape(functions, publicName, fromNode);
    return;
  }
  const resolvedNames: string[] = [];
  if (localName) resolvedNames.push(localName);
  if (node && !ts.isFunctionDeclaration(node)) {
    const unwrapped = unwrapExpression(node);
    if (ts.isIdentifier(unwrapped) && !resolvedNames.includes(unwrapped.text)) resolvedNames.push(unwrapped.text);
  }
  for (const name of resolvedNames) {
    const local = localFunctions.get(name);
    if (local) {
      recordFunctionShape(functions, publicName, local.parameterCount);
      return;
    }
  }
}

function fieldType(member: ts.PropertySignature | ts.MethodSignature, file: ts.SourceFile): string {
  const type = ts.isMethodSignature(member)
    ? ts.factory.createFunctionTypeNode(member.typeParameters, member.parameters, member.type ?? ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword))
    : member.type;
  return type && ts.isFunctionTypeNode(type)
    ? ts.createPrinter().printNode(ts.EmitHint.Unspecified, type, file)
    : type?.getText(file) ?? '';
}

/** 선언 멤버와 export 상태를 독립 수집한다. interface declaration merging은 같은 이름의 모든 멤버를 합친다. */
function exportedShapes(source: string, fileName: string): ExportShape {
  assertParsed(source, fileName);
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const declarations: DeclarationShapes = new Map();
  const exported = new Set<string>();
  const publicExported = new Set<string>();
  const literalUnions: LiteralUnions = new Map();
  const discriminantLiterals: DiscriminantLiterals = new Map();
  const discriminantUnions = new Set<string>();
  const functions = new Map<string, FunctionShape>();
  const localFunctions = new Map<string, FunctionShape>();
  const overloadKeys = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && !statement.body) {
      const key = functionDeclKey(statement);
      if (key) overloadKeys.add(key);
    }
  }
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      const typeName = statement.name.text;
      if (ts.isTypeAliasDeclaration(statement)) {
        const literals = collectStringLiteralUnion(statement.type);
        if (literals) literalUnions.set(typeName, literals);
        const discriminants = collectDiscriminantLiterals(statement.type);
        if (discriminants) discriminantLiterals.set(typeName, discriminants);
        if (ts.isUnionTypeNode(statement.type) && statement.type.types.length >= 2 && statement.type.types.every((branch) => collectTypeMembers(branch) !== undefined)) {
          discriminantUnions.add(typeName);
        }
      }
      const members = ts.isInterfaceDeclaration(statement)
        ? [...statement.members]
        : collectTypeMembers(statement.type);
      if (!members) continue;
      const fields = declarations.get(typeName) ?? new Map<string, Field>();
      for (const member of members) {
        if (!(ts.isPropertySignature(member) || ts.isMethodSignature(member)) || !member.name) continue;
        const name = propertyName(member.name);
        if (name !== undefined) {
          const optional = Boolean(member.questionToken);
          const type = fieldType(member, file);
          const previous = fields.get(name);
          if (ts.isMethodSignature(member) && previous?.method && previous.optional === optional) {
            previous.methodTypes?.push(type);
          } else {
            fields.set(name, {
              optional,
              type,
              method: ts.isMethodSignature(member),
              ...(ts.isMethodSignature(member) ? { methodTypes: [type] } : {}),
            });
          }
        }
      }
      declarations.set(typeName, fields);
    } else if (ts.isFunctionDeclaration(statement)) {
      const key = functionDeclKey(statement);
      if (!key) continue;
      // overload가 있으면 본문 없는 공개 시그니처만 비교한다. 구현 전용 매개변수는 API가 아니다.
      if (overloadKeys.has(key) && statement.body) continue;
      recordLocalFunctionShape(localFunctions, key, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) recordLocalFunctionShape(localFunctions, decl.name.text, decl.initializer);
      }
    }
  }
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      if (hasExportKeyword(statement)) {
        exported.add(statement.name.text);
        // default export의 공개 이름은 로컬 선언명이 아니라 항상 `default`다.
        publicExported.add(hasDefaultKeyword(statement) ? 'default' : statement.name.text);
      }
    } else if (ts.isFunctionDeclaration(statement)) {
      const localName = statement.name?.text;
      const key = functionDeclKey(statement);
      if (hasExportKeyword(statement)) {
        if (hasDefaultKeyword(statement)) {
          publicExported.add('default');
          if (localName) exported.add(localName);
          if (!(key && overloadKeys.has(key) && statement.body)) {
            bindPublicFunction(functions, 'default', localFunctions, localName ?? key, statement);
          }
        } else if (localName) {
          exported.add(localName);
          publicExported.add(localName);
          if (!(overloadKeys.has(localName) && statement.body)) {
            bindPublicFunction(functions, localName, localFunctions, localName, statement);
          }
        }
      }
    } else if (ts.isClassDeclaration(statement)) {
      if (hasExportKeyword(statement)) {
        if (hasDefaultKeyword(statement)) {
          publicExported.add('default');
          if (statement.name) exported.add(statement.name.text);
        } else if (statement.name) {
          exported.add(statement.name.text);
          publicExported.add(statement.name.text);
        }
      }
    } else if (ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
      if (statement.name && ts.isIdentifier(statement.name) && hasExportKeyword(statement)) {
        exported.add(statement.name.text);
        publicExported.add(statement.name.text);
      }
    } else if (ts.isVariableStatement(statement) && hasExportKeyword(statement)) {
      for (const decl of statement.declarationList.declarations) {
        for (const bindingName of collectBindingNames(decl.name)) {
          exported.add(bindingName);
          publicExported.add(bindingName);
          bindPublicFunction(
            functions,
            bindingName,
            localFunctions,
            ts.isIdentifier(decl.name) ? bindingName : undefined,
            ts.isIdentifier(decl.name) ? decl.initializer : undefined,
          );
        }
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      publicExported.add('default');
      const unwrapped = unwrapExpression(statement.expression);
      const localName = ts.isIdentifier(unwrapped) ? unwrapped.text : undefined;
      bindPublicFunction(functions, 'default', localFunctions, localName, statement.expression);
    } else if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const publicName = element.name.text;
          const localName = element.propertyName?.text ?? publicName;
          publicExported.add(publicName);
          if (!statement.moduleSpecifier) exported.add(localName);
          bindPublicFunction(functions, publicName, localFunctions, localName);
        }
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        publicExported.add(statement.exportClause.name.text);
      }
    }
  }
  for (const fields of declarations.values()) {
    for (const field of fields.values()) {
      if (field.methodTypes) field.type = [...field.methodTypes].sort().join(' & ');
    }
  }
  return { declarations, exported, literalUnions, discriminantLiterals, discriminantUnions, functions, publicExported };
}

/** Export된 interface 또는 object type alias에서 새 필수 필드만 찾는다.
 * 삭제된 동일 타입 필드는 새 필드 하나만 rename으로 상쇄한다. */
export function requiredExportFieldsAdded(baseSource: string, headSource: string, fileName = 'changed.ts'): RequiredExportField[] {
  const before = exportedShapes(baseSource, fileName);
  const after = exportedShapes(headSource, fileName);
  const added: RequiredExportField[] = [];
  for (const typeName of after.exported) {
    const nextFields = after.declarations.get(typeName);
    if (!nextFields) continue;
    // 선언이 base에 없으면 새 타입이라 기존 사용처가 없으므로 승격하지 않는다.
    // 비공개 선언의 export 전환은 declarations에 남아 있어 이후 실제 추가 멤버를 계속 비교한다.
    const previousFields = before.declarations.get(typeName);
    if (!previousFields) continue;
    const removedTypeCounts = new Map<string, number>();
    for (const [fieldName, field] of previousFields) {
      if (!nextFields.has(fieldName)) removedTypeCounts.set(field.type, (removedTypeCounts.get(field.type) ?? 0) + 1);
    }
    for (const [fieldName, field] of nextFields) {
      if (field.optional || previousFields.has(fieldName)) continue;
      const renamed = removedTypeCounts.get(field.type) ?? 0;
      if (renamed > 0) {
        removedTypeCounts.set(field.type, renamed - 1);
        continue;
      }
      added.push({ typeName, fieldName });
    }
  }
  return added.sort((left, right) => `${left.typeName}.${left.fieldName}`.localeCompare(`${right.typeName}.${right.fieldName}`));
}

/** base에 있던 exported 심볼이 head에서 사라진 경우를 낸다. 이름 변경은 이 갈래로 잡힌다. */
export function removedExportedSymbols(baseSource: string, headSource: string, fileName = 'changed.ts'): RemovedExportedSymbol[] {
  const before = exportedShapes(baseSource, fileName);
  const after = exportedShapes(headSource, fileName);
  return [...before.publicExported].filter((name) => !after.publicExported.has(name)).sort().map((name) => ({ name }));
}

/** exported 함수의 매개변수 개수가 늘어난 경우만 낸다. 본문만 바뀐 동일 시그니처는 집지 않는다. */
export function addedExportedFunctionParameters(baseSource: string, headSource: string, fileName = 'changed.ts'): AddedFunctionParameter[] {
  const before = exportedShapes(baseSource, fileName);
  const after = exportedShapes(headSource, fileName);
  const added: AddedFunctionParameter[] = [];
  for (const name of after.publicExported) {
    const previous = before.functions.get(name);
    const next = after.functions.get(name);
    if (!previous || !next) continue;
    if (!before.publicExported.has(name)) continue;
    if (next.parameterCount > previous.parameterCount) added.push({ name, from: previous.parameterCount, to: next.parameterCount });
  }
  return added.sort((left, right) => left.name.localeCompare(right.name));
}

/** Export된 직접 문자열 리터럴 union type alias에서 head에만 있는 멤버를 낸다.
 * 같은 이름이 base와 head에 모두 있어야 하고, 줄어든 멤버·이름만 바뀐 경우는 세지 않는다. */
export function exportedLiteralUnionMembersAdded(baseSource: string, headSource: string, fileName = 'changed.ts'): LiteralUnionMember[] {
  const before = exportedShapes(baseSource, fileName);
  const after = exportedShapes(headSource, fileName);
  const added: LiteralUnionMember[] = [];
  for (const typeName of after.exported) {
    const nextLiterals = after.literalUnions.get(typeName);
    const previousLiterals = before.literalUnions.get(typeName);
    if (!nextLiterals || !previousLiterals) continue;
    const newcomers = [...nextLiterals].filter((literal) => !previousLiterals.has(literal)).sort();
    const removed = [...previousLiterals].filter((literal) => !nextLiterals.has(literal)).length;
    for (const literal of newcomers.slice(removed)) added.push({ typeName, literal });
  }
  return added.sort((left, right) => `${left.typeName}.${left.literal}`.localeCompare(`${right.typeName}.${right.literal}`));
}

/** Export된 직접 문자열 리터럴 union에서 순수 삭제된 멤버를 낸다. 같은 수의 추가는 rename으로 상쇄한다. */
export function exportedLiteralUnionMembersRemoved(baseSource: string, headSource: string, fileName = 'changed.ts'): LiteralUnionMember[] {
  const before = exportedShapes(baseSource, fileName);
  const after = exportedShapes(headSource, fileName);
  const removed: LiteralUnionMember[] = [];
  for (const typeName of after.exported) {
    const previousLiterals = before.literalUnions.get(typeName);
    const nextLiterals = after.literalUnions.get(typeName);
    if (!previousLiterals || !nextLiterals) continue;
    const deletions = [...previousLiterals].filter((literal) => !nextLiterals.has(literal)).sort();
    const additions = [...nextLiterals].filter((literal) => !previousLiterals.has(literal)).length;
    for (const literal of deletions.slice(additions)) removed.push({ typeName, literal });
  }
  return removed.sort((left, right) => `${left.typeName}.${left.literal}`.localeCompare(`${right.typeName}.${right.literal}`));
}

/** Export된 object 판별 union에서 속성별 문자열 리터럴의 순수 삭제만 낸다. 같은 속성의 동수 추가는 rename으로 상쇄한다. */
export function exportedDiscriminantUnionMembersRemoved(baseSource: string, headSource: string, fileName = 'changed.ts'): LiteralUnionMember[] {
  const before = exportedShapes(baseSource, fileName);
  const after = exportedShapes(headSource, fileName);
  const removed: LiteralUnionMember[] = [];
  for (const typeName of before.exported) {
    if (!after.exported.has(typeName) || !before.discriminantUnions.has(typeName)) continue;
    const previousProperties = before.discriminantLiterals.get(typeName);
    if (!previousProperties) continue;
    const nextProperties = after.discriminantLiterals.get(typeName) ?? new Map<string, Set<string>>();
    for (const [propertyName, previousValues] of previousProperties) {
      const nextValues = nextProperties.get(propertyName) ?? new Set<string>();
      const deletions = [...previousValues].filter((literal) => !nextValues.has(literal)).sort();
      const additions = [...nextValues].filter((literal) => !previousValues.has(literal)).length;
      for (const literal of deletions.slice(additions)) removed.push({ typeName, propertyName, literal });
    }
  }
  return removed.sort((left, right) => `${left.typeName}.${left.propertyName}.${left.literal}`.localeCompare(`${right.typeName}.${right.propertyName}.${right.literal}`));
}

function isTestTypeScriptFile(file: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec|__specs__)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

/** 저장소의 비시험 TypeScript 소스를 한 번만 읽는다. */
export function repositoryTypeScriptSources(root = process.cwd()): RepositorySources {
  const files = execFileSync('git', ['ls-files', '--', '*.ts', '*.tsx', '*.mts', '*.cts'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter((file) => file && !isTestTypeScriptFile(file)).sort();
  return new Map(files.map((file) => [file, readFileSync(join(root, file), 'utf8')]));
}

/** 삭제 리터럴과 일치하는 비시험 소스의 문자열 리터럴 위치를 파일:줄로 낸다. */
export function literalUnionReferencesInSource(removals: readonly LiteralUnionRemoval[], changed: ReadonlySet<string>, sources: RepositorySources): LiteralUnionReference[] {
  const deletedByLiteral = new Map<string, LiteralUnionRemoval[]>();
  for (const removal of removals) deletedByLiteral.set(removal.literal, [...(deletedByLiteral.get(removal.literal) ?? []), removal]);
  const references: LiteralUnionReference[] = [];
  for (const [referenceFile, source] of [...sources].sort(([left], [right]) => left.localeCompare(right))) {
    if (changed.has(referenceFile) || isTestTypeScriptFile(referenceFile)) continue;
    const ast = ts.createSourceFile(referenceFile, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) {
        for (const removal of deletedByLiteral.get(node.text) ?? []) {
          references.push({ ...removal, referenceFile, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return references.sort((left, right) => `${left.file}:${left.typeName}:${left.literal}:${left.referenceFile}:${left.line}`.localeCompare(`${right.file}:${right.typeName}:${right.literal}:${right.referenceFile}:${right.line}`));
}

type GitFileReader = (ref: string, path: string) => { ok: boolean; out: string; why?: string; missing?: boolean };
type GitRunner = (command: string, args: string[], options: Parameters<typeof execFileSync>[2]) => unknown;

/** Git pathspec을 셸 문자열로 조립하지 않아 공백·특수문자·rename 전 경로도 안전하게 읽는다. */
export function readGitFile(ref: string, path: string, run: GitRunner = execFileSync): ReturnType<GitFileReader> {
  try {
    return { ok: true, out: run('git', ['show', `${ref}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) as string };
  } catch (error: unknown) {
    const e = error as { status?: number; stderr?: string };
    const why = (e.stderr ?? '').trim() || `git show 종료코드 ${String(e.status)}`;
    // git show는 객체/revision 오류와 path 부재 모두 128을 쓴다. path 부재 문면만 정상적인 새 파일로 허용한다.
    const missing = e.status === 128 && /Path ['"].+['"] does not exist in ['"]?.+['"]?|exists on disk, but not in|fatal: path .+ does not exist/i.test(why);
    return { ok: false, out: '', missing, why };
  }
};

function applyChangedPathStatus(out: string, paths: Map<string, string>): string | undefined {
  const tokens = out.split('\0');
  for (let index = 0; index < tokens.length - 1;) {
    const status = tokens[index++]!;
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[index++]; const newPath = tokens[index++];
      if (!oldPath || !newPath) return 'git rename diff 형식을 읽지 못했다';
      paths.set(newPath, paths.get(oldPath) ?? oldPath);
      paths.delete(oldPath);
    } else {
      const path = tokens[index++];
      if (!path) return 'git diff 경로를 읽지 못했다';
      if (!paths.has(path)) paths.set(path, path);
    }
  }
}

/** base→HEAD·staged·worktree 세 diff의 rename 사슬을 합쳐 현재 경로를 기준 revision 경로까지 보존한다. */
export function changedPathPairs(base: string, run: GitRunner = execFileSync): ChangedPathResult {
  try {
    const paths = new Map<string, string>();
    const commands = [
      ['diff', '--name-status', '-z', '--find-renames', `${base}...HEAD`],
      ['diff', '--name-status', '-z', '--find-renames', '--cached'],
      ['diff', '--name-status', '-z', '--find-renames'],
    ];
    for (const args of commands) {
      const failure = applyChangedPathStatus(String(run('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) ?? ''), paths);
      if (failure) return { fields: [], failure };
    }
    return { fields: [], paths };
  } catch (error: unknown) {
    const e = error as { stderr?: string; status?: number };
    return { fields: [], failure: `git 변경 경로 조회 실패: ${(e.stderr ?? '').trim() || `종료코드 ${String(e.status)}`}` };
  }
}

/** 현재 changed-file 목록을 기준 revision의 원본과 비교한다. 관측/파싱 실패는 fail-closed 결과로 보존한다. */
export function requiredExportFieldsInChanges(
  changed: ReadonlySet<string>,
  base: string,
  pathsResult: ChangedPathResult = changedPathPairs(base),
  readBase: GitFileReader = readGitFile,
  readHead = (file: string) => readFileSync(file, 'utf8'),
): RequiredExportFieldCheck {
  if (pathsResult.failure) return { fields: [], removedSymbols: [], parameterIncreases: [], failure: pathsResult.failure };
  const fields: RequiredExportField[] = [];
  const removedSymbols: RemovedExportedSymbol[] = [];
  const parameterIncreases: AddedFunctionParameter[] = [];
  for (const file of [...changed].sort()) {
    const oldPath = pathsResult.paths?.get(file) ?? file;
    const baseFile = readBase(base, oldPath);
    if (!baseFile.ok && !baseFile.missing) return { fields: [], removedSymbols: [], parameterIncreases: [], failure: `기준 revision 파일을 읽지 못했다(${oldPath}): ${baseFile.why}` };
    try {
      const baseSource = baseFile.ok ? baseFile.out : '';
      const headSource = readHead(file);
      fields.push(...requiredExportFieldsAdded(baseSource, headSource, file));
      if (baseFile.ok) {
        removedSymbols.push(...removedExportedSymbols(baseSource, headSource, file).map((symbol) => ({ ...symbol, file })));
        parameterIncreases.push(...addedExportedFunctionParameters(baseSource, headSource, file).map((increase) => ({ ...increase, file })));
      }
    } catch (error: unknown) {
      return { fields: [], removedSymbols: [], parameterIncreases: [], failure: `${file} export 타입 판정 실패: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { fields, removedSymbols, parameterIncreases };
}

/** 현재 changed-file 목록의 export 문자열 리터럴 union 멤버 증가를 관측한다.
 * 새 파일(base missing)은 비교하지 않는다. 조회·파싱 실패는 fail-closed 결과로 보존한다. */
export function exportedLiteralUnionMembersInChanges(
  changed: ReadonlySet<string>,
  base: string,
  pathsResult: ChangedPathResult = changedPathPairs(base),
  readBase: GitFileReader = readGitFile,
  readHead = (file: string) => readFileSync(file, 'utf8'),
  sources?: RepositorySources,
): LiteralUnionMemberCheck {
  if (pathsResult.failure) return { additions: [], failure: pathsResult.failure };
  const additions: LiteralUnionAddition[] = [];
  const removals: LiteralUnionRemoval[] = [];
  for (const file of [...changed].sort()) {
    const oldPath = pathsResult.paths?.get(file) ?? file;
    const baseFile = readBase(base, oldPath);
    if (!baseFile.ok && !baseFile.missing) return { additions: [], failure: `기준 revision 파일을 읽지 못했다(${oldPath}): ${baseFile.why}` };
    if (!baseFile.ok && baseFile.missing) continue;
    try {
      const headSource = readHead(file);
      additions.push(...exportedLiteralUnionMembersAdded(baseFile.out, headSource, file).map((member) => ({ ...member, file })));
      removals.push(...exportedLiteralUnionMembersRemoved(baseFile.out, headSource, file).map((member) => ({ ...member, file })));
      removals.push(...exportedDiscriminantUnionMembersRemoved(baseFile.out, headSource, file).map((member) => ({ ...member, file })));
    } catch (error: unknown) {
      return { additions: [], failure: `${file} 리터럴 union 판정 실패: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (removals.length === 0) return { additions };
  try {
    return { additions, removals: literalUnionReferencesInSource(removals, changed, sources ?? repositoryTypeScriptSources()) };
  } catch (error: unknown) {
    return { additions, failure: `저장소 리터럴 참조 탐색 실패: ${error instanceof Error ? error.message : String(error)}` };
  }
}

type ObservedExportFieldCheck = {
  fields: RequiredExportField[];
  removedSymbols?: RemovedExportedSymbol[];
  parameterIncreases?: AddedFunctionParameter[];
  failure?: string;
};

export type BaselineDiagnostics = { diagnostics: TypecheckError[] } | { unavailable: string };

/**
 * Promotion uses a merge-base worktree because only a compiler run against that exact
 * revision distinguishes current caller breakage from inherited debt. A persistent
 * src/scripts baseline would fossilize debt, and importer-test-index is intentionally
 * test-focused rather than a complete exported-symbol importer graph.
 */
/**
 * ⛔ 기준 워크트리의 «절대 경로»를 실제 트리 것으로 되돌린다.
 * 진단 «문면 안»에 rootDir 등의 절대 경로가 실린다(TS6059 가 대표적) — 그대로 두면 워크트리에서 잰
 * 기존 진단이 실제 트리 것과 «영영 다른 키»가 되어 「원래 있던 것」이 「새로 생긴 것」으로 읽힌다.
 * 📏 2026-08-28 실측: 같은 TS6059 가 워크트리에선 rootDir '/private/var/folders/…', 실제 트리에선
 *   '/Users/…/pilot/monad-agent' 로 나와 부채 1건이 FAIL 로 올라왔다.
 * macOS 의 /var → /private/var 심링크 때문에 realpath 형태도 같이 치환한다.
 */
export function rebaseWorktreePaths(diagnostics: readonly TypecheckError[], worktree: string, cwd: string): TypecheckError[] {
  // ⛔ «긴 것부터» 치환한다. /var/... 를 먼저 바꾸면 /private/var/... 안에서 접두 '/private' 만 남아
  //    '/private' + cwd 라는 «없는 경로»가 만들어진다(실측 2026-08-28: 그 상태로 부채가 계속 FAIL 이었다).
  const roots = [...new Set([worktree, (() => { try { return realpathSync(worktree); } catch { return worktree; } })()])]
    .sort((left, right) => right.length - left.length);
  const rebase = (text: string): string => roots.reduce((acc, root) => acc.split(root).join(cwd), text);
  return diagnostics.map((diagnostic) => ({ ...diagnostic, line: rebase(diagnostic.line), file: rebase(diagnostic.file) }));
}

export function readMergeBaseDiagnostics(base: string, command: string, cwd = process.cwd(), run = runTsc): BaselineDiagnostics {
  const workspace = mkdtempSync(join(tmpdir(), 'ci-typecheck-baseline-'));
  const worktree = join(workspace, 'base');
  try {
    execFileSync('git', ['worktree', 'add', '--detach', worktree, base], { cwd, stdio: 'pipe', env: gitEnv() });
    const modules = join(cwd, 'node_modules');
    if (!existsSync(modules)) return { unavailable: `기준 worktree 의존성을 재사용할 수 없다(${modules} 없음)` };
    symlinkSync(modules, join(worktree, 'node_modules'));
    const baselineExec = ((cmd: string, options?: Parameters<typeof execSync>[1]) =>
      // ⛔ maxBuffer 를 명시한다 — 기본 1MB 는 이 저장소의 전체 진단(1,300건 넘음)을 못 담아
      //    ENOBUFS 로 죽고, 그러면 「기준을 못 얻었다」로 떨어져 면제가 통째로 사라진다(실측 2026-08-28).
      execSync(cmd, { ...options, cwd: worktree, maxBuffer: 64 * 1024 * 1024, env: tscEnv() }) as string) as typeof execSync;
    const result = run(command, baselineExec);
    if (!result.ran) return { unavailable: result.why ?? '기준 worktree tsc 실행 실패' };
    return { diagnostics: rebaseWorktreePaths(parseTypecheckErrors(result.out), worktree, cwd) };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  } finally {
    try { execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd, stdio: 'pipe', env: gitEnv() }); }
    catch { /* acquisition failure is rendered by the caller */ }
    rmSync(workspace, { recursive: true, force: true });
  }
}

export type GateIo = {
  changedTsFiles: () => ChangedTsFiles | Set<string>;
  requiredExportFields: (changed: ReadonlySet<string>, base: string) => RequiredExportField[] | ObservedExportFieldCheck;
  literalUnionMembers?: (changed: ReadonlySet<string>, base: string) => LiteralUnionMember[] | LiteralUnionMemberCheck;
  readBaselineDiagnostics?: (base: string, command: string) => BaselineDiagnostics;
  runTscCmd: (cmd: string) => TscRun;
  /** Landing tree. Git, existsSync, tsc, and the test baseline are measured here — not in process.cwd(). */
  cwd?: string;
  /** Explicit base revision. Same rule as TSC_BASE_REF, without reading the process environment. */
  baseRef?: string;
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => never;
};

const OUTSIDE_CHANGED_NAME_LIMIT = 5;

/** One observational line for diagnostics dropped because their files are outside the changed set. */
export function formatOutsideChangedWarning(outsideChanged: readonly { file: string; count: number }[]): string {
  const total = outsideChanged.reduce((sum, entry) => sum + entry.count, 0);
  const fileCount = outsideChanged.length;
  const names = outsideChanged.map((entry) => entry.file);
  const shown = names.slice(0, OUTSIDE_CHANGED_NAME_LIMIT);
  const nameText = shown.length < names.length
    ? `${shown.join(', ')} (${shown.length}/${fileCount})`
    : shown.join(', ');
  return `[tsc-gate] ⚠ 변경 파일 밖 진단 ${total}건이 파일 ${fileCount}개에서 버려짐: ${nameText}`;
}

function inspectTscResult(tsc: TscRun, changed: ReadonlySet<string>, baseline: ReadonlyMap<string, number>, error: (message: string) => void, warn: (message: string) => void, wholeRepository = false, excludedPrefixes: readonly string[] = [], includedPrefixes: readonly string[] = [], promotionBaseline?: BaselineDiagnostics, excludeTests = false): boolean {
  if (!tsc.ran) {
    error(`[tsc-gate] ⛔ 실행 판정 실패 — ${tsc.why}`);
    if (tsc.out.trim()) error(tsc.out.trim().slice(0, 2000));
    error('[tsc-gate] FAIL — tsc 가 정상 실행됐음을 확인할 수 없다(통과로 읽지 않는다).');
    return false;
  }
  const diagnostics = parseTypecheckErrors(tsc.out).filter((diagnostic) =>
    !excludedPrefixes.some((prefix) => diagnostic.file.startsWith(prefix))
      && (!excludeTests || (!isTestTypeScriptFile(diagnostic.file)))
      && (includedPrefixes.length === 0 || includedPrefixes.some((prefix) => diagnostic.file.startsWith(prefix))),
  );
  const baselineDiagnostics = promotionBaseline && 'diagnostics' in promotionBaseline
    ? promotionBaseline.diagnostics.filter((diagnostic) =>
      !excludedPrefixes.some((prefix) => diagnostic.file.startsWith(prefix))
        && (!excludeTests || (!isTestTypeScriptFile(diagnostic.file)))
        && (includedPrefixes.length === 0 || includedPrefixes.some((prefix) => diagnostic.file.startsWith(prefix))),
    )
    : undefined;
  if (wholeRepository && promotionBaseline && 'unavailable' in promotionBaseline) {
    warn(`[tsc-gate] ⚠ 기준 진단을 얻지 못했다 — ${promotionBaseline.unavailable} (관측만 · 비차단; 현재 진단은 면제하지 않는다).`);
  }
  const promotionDiff = wholeRepository && baselineDiagnostics ? diffTypecheckDiagnostics(diagnostics, baselineDiagnostics) : undefined;
  const result = classifyTypecheckErrors(promotionDiff?.added ?? diagnostics, wholeRepository ? new Set((promotionDiff?.added ?? diagnostics).map((diagnostic) => diagnostic.file)) : changed, baseline);
  if (promotionDiff?.existing.length) {
    const existingByFile = new Map<string, number>();
    for (const diagnostic of promotionDiff.existing) existingByFile.set(diagnostic.file, (existingByFile.get(diagnostic.file) ?? 0) + 1);
    warn(formatOutsideChangedWarning([...existingByFile.entries()].map(([file, count]) => ({ file, count })).sort((left, right) => left.file.localeCompare(right.file))));
  }
  const touchedBaseline = Object.fromEntries([...changed].filter((file) => baseline.has(file)).map((file) => [file, baseline.get(file)]));
  debug.log('typecheck.gate', 'ratchet', {
    changedFiles: [...changed], failing: result.failing.map((entry) => entry.line), exempted: result.exempted.map((entry) => entry.line),
    outsideChanged: result.outsideChanged,
    touchedBaseline, baselineFileCount: baseline.size, baselineErrorTotal: [...baseline.values()].reduce((sum, count) => sum + count, 0),
  }, { level: result.failing.length === 0 ? 'info' : 'warn' });
  if (result.exempted.length > 0) {
    warn(`[tsc-gate] ⚠ 기존 test 타입 부채 ${result.exempted.length}건 면제 (baseline 파일 ${new Set(result.exempted.map((entry) => entry.file)).size}개):`);
    for (const entry of result.exempted) warn('  ' + entry.line);
  }
  if (result.outsideChanged.length > 0) warn(formatOutsideChangedWarning(result.outsideChanged));
  if (result.failing.length === 0) return true;
  const failureScope = wholeRepository ? '저장소 전체 범위' : '변경 파일';
  error(`\n[tsc-gate] FAIL — ${failureScope}에 타입 에러 ${result.failing.length}건:`);
  for (const entry of result.failing) error('  ' + entry.line);
  error('\n건드린 src/scripts 파일과 baseline 밖 test 파일은 tsc 클린이어야 합니다(touch-clean).');
  return false;
}

export function runGate(io: Partial<GateIo> = {}): void {
  const cwd = io.cwd ?? process.cwd();
  const defaultChanged = () => changedTsFiles((cmd) => sh(cmd, cwd), process.env, cwd, io.baseRef);
  const { changedTsFiles: getChanged = defaultChanged, runTscCmd = (cmd: string) => runTsc(cmd, ((command, options) => execSync(command, { ...options, cwd, env: gitEnv() })) as typeof execSync), log = (message: string) => console.log(message), warn = (message: string) => console.warn(message), error = (message: string) => console.error(message), exit = ((code: number) => process.exit(code)) as GateIo['exit'] } = io;
  const readBaselineDiagnostics = io.readBaselineDiagnostics ?? ((base: string, command: string) => readMergeBaseDiagnostics(base, command, cwd));
  // Set 주입은 기존 테스트 심이며 기준 revision이 없다. 실제 ChangedTsFiles 경로만 Git 관측을 요구한다.
  const requiredExportFields = io.requiredExportFields ?? ((changed: ReadonlySet<string>, base: string) => base === 'injected test seam'
    ? { fields: [], removedSymbols: [], parameterIncreases: [] }
    : requiredExportFieldsInChanges(changed, base));
  const literalUnionMembers = io.literalUnionMembers ?? ((changed: ReadonlySet<string>, base: string) => base === 'injected test seam'
    ? { additions: [] }
    : exportedLiteralUnionMembersInChanges(changed, base));
  const changedResult = getChanged();
  const { files: changed, base, baseSource, head, diffFiles, warnings = [], failures = [] } = changedResult instanceof Set
    ? { files: changedResult, base: 'injected test seam', baseSource: 'injected test seam', head: 'injected test seam', diffFiles: new Set<string>(), warnings: [], failures: [] }
    : changedResult;
  for (const message of warnings) warn(`[tsc-gate] ⚠ ${message}`);
  const diffCount = diffFiles?.size;
  const diffTsCount = diffFiles && [...diffFiles].filter((file) => /\.tsx?$/.test(file)).length;
  log(`[tsc-gate] base=${base} (${baseSource}); 변경 .ts ${changed.size}개 관측. (head=${head ?? 'unknown'} · 전체 diff 파일 ${diffCount ?? 'unknown'}개 · diff .ts ${diffTsCount ?? 'unknown'}개)`);
  if (failures.length > 0) {
    error('[tsc-gate] ⛔ 변경 파일 수집 실패:');
    for (const { command, why } of failures) error(`  ${command}: ${why}`);
    error('[tsc-gate] FAIL — "변경 파일 없음"과 "변경 파일을 수집하지 못함"은 다른 값이다(fail-closed).');
    exit(1);
    return;
  }
  if (changed.size === 0) {
    if (!(changedResult instanceof Set) && (!head || diffCount === undefined || diffTsCount === undefined || diffTsCount > 0)) {
      error(`[tsc-gate] FAIL — 변경 파일 수집 불일치: 전체 diff 파일 ${diffCount ?? 'unknown'}개 · diff .ts ${diffTsCount ?? 'unknown'}개 · 수집 .ts 0개 (못 셌음 ≠ 0).`);
      exit(1);
      return;
    }
    log(`[tsc-gate] PASS — 변경된 .ts 파일 없음 · base=${base} · head=${head} · 전체 diff 파일 ${diffCount}개 · diff .ts ${diffTsCount}개 · 수집 .ts 0개; tsc 실행 없이 통과.`);
    return;
  }
  const fieldCheck = requiredExportFields(changed, base);
  const requiredFields = Array.isArray(fieldCheck) ? fieldCheck : fieldCheck.fields;
  if (!Array.isArray(fieldCheck) && fieldCheck.failure) {
    error(`[tsc-gate] ⛔ 필수 export 필드 판정 실패 — ${fieldCheck.failure}`);
    error('[tsc-gate] FAIL — "후보 없음"과 "판정하지 못함"은 다른 값이다(fail-closed).');
    exit(1);
    return;
  }
  let removedSymbols: RemovedExportedSymbol[] = [];
  let parameterIncreases: AddedFunctionParameter[] = [];
  if (!Array.isArray(fieldCheck)) {
    if (fieldCheck.removedSymbols === undefined || fieldCheck.parameterIncreases === undefined) {
      error('[tsc-gate] ⛔ 필수 export 필드 판정 실패 — 승격 방아쇠 관측이 없다(unknown은 0건이 아니다)');
      error('[tsc-gate] FAIL — "후보 없음"과 "판정하지 못함"은 다른 값이다(fail-closed).');
      exit(1);
      return;
    }
    removedSymbols = fieldCheck.removedSymbols;
    parameterIncreases = fieldCheck.parameterIncreases;
  }
  const literalCheck = literalUnionMembers(changed, base);
  const literalAdditions = Array.isArray(literalCheck) ? literalCheck : literalCheck.additions;
  if (!Array.isArray(literalCheck) && literalCheck.failure) {
    warn(`[tsc-gate] ⚠ 리터럴 union 판정 실패 — ${literalCheck.failure} (관측만 · 비차단)`);
  }
  if (literalAdditions.length > 0) {
    warn(`[tsc-gate] ⚠ export 문자열 리터럴 union 멤버 추가 ${literalAdditions.length}건 (관측만 · 비차단):`);
    for (const addition of literalAdditions) {
      const file = 'file' in addition && typeof addition.file === 'string' ? addition.file : undefined;
      warn(`  ${file ? `${file}: ` : ''}${addition.typeName} += '${addition.literal}'`);
    }
  }
  const literalRemovals = Array.isArray(literalCheck) ? [] : literalCheck.removals ?? [];
  if (literalRemovals.length > 0) {
    warn(`[tsc-gate] ⚠ export 문자열 리터럴 union 멤버 삭제 뒤 남은 참조 ${literalRemovals.length}건 (검토할 자리 · 관측만 · 비차단):`);
    for (const removal of literalRemovals) warn(`  ${removal.referenceFile}:${removal.line}: ${removal.typeName} -= '${removal.literal}' (${removal.file})`);
  }
  const wholeRepository = requiredFields.length > 0 || removedSymbols.length > 0 || parameterIncreases.length > 0;
  const pwaChanged = new Set([...changed].filter((file) => file.startsWith('apps/pwa/')));
  const rootChanged = new Set([...changed].filter((file) => !pwaChanged.has(file)));
  // 앱 파일은 앱 설정만 소유한다. 전체 승격은 root 설정만 저장소 전체로 올리고,
  // PWA 설정은 언제나 자기 소유 범위만 판정해 진단이 중복 귀속되지 않게 한다.
  const rootScope = wholeRepository ? new Set(['**']) : rootChanged;
  const pwaScope = wholeRepository ? new Set(['apps/pwa/**']) : pwaChanged;
  const nonTestRootChanged = new Set([...rootChanged].filter((file) => !isTestTypeScriptFile(file)));
  const pwaEnvScope = wholeRepository ? new Set(['**']) : nonTestRootChanged;
  const runsPwaEnv = nonTestRootChanged.size > 0;
  if (requiredFields.length > 0) log(`[tsc-gate] 필수 export 필드 추가 감지 — 저장소 전체 검사로 승격: ${requiredFields.map(({ typeName, fieldName }) => `${typeName}.${fieldName}`).join(', ')}.`);
  if (removedSymbols.length > 0) log(`[tsc-gate] exported 심볼 사라짐 감지 — 저장소 전체 검사로 승격: ${removedSymbols.map(({ name }) => name).join(', ')}.`);
  if (parameterIncreases.length > 0) log(`[tsc-gate] exported 함수 매개변수 증가 감지 — 저장소 전체 검사로 승격: ${parameterIncreases.map(({ name, from, to }) => `${name}(${from}→${to})`).join(', ')}.`);
  if (!wholeRepository) log(`[tsc-gate] 변경 .ts ${changed.size}개 검사 (touch-clean 정책).`);
  const runsPwa = wholeRepository || pwaChanged.size > 0;
  const observedScopes = [
    { config: TYPECHECK_GATE_CONFIG, checkedFiles: [...rootScope], excludes: ['apps/pwa/**'] },
    ...(runsPwa ? [{ config: 'apps/pwa/tsconfig.json', checkedFiles: [...pwaScope], excludes: [] as string[] }] : []),
    ...(runsPwaEnv ? [{ config: 'tsconfig.pwa-env.json', checkedFiles: [...pwaEnvScope], excludes: ['apps/pwa/**', 'docs/**', '**/*.test.ts', 'test/**'] }] : []),
  ];
  const promotionTriggers = [
    ...(requiredFields.length > 0 ? ['required-export-field'] : []),
    ...(removedSymbols.length > 0 ? ['removed-exported-symbol'] : []),
    ...(parameterIncreases.length > 0 ? ['added-function-parameter'] : []),
  ];
  debug.log('typecheck.gate', 'scope', {
    changedFiles: [...changed],
    executions: observedScopes,
    promotionTriggers,
    requiredExportFieldCount: requiredFields.length,
    removedExportedSymbolCount: removedSymbols.length,
    addedFunctionParameterCount: parameterIncreases.length,
  }, { level: 'info' });
  log(`[tsc-gate] root 설정 범위 ${rootScope.size}개 관측 (apps/pwa/** 제외).`);
  if (runsPwa) log(`[tsc-gate] PWA 설정 범위 ${pwaScope.size}개 관측.`);
  const tscBin = existsSync(join(cwd, 'node_modules/.bin/tsc')) ? 'node_modules/.bin/tsc' : 'npx tsc';
  const baseline = readTestTypecheckBaseline(cwd);
  const rootCommand = `${tscBin} --noEmit -p ${TYPECHECK_GATE_CONFIG}`;
  const pwaCommand = `${tscBin} --noEmit -p apps/pwa/tsconfig.json`;
  const pwaEnvCommand = `${tscBin} --noEmit -p tsconfig.pwa-env.json`;
  const rootPromotionBaseline = wholeRepository ? readBaselineDiagnostics(base, rootCommand) : undefined;
  const pwaPromotionBaseline = wholeRepository && runsPwa ? readBaselineDiagnostics(base, pwaCommand) : undefined;
  const pwaEnvPromotionBaseline = wholeRepository && runsPwaEnv ? readBaselineDiagnostics(base, pwaEnvCommand) : undefined;
  const rootTsc = runTscCmd(rootCommand);
  let unmeasured = !rootTsc.ran;
  let passed = inspectTscResult(rootTsc, rootScope, baseline, error, warn, wholeRepository, ['apps/pwa/'], [], rootPromotionBaseline);
  if (runsPwa) {
    log(`[tsc-gate] PWA 변경 ${pwaChanged.size}개 관측 — apps/pwa/tsconfig.json 검사.`);
    const pwaTsc = runTscCmd(pwaCommand);
    unmeasured = unmeasured || !pwaTsc.ran;
    passed = inspectTscResult(pwaTsc, pwaScope, baseline, error, warn, wholeRepository, [], ['apps/pwa/'], pwaPromotionBaseline) && passed;
  }
  if (runsPwaEnv) {
    log(`[tsc-gate] PWA env 패스 — 루트 비시험 ${nonTestRootChanged.size}개 (Next ProcessEnv 선언 포함).`);
    const pwaEnvTsc = runTscCmd(pwaEnvCommand);
    unmeasured = unmeasured || !pwaEnvTsc.ran;
    passed = inspectTscResult(pwaEnvTsc, pwaEnvScope, baseline, error, warn, wholeRepository, ['apps/pwa/'], [], pwaEnvPromotionBaseline, true) && passed;
  }
  if (passed) { log('[tsc-gate] PASS — 변경 파일에 신규 타입 에러 없음.'); return; }
  // ⛔⭐⭐ T67 — ***마지막 줄은 언제나 「판정」이어야 한다.*** 사람도 도구도 마지막 줄을 읽는다.
  //   🩸 2026-09-11 실측(🅕 보고): 타입 에러 3건이 있는데 `tail -1` 이 «경고»를 집어
  //      「PASS」로 읽혔고, 시험 23개가 터진 뒤에야 드러났다. ⇒ 종료 코드는 «옳았고»
  //      깨진 것은 «가독 계약»이라 CI 는 안 놓치고 «사람만» 놓쳤다.
  //   ⛔ 판정은 `inspectTscResult` «안»에서 먼저 찍히고, 그 뒤로 면제·승격 경고가 더 찍힌다.
  //      그 순서를 뒤집으면 진단 맥락이 판정과 떨어진다 — 그래서 «옮기지 않고 다시 찍는다».
  //   ⚠️ 문면은 «범위 중립»이어야 한다 — 승격되면 범위가 「저장소 전체」다.
  //      여기서 「변경 파일에」라고 못 박으면 승격 판정을 «틀리게» 말한다(시험이 그것을 잡았다).
  // ⛔ 2026-09-23 (🅢·🅕 독립 확증) — tsc 가 «못 돌았으면»(OOM 등) 마지막 줄이 「타입 에러가 있다」면 거짓이다.
  //   「못 쟀다」를 「있다」로 읽혀 사람이 없는 에러를 찾으러 간다. 판정은 같은 FAIL(exit 1)이되 «문면»을 가른다.
  error(unmeasured
    ? '[tsc-gate] FAIL — tsc 를 «못 쟀다»(타입 에러 유무 모름 · OOM 이면 게이트가 이미 준 힙(TSC_HEAP_MB) «위로» NODE_OPTIONS=--max-old-space-size 를 올려 다시).'
    : '[tsc-gate] FAIL — 타입 에러가 있다 (범위·파일·건수는 위 [tsc-gate] FAIL 줄).');
  exit(1);
}

// ⛔⭐⭐ 이 게이트는 «인자를 받지 않는다» — 기준은 언제나 merge-base(origin/main) 다.
//   🩸 2026-09-10: 🅕 가 반증 명령으로 `--base <커밋>` 을 적었고 🅣 가 그대로 돌렸는데,
//      파싱하는 자리가 «없어서» 조용히 삼켜졌다. 산출은 「변경 .ts 0개 — 통과」였다.
//      ⇒ ***틀린 답이 아니라 «다른 질문의 맞는 답»이 나왔고, 그것이 답으로 읽힐 뻔했다.***
//   ⭐ 그래서 막는 자리는 «여기»뿐이다 — 인-프로세스 호출자(`pr-cli.ts`·`seams.ts`)는
//      argv 를 안 넘기고, 만약 여기서 `process.argv` 를 «읽으면» 형제 게이트가 경고한 그 사고가 난다
//      (`elanous pr land` 의 인자를 자기 인자로 읽는다 — `src/cli/pr-cli.ts` 의 `args: []` 주석).
if (import.meta.main) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.length > 0) {
    console.error(`[tsc-gate] ⛔ 이 게이트는 인자를 받지 않는다 — 준 인자 ${cliArgs.length}개를 «조용히 삼키지 않고» 막는다: ${cliArgs.join(' ')}`);
    console.error('[tsc-gate]   기준은 언제나 merge-base(origin/main) 다. 다른 기준으로 재려면 «그 트리에 서서» 돌려라:');
    console.error('[tsc-gate]     git worktree add --detach <경로> <커밋> && cd <경로> && bun run scripts/ci-typecheck-changed.ts');
    console.error('[tsc-gate]   ⇒ 그러면 merge-base 가 그때와 «같아진다». 이것이 재현의 유일한 길이다.');
    process.exit(2);
  }
  runGate();
}
