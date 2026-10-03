import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path/posix';
import ts from 'typescript';
import { isTestPath } from './importer-test-index.js';

export interface RouteConsumerTestIndex {
  readonly testsBySource: ReadonlyMap<string, readonly string[]>;
  /** Base routes could not be inspected for these sources; an empty match is not evidence of no consumers. */
  readonly lookupFailures: readonly { readonly source: string; readonly reason: string }[];
}

const ROUTE_RE = /^\/(?:v\d+|api)\/[^\s]+$/;

function dynamicRoutePattern(route: string): RegExp | null {
  const segments = route.split('/').slice(1);
  if (!segments.some((segment) => segment.startsWith(':') || segment === '*')) return null;
  const pattern = segments.map((segment) => {
    if (segment === '*') return '.*';
    if (/^:[\w]+$/.test(segment)) return '[^/?#]+';
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return new RegExp(`^/${pattern}(?:[?#].*)?$`);
}

function testStringValues(text: string, path: string): string[] {
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) values.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return values;
}

/** Index paths in both the current and comparison-base server source, so removing a route still selects its consumers. */
export function buildRouteConsumerTestIndex(
  cwd: string,
  testPaths: readonly string[],
  changedSources: readonly string[],
  baseRef = 'HEAD',
  readBase: (source: string) => { text: string } | { absent: true } | { lookupFailed: string } = (source) => {
    const options = { cwd, encoding: 'utf8' as const, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 };
    const result = spawnSync('git', ['show', `${baseRef}:${source}`], options);
    if (result.status === 0 && !result.error) return { text: result.stdout };
    const tree = spawnSync('git', ['ls-tree', '--name-only', baseRef, '--', source], options);
    if (tree.status === 0 && !tree.error && !tree.stdout.trim()) return { absent: true };
    return { lookupFailed: (result.stderr || result.error?.message || tree.stderr || tree.error?.message || 'git show failed').trim() };
  },
  /** Lines added/removed in the diff for `source`; null = diff unavailable (then every route in the file counts). */
  changedLines: (source: string) => string[] | null = (source) => {
    const r = spawnSync('git', ['diff', '-U0', baseRef, '--', source], { cwd, encoding: 'utf8' as const, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
    if (r.status !== 0 || r.error) return null;
    // `git diff` omits untracked files — a new, not-yet-added server file is all new lines (every route counts).
    if (!r.stdout.trim() && spawnSync('git', ['ls-files', '--error-unmatch', '--', source], { cwd, encoding: 'utf8' as const, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }).status !== 0) return null;
    return r.stdout.split('\n').filter((line) => /^[+-](?![+-]{2})/.test(line)).map((line) => line.slice(1));
  },
): RouteConsumerTestIndex {
  const routesBySource = new Map<string, string[]>();
  const lookupFailures: { source: string; reason: string }[] = [];
  for (const source of changedSources) {
    if (!source.startsWith('src/') || isTestPath(source) || !/\.[cm]?[jt]sx?$/.test(source)) continue;
    const routes = new Set<string>();
    const collect = (text: string): void => {
      const ast = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, false);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && /^(get|post|put|patch|delete|route|register)$/.test(node.expression.name.text)) {
          const path = node.arguments[0];
          if (path && ts.isStringLiteralLike(path) && ROUTE_RE.test(path.text)) routes.add(path.text);
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
          && /(?:pathname|path)$/.test(node.left.getText(ast)) && ts.isStringLiteralLike(node.right)
          && ROUTE_RE.test(node.right.text)) routes.add(node.right.text);
        if (ts.isVariableDeclaration(node) && /(?:PATH|ROUTE)$/.test(node.name.getText(ast))
          && node.initializer && ts.isStringLiteralLike(node.initializer)
          && ROUTE_RE.test(node.initializer.text)) routes.add(node.initializer.text);
        if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression)
          && ROUTE_RE.test(node.expression.text)) routes.add(node.expression.text);
        if (ts.isPropertyAssignment(node) && /^(path|route)$/.test(node.name.getText(ast))
          && ts.isStringLiteralLike(node.initializer) && ROUTE_RE.test(node.initializer.text)) routes.add(node.initializer.text);
        ts.forEachChild(node, visit);
      };
      visit(ast);
    };
    try { collect(readFileSync(resolve(cwd, source), 'utf8')); } catch { /* Deleted source: base may still contain registered routes. */ }
    try {
      const previous = readBase(source);
      if ('text' in previous) collect(previous.text);
      else if ('lookupFailed' in previous) lookupFailures.push({ source, reason: previous.lookupFailed });
    } catch (error) {
      lookupFailures.push({ source, reason: error instanceof Error ? error.message : String(error) });
    }
    // A hub server file registers every route; only routes on lines the diff touched select consumers (TC review:
    // http-server.ts alone matched 279 tests and the cap kept the alphabetically first 30). New/deleted files keep all routes.
    const touched = changedLines(source);
    const selected = touched === null ? [...routes] : [...routes].filter((route) => touched.some((line) => line.includes(route)));
    if (selected.length) routesBySource.set(source, selected);
  }
  const testsBySource = new Map<string, string[]>();
  if (routesBySource.size === 0) return { testsBySource, lookupFailures };
  for (const test of testPaths) {
    if (!isTestPath(test)) continue;
    let text: string;
    try { text = readFileSync(resolve(cwd, test), 'utf8'); } catch { continue; } // deleted test
    const literalValues = testStringValues(text, test);
    for (const [source, routes] of routesBySource) {
      if (routes.some((route) => {
        const dynamic = dynamicRoutePattern(route);
        if (dynamic) return literalValues.some((value) => dynamic.test(value));
        let at = text.indexOf(route);
        while (at !== -1) {
          if (!/[\w/-]/.test(text[at + route.length] ?? '')) return true;
          at = text.indexOf(route, at + 1);
        }
        return false;
      })) testsBySource.set(source, [...(testsBySource.get(source) ?? []), test]);
    }
  }
  return { testsBySource, lookupFailures };
}
