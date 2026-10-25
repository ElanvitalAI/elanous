import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import * as ts from 'typescript';
import { boundaryMappingHash } from './boundary-proof-mapping.js';

export type GreenCloseCommand = { ok: true; args: string[] } | { ok: false };

/** A passing test proves code behavior; these two title clauses describe the whole cell's completion. */
export function verifyGreenCloseBoundary(input: {
  title: string; evidence: string; paths: string[]; changedPaths: string[];
  cellId: string; mainSha: string; stateRoot: string; repoRoot: string; command: string;
  mapRunId?: string; cardId?: string; graphRunId?: string; proofRef?: string;
}): { outcome: 'pass' | 'hold'; reason: string; evidence: string[] } {
  const code = /^\s*-?\s*완료 경계 코드:\s*(.+)$/m.exec(input.title)?.[1]?.trim();
  const live = /^\s*-?\s*완료 경계 실물:\s*(.+)$/m.exec(input.title)?.[1]?.trim();
  if (!code || !live) return { outcome: 'hold', reason: 'boundary-unproven', evidence: ['Completion code and live boundary lines are required'] };
  const required = input.paths.filter((path) => !/\.test\.[cm]?[jt]sx?$/.test(path));
  if (!required.length || required.some((path) => !input.changedPaths.includes(path)))
    return { outcome: 'hold', reason: 'boundary-unproven', evidence: ['Candidate merge does not cover every declared production boundary path'] };
  const parsed = parseGreenCloseEvidenceCommand(input.command);
  const tests = parsed.ok ? parsed.args.filter((arg) => /\.test\.[cm]?[jt]sx?$/.test(arg)) : [];
  if (!tests.length || required.some((path) => path.startsWith('/') || path.split('/').includes('..')))
    return { outcome: 'hold', reason: 'boundary-unproven', evidence: ['Code boundary test paths are missing or invalid'] };
  try {
    for (const path of required.filter((value) => /\.[cm]?[jt]sx?$/.test(value))) {
      const covered = tests.some((testPath) => {
        const fullTestPath = resolve(input.repoRoot, testPath);
        return analyzeProductionAssertion(readFileSync(fullTestPath, 'utf8'), fullTestPath,
          [resolve(input.repoRoot, path)]).asserted;
      });
      if (!covered) throw new Error('boundary path has no commanded assertion');
    }
  } catch {
    return { outcome: 'hold', reason: 'boundary-unproven', evidence: ['Commanded tests do not assert every declared production boundary path'] };
  }
  const ref = input.proofRef;
  if (!ref || !input.graphRunId || !input.mapRunId || !input.cardId
    || ref !== `boundary-proofs/${input.cellId}/${input.graphRunId}.json`)
    return { outcome: 'hold', reason: 'boundary-unproven', evidence: ['Live boundary needs a proof produced by this graph and card'] };
  try {
    const root = realpathSync(input.stateRoot);
    const proofPath = realpathSync(resolve(root, ref));
    if (!proofPath.startsWith(root + '/')) throw new Error('proof outside state root');
    const proof = JSON.parse(readFileSync(proofPath, 'utf8')) as Record<string, unknown>;
    if (proof.schema !== 'green-close-boundary-proof/v1' || proof.cellId !== input.cellId
      || proof.mainSha !== input.mainSha || proof.liveBoundary !== live
      || proof.producer !== 'green-close-boundary-producer/v1' || proof.outcome !== 'pass'
      || proof.exitCode !== 0 || proof.runId !== input.graphRunId || proof.graphRunId !== input.graphRunId
      || proof.mapRunId !== input.mapRunId || proof.cardId !== input.cardId
      || !boundaryMappingHash(input.title) || proof.mappingHash !== boundaryMappingHash(input.title))
      throw new Error('proof identity or outcome mismatch');
    return { outcome: 'pass', reason: 'boundary-proven', evidence: [`Completion code paths and live proof ${ref} match ${input.mainSha}`] };
  } catch {
    return { outcome: 'hold', reason: 'boundary-unproven', evidence: ['Live proof missing, outside state root, or does not match this cell and main SHA'] };
  }
}

/** Parse the deliberately small evidence-command language. No shell syntax reaches a process. */
export function parseGreenCloseEvidenceCommand(command: string): GreenCloseCommand {
  if (!command || /[\r\n\u0000`$|<>;&(){}\\'"\\]/.test(command)) return { ok: false };
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== 'bun' || tokens[1] !== 'test') return { ok: false };
  const args: string[] = [];
  let paths = 0;
  for (let i = 2; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === '-t') {
      const value = tokens[++i];
      if (!value || !/^[A-Za-z0-9_.:/-]+$/.test(value)) return { ok: false };
      args.push(token, value);
      continue;
    }
    if (token === '--timeout') {
      const value = tokens[++i];
      if (!value || !/^\d+$/.test(value) || Number(value) < 1) return { ok: false };
      args.push(token, value);
      continue;
    }
    if (token.startsWith('--timeout=')) {
      const value = token.slice('--timeout='.length);
      if (!/^\d+$/.test(value) || Number(value) < 1) return { ok: false };
      args.push(token);
      continue;
    }
    if (token.startsWith('-') || token.startsWith('/') || token.split('/').some((part) => part === '..')
      || !/^[A-Za-z0-9_./-]+$/.test(token)) return { ok: false };
    paths += 1;
    args.push(token);
  }
  return paths > 0 ? { ok: true, args } : { ok: false };
}

function rootIdentifier(node: ts.Expression): string | undefined {
  let current = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : undefined;
}

function containsAny(node: ts.Node, names: Set<string>, calls: Set<ts.Node>): boolean {
  if (calls.has(node)) return true;
  if (ts.isIdentifier(node) && names.has(node.text)) return true;
  let found = false;
  ts.forEachChild(node, (child) => { if (!found && containsAny(child, names, calls)) found = true; });
  return found;
}

/** Reports whether a test calls a declared production entry and asserts on its result or a simple alias. */
export function analyzeProductionAssertion(
  source: string,
  testPath: string,
  productionPaths: readonly string[],
): { called: boolean; asserted: boolean } {
  const file = ts.createSourceFile(testPath, source, ts.ScriptTarget.Latest, true);
  const normalize = (value: string) => value.replace(/\.(?:[cm]?[jt]sx?)$/i, '');
  const declaredTargets = new Set(productionPaths.map((value) => normalize(resolve(value))));
  const imported = new Set<string>();
  const collectImports = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')) {
      const resolved = normalize(resolve(dirname(resolve(testPath)), node.moduleSpecifier.text));
      if (declaredTargets.has(resolved)) {
        const clause = node.importClause;
        if (clause?.name) imported.add(clause.name.text);
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) imported.add(clause.namedBindings.name.text);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const item of clause.namedBindings.elements) imported.add(item.name.text);
        }
      }
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(file);
  if (!imported.size) return { called: false, asserted: false };

  let called = false;
  let asserted = false;
  const inspectTest = (body: ts.Node) => {
    const walkBlock = (root: ts.Node, visitor: (node: ts.Node) => void) => {
      const walk = (node: ts.Node) => {
        if (node !== root && ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          && ['test', 'it'].includes(node.expression.text)) return;
        visitor(node);
        ts.forEachChild(node, walk);
      };
      walk(root);
    };
    const productionCalls = new Set<ts.Node>();
    const aliases = new Set<string>();
    walkBlock(body, (node) => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && imported.has(rootIdentifier(node.expression) ?? '')) {
        productionCalls.add(node);
        called = true;
      }
    });
    let addedAlias = true;
    while (addedAlias) {
      addedAlias = false;
      walkBlock(body, (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
          && !aliases.has(node.name.text) && containsAny(node.initializer, aliases, productionCalls)) {
          aliases.add(node.name.text);
          addedAlias = true;
        }
      });
    }

    const isAssertion = (node: ts.CallExpression): ts.CallExpression | undefined => {
      if (ts.isPropertyAccessExpression(node.expression) && ts.isCallExpression(node.expression.expression)
        && rootIdentifier(node.expression.expression.expression) === 'expect') return node.expression.expression;
      if (rootIdentifier(node.expression) === 'expect' || rootIdentifier(node.expression) === 'assert') return node;
      return undefined;
    };
    walkBlock(body, (node) => {
      if (ts.isCallExpression(node)) {
        const assertion = isAssertion(node);
        if (assertion && assertion.arguments.some((arg) => containsAny(arg, aliases, productionCalls))) asserted = true;
      }
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['test', 'it'].includes(node.expression.text)) {
      const callback = node.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
      if (callback) inspectTest(callback);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { called, asserted };
}

export function testAssertsProductionResult(source: string, testPath: string, productionPaths: readonly string[]): boolean {
  return analyzeProductionAssertion(source, testPath, productionPaths).asserted;
}

function makeReadOnlyTree(root: string, originalModes: Map<string, number>): void {
  originalModes.set(root, statSync(root).mode & 0o7777);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    const mode = statSync(path).mode & 0o7777;
    originalModes.set(path, mode);
    if (entry.isDirectory()) {
      makeReadOnlyTree(path, originalModes);
      chmodSync(path, mode & ~0o222);
    } else chmodSync(path, mode & ~0o222);
  }
  chmodSync(root, (originalModes.get(root) ?? 0o755) & ~0o222);
}

function restoreTreeModes(originalModes: Map<string, number>): void {
  for (const [path, mode] of [...originalModes].sort(([left], [right]) => left.length - right.length)) chmodSync(path, mode);
}

/** Run the allowlisted Bun test argv from a detached, read-only worktree and clean it up. */
export function runGreenCloseEvidenceTest(repo: string, sha: string, args: string[], timeout = 900_000) {
  const parent = mkdtempSync(join(tmpdir(), 'green-close-readonly-'));
  const tree = join(parent, 'repo');
  const originalModes = new Map<string, number>();
  let added = false;
  try {
    const add = Bun.spawnSync(['git', '-C', repo, 'worktree', 'add', '--detach', tree, sha], { stdout: 'pipe', stderr: 'pipe' });
    if (add.exitCode !== 0) return { exitCode: add.exitCode ?? 1, stdout: '', stderr: new TextDecoder().decode(add.stderr).slice(-1200), reason: 'readonly-worktree-create-failed' };
    added = true;
    const install = Bun.spawnSync(['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], {
      cwd: tree, stdout: 'pipe', stderr: 'pipe', timeout: 300_000, maxBuffer: 1_000_000,
    });
    if (install.exitCode !== 0) return { exitCode: install.exitCode ?? 1, stdout: new TextDecoder().decode(install.stdout).slice(-1200), stderr: new TextDecoder().decode(install.stderr).slice(-1200), reason: 'readonly-worktree-dependencies-unavailable' };
    makeReadOnlyTree(tree, originalModes);
    const run = Bun.spawnSync(['bun', 'test', ...args], { cwd: tree, stdout: 'pipe', stderr: 'pipe', timeout, maxBuffer: 4_000_000 });
    return { exitCode: run.exitCode ?? 1, stdout: new TextDecoder().decode(run.stdout).slice(-1200), stderr: new TextDecoder().decode(run.stderr).slice(-1200), reason: 'completion-command-' + (run.exitCode === 0 ? 'passed' : 'failed') };
  } finally {
    if (added) {
      try { restoreTreeModes(originalModes); } catch { /* worktree cleanup below reports failure if necessary */ }
      Bun.spawnSync(['git', '-C', repo, 'worktree', 'remove', '--force', tree], { stdout: 'pipe', stderr: 'pipe' });
    }
    rmSync(parent, { recursive: true, force: true });
  }
}
